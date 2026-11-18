/**
 * Relay: cross-session messaging for DeepSeek Harness.
 *
 * Host half of Switchboard. Registers the `session_*` tools that discover, read, activate,
 * message, create, fork, interrupt, rename, and archive Sessions. The browser
 * half (`client.js`) renders the paper-plane delivery effect.
 * @module dsh-switchboard
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'

/** Cordis plugin identity used by loader diagnostics. */
export const name = 'switchboard'

/** Services required by the model-facing tools. */
export const inject = ['tools', 'systemPrompt', 'sessions', 'agents']

/** Deployment-owned limits and authorization choices. */
export const Config = z.object({
  /** Maximum Sessions one `session_list` call describes. Defaults to 30. */
  maxListSessions: z.number().step(1).min(1).default(30),
  /** Maximum messages one `session_read` page returns. Defaults to 50. */
  maxReadMessages: z.number().step(1).min(1).default(50),
  /** Upper bound one `session_wait` call accepts, in milliseconds. Defaults to 120000. */
  maxWaitMs: z.number().step(1).min(1).default(120_000),
  /** Whether Sessions in another working directory may be listed, read, or messaged. Defaults to false. */
  allowCrossWorkspace: z.boolean().default(false),
  /** Whether `session_archive` may change the archived set. Defaults to false. */
  allowArchive: z.boolean().default(false),
  /** Whether `session_send` accepts `delivery: "steer"`. Defaults to true. */
  allowSteer: z.boolean().default(true),
})

/** One text block for a tool result. */
const TEXT_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Model-facing choice guidance; every tool is named by its one job. */
const PROMPT_TEXT = [
  'Use the session_* tools only when the task needs another Session.',
  'session_list finds Sessions; session_read shows the messages of one Session.',
  'session_send delivers one message to an already open Session; call session_open first for a cold Session.',
  'session_wait only waits; it never sends or reads. session_create starts a blank Session; session_fork copies history from an existing Session.',
  'A successful session_send acknowledges acceptance, not processing: read the result with session_wait or session_read.',
].join(' ')

/** Fail with a message that tells the model which tool to call next. */
function fail(message) {
  throw new Error(`relay: ${message}`)
}

/** The Agent that made the current tool call. */
function requireCaller(exec) {
  if (exec.agent === undefined) {
    fail('this tool requires an agent-bound caller; call it from a model turn')
  }
  return exec.agent
}

/** Read the caller's working directory, when the Session records one. */
function callerCwd(caller) {
  return caller.session.header.cwd
}

/** Whether the caller may address this Session under the configured policy. */
function isAuthorized(config, caller, header) {
  if (config.allowCrossWorkspace) return true
  const cwd = callerCwd(caller)
  if (cwd === undefined) return header.id === caller.id
  return header.cwd === cwd
}

/** Reject a target the caller may not address, naming the reason. */
function assertAuthorized(config, caller, header) {
  if (isAuthorized(config, caller, header)) return
  const cwd = callerCwd(caller)
  fail(
    cwd === undefined
      ? `Session "${header.id}" is outside the caller's scope; this caller records no working directory`
      : `Session "${header.id}" is in another workspace (${header.cwd ?? 'none'}); cross-workspace access is disabled`,
  )
}

/** Concatenate text blocks; non-text parts are reported by their type. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part !== null && typeof part === 'object' && part.type === 'text')
    .map(part => part.text)
    .join(' ')
    .trim()
}

/** Content part types, for a message whose text is empty. */
function partKinds(content) {
  if (!Array.isArray(content)) return undefined
  const kinds = [...new Set(content.map(part => (part === null || typeof part !== 'object' ? 'unknown' : part.type)))]
  return kinds.length === 0 ? undefined : kinds
}

/** Extract the durable title and latest user text from one event log. */
function summarizeEvents(events) {
  let title
  let lastUser = ''
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title
    } else if (event.type === 'user/message') {
      const text = contentText(event.data?.content)
      if (text.length > 0) lastUser = text
    }
  }
  return { title, lastUser }
}

/** Project user, assistant, and optional tool messages from one event log. */
function messagesFromEvents(events, includeToolResults) {
  const messages = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data?.source
      messages.push({
        seq: event.seq,
        role: 'user',
        source: typeof source?.kind === 'string' ? source.kind : 'unknown',
        ...(source?.kind === 'agent-message' ? { from_session_id: source.senderSessionId } : {}),
        text: contentText(event.data?.content),
        ...(contentText(event.data?.content).length === 0 ? { parts: partKinds(event.data?.content) } : {}),
      })
    } else if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      messages.push({
        seq: event.seq,
        role: 'assistant',
        text: contentText(content),
        ...(contentText(content).length === 0 ? { parts: partKinds(content) } : {}),
      })
    } else if (includeToolResults === true && event.type === 'tool/result') {
      const content = event.data?.message?.content
      messages.push({
        seq: event.seq,
        role: 'tool',
        tool: event.data?.message?.toolCallId,
        is_error: event.data?.message?.isError === true,
        text: contentText(content).slice(0, 2000),
      })
    }
  }
  return messages
}

/** Latest completed-turn prefix, matching the Session controller's fork default. */
function latestCompletedBoundary(events) {
  let lastTurnEnd
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/end') {
      lastTurnEnd = events[index]
      break
    }
  }
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** Live Agent for one Session, when this process hosts it. */
function liveAgent(ctx, sessionId) {
  return ctx.agents.get(sessionId)
}

/** Read one Session header without activating a cold Session. */
async function loadHeader(ctx, sessionId, signal) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live.header
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    try {
      return (await query.readSession(sessionId)).session
    } catch (error) {
      // Fall through to the raw store: the query's not-found and format failures both mean this header is unreadable here.
      void error
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    const snapshot = await persistence.stat(sessionId)
    if (snapshot !== undefined) return snapshot.header
  }
  fail(`Session "${sessionId}" was not found; call session_list to find valid ids`)
}

/** Read one complete event log, live or cold. */
async function loadEvents(ctx, sessionId, signal) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return { header: live.header, events: live.snapshotEvents() }
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    const snapshot = await query.readSession(sessionId)
    return { header: snapshot.session, events: snapshot.events }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    const header = (await persistence.stat(sessionId))?.header
    if (header !== undefined) {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const read = await handle.read()
        return { header, events: read.events }
      } finally {
        await handle.close()
      }
    }
  }
  fail(`Session "${sessionId}" was not found; call session_list to find valid ids`)
}

/** List every stored or live Session, without opening cold bodies. */
async function loadRecords(ctx, signal) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    const records = await query.listSessions(signal)
    return records.map(record => ({ header: record.header, live: record.live }))
  }
  const byId = new Map()
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    for (const snapshot of await persistence.list()) {
      byId.set(snapshot.header.id, { header: snapshot.header, live: false })
    }
  }
  for (const session of ctx.sessions.list()) {
    byId.set(session.id, { header: session.header, live: true })
  }
  return [...byId.values()]
}

/** Resolve Loader defaults explicitly so the tool code never re-defaults. */
function resolveConfig(config) {
  return {
    maxListSessions: config.maxListSessions ?? 30,
    maxReadMessages: config.maxReadMessages ?? 50,
    maxWaitMs: config.maxWaitMs ?? 120_000,
    allowCrossWorkspace: config.allowCrossWorkspace ?? false,
    allowArchive: config.allowArchive ?? false,
    allowSteer: config.allowSteer ?? true,
  }
}

/** Build the durable user message one Session sends to another. */
function dispatchMessage(caller, text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: caller.id,
    },
  })
}

/** Register the relay tools and their shared model guidance. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  /** Agent handles this plugin opened and must release on unload. */
  const owned = new Set()
  /** Accepted sends keyed by caller and request id, for idempotent retries. */
  const receipts = new Map()

  ctx.effect(() => () => {
    for (const handle of owned) {
      owned.delete(handle)
      void Promise.resolve(handle.dispose()).catch(() => {
        // A failed teardown must not block plugin unload; the owner disposes independently.
      })
    }
    receipts.clear()
  })

  ctx.systemPrompt.section({
    name: 'tool:relay',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 1,
    text: PROMPT_TEXT,
  })

  /** Track one owned Agent handle for plugin-lifetime teardown. */
  const track = (handle) => {
    owned.add(handle)
    return handle
  }

  /** Default model route for a Session this plugin creates. */
  const agentOptions = () => {
    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined) return undefined
    return {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
  }

  ctx.tools.register(defineTool({
    name: 'session_list',
    description: 'List Sessions the caller may address, with title, working directory, status, and the latest user message. Use it first to find a target id. It does not return message bodies.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive text filter over title and latest user message.' },
      cwd: { type: 'string', description: 'Exact working directory filter.' },
      status: { type: 'string', enum: ['running', 'idle', 'cold'], description: 'Resident state filter.' },
      include_subagents: { type: 'boolean', description: 'Include Sessions created as subagent children. Defaults to false.' },
      limit: { type: 'integer', description: 'Maximum rows to return, 1-100. Defaults to 20.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const records = await loadRecords(ctx, exec.signal)
      const limit = Math.min(args.limit ?? 20, 100)
      const answer = []
      let considered = 0
      for (const record of records) {
        if (record.header.id === caller.id) continue
        if (record.header.origin === 'subagent' && args.include_subagents !== true) continue
        if (args.cwd !== undefined && record.header.cwd !== args.cwd) continue
        if (!isAuthorized(resolved, caller, record.header)) continue
        const status = liveAgent(ctx, record.header.id)?.status ?? 'cold'
        if (args.status !== undefined && status !== args.status) continue
        if (considered >= resolved.maxListSessions) break
        considered += 1
        let summary = { title: undefined, lastUser: '' }
        try {
          summary = summarizeEvents((await loadEvents(ctx, record.header.id, exec.signal)).events)
        } catch (error) {
          // A row another process is writing may be unreadable now; the list still names it by id and status.
          void error
        }
        const filter = args.query?.toLowerCase()
        if (filter !== undefined
          && !(summary.title ?? '').toLowerCase().includes(filter)
          && !summary.lastUser.toLowerCase().includes(filter)) continue
        answer.push({
          session_id: record.header.id,
          title: summary.title ?? null,
          cwd: record.header.cwd ?? null,
          status,
          live: record.live,
          origin: record.header.origin ?? 'session',
          created_at: new Date(record.header.createdAt).toISOString(),
          last_user_message: summary.lastUser.slice(0, 200),
        })
        if (answer.length >= limit) break
      }
      return {
        caller_session_id: caller.id,
        sessions: answer,
        returned: answer.length,
        ...(answer.length === 0
          ? { hint: 'No authorized Sessions matched. Other workspaces require allowCrossWorkspace, and the caller Session itself is excluded.' }
          : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_read',
    description: 'Read the conversation messages of one Session, oldest to newest, as a page. Use before_seq to load older messages. It reads no other Session and never writes.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id from session_list.' },
      limit: { type: 'integer', description: 'Maximum messages in this page, 1-200. Defaults to 50.' },
      before_seq: { type: 'integer', description: 'Return messages with seq lower than this value (older page).' },
      include_tool_results: { type: 'boolean', description: 'Include tool result messages. Defaults to false.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const { header, events } = await loadEvents(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const all = messagesFromEvents(events, args.include_tool_results === true)
      const limit = Math.min(args.limit ?? resolved.maxReadMessages, 200)
      const end = args.before_seq === undefined
        ? all.length
        : all.findIndex(message => message.seq >= args.before_seq)
      const boundedEnd = end === -1 ? all.length : end
      const start = Math.max(0, boundedEnd - limit)
      const page = all.slice(start, boundedEnd)
      const summary = summarizeEvents(events)
      return {
        session_id: args.session_id,
        title: summary.title ?? null,
        messages: page,
        returned: page.length,
        total_messages: all.length,
        has_more: start > 0,
        ...(start > 0 ? { next_before_seq: page[0]?.seq } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_open',
    description: 'Make a cold Session resident so it can receive a message, or report the state of one already resident. It sends nothing and waits for nothing.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id from session_list.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const header = await loadHeader(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const existing = liveAgent(ctx, args.session_id)
      if (existing !== undefined) {
        return { session_id: args.session_id, status: existing.status, opened: false }
      }
      const handle = track(await ctx.agents.resume({ resumeSessionId: args.session_id, signal: exec.signal }))
      return { session_id: args.session_id, status: handle.agent.status, opened: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_send',
    description: 'Deliver one text message to an already resident Session. Call session_open first for a cold Session. Accepted delivery does not mean the target processed it; use session_wait or session_read for the result. This tool never sends to the caller Session.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id from session_list.' },
      content: { type: 'string', required: true, description: 'Message text to deliver.' },
      delivery: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) starts the next turn; steer targets the nearest step of a running turn.' },
      request_id: { type: 'string', description: 'Client-generated idempotency key. A repeated id returns the first receipt instead of sending again.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        relay: 'send',
        from_session_id: value.from_session_id,
        target_session_id: value.session_id,
        message_id: value.message_id,
      }),
    },
    timeoutMs: 15_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      if (args.session_id === caller.id) {
        fail('cannot send to the caller Session; answer in the current conversation instead')
      }
      const header = await loadHeader(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const target = liveAgent(ctx, args.session_id)
      if (target === undefined) {
        fail(`Session "${args.session_id}" is cold; call session_open first, or session_fork to branch from it`)
      }
      const delivery = args.delivery ?? 'queue'
      if (delivery === 'steer' && !resolved.allowSteer) {
        fail('steer delivery is disabled; use delivery "queue"')
      }
      if (delivery === 'steer' && target.status !== 'running') {
        fail(`Session "${args.session_id}" is idle; steer needs a running target, use delivery "queue"`)
      }
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        fail('content must include non-whitespace text')
      }
      const key = args.request_id === undefined ? undefined : `${caller.id}:${args.request_id}`
      if (key !== undefined && receipts.has(key)) return receipts.get(key)
      const message = dispatchMessage(caller, args.content)
      if (delivery === 'steer') target.steer(message)
      else target.followup(message)
      const receipt = {
        from_session_id: caller.id,
        session_id: args.session_id,
        message_id: message.id,
        delivery,
        accepted: true,
        target_status: target.status,
      }
      if (key !== undefined) {
        receipts.set(key, receipt)
        if (receipts.size > 1000) receipts.delete(receipts.keys().next().value)
      }
      return receipt
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_wait',
    description: 'Wait until one resident Session becomes idle, or until the timeout. It never sends, reads, or changes the target. Use it after session_send when you need the target to finish before acting.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id from session_list.' },
      timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds. Defaults to 30000; bounded by maxWaitMs.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.maxWaitMs + 10_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const header = await loadHeader(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const target = liveAgent(ctx, args.session_id)
      if (target === undefined) {
        fail(`Session "${args.session_id}" is cold; call session_open before waiting`)
      }
      const startedAt = Date.now()
      const timeoutMs = Math.min(args.timeout_ms ?? 30_000, resolved.maxWaitMs)
      if (target.status === 'idle') {
        return { session_id: args.session_id, status: 'idle', waited_ms: 0, timed_out: false }
      }
      let timedOut = false
      await new Promise((resolve) => {
        let stop = () => {}
        let timer
        function finish() {
          clearTimeout(timer)
          stop()
          exec.signal?.removeEventListener('abort', finish)
          resolve()
        }
        timer = setTimeout(() => {
          timedOut = true
          finish()
        }, timeoutMs)
        stop = ctx.on('agent/status', (payload) => {
          if (payload.agent.id === args.session_id && payload.status === 'idle') finish()
        })
        exec.signal?.addEventListener('abort', finish, { once: true })
      })
      return {
        session_id: args.session_id,
        status: target.status,
        waited_ms: Date.now() - startedAt,
        timed_out: timedOut,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_create',
    description: 'Create a new blank Session, optionally with a first prompt. Use session_fork instead when existing history must be carried over. It names no source Session.',
    parameters: {
      initial_prompt: { type: 'string', description: 'Optional first user message to run immediately after creation.' },
      cwd: { type: 'string', description: 'Working directory. Defaults to the caller Session working directory.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const cwd = args.cwd ?? callerCwd(caller)
      const sessionId = `session-${randomUUID()}`
      const handle = track(await ctx.agents.create({
        sessionId,
        ...(cwd === undefined ? {} : { meta: { cwd } }),
        agentOptions: agentOptions(),
        signal: exec.signal,
      }))
      if (typeof args.initial_prompt === 'string' && args.initial_prompt.trim().length > 0) {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: args.initial_prompt }],
          source: { kind: 'user' },
        }))
      }
      return {
        session_id: sessionId,
        status: handle.agent.status,
        cwd: cwd ?? null,
        created: true,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_fork',
    description: 'Create a new Session from an exact prefix of an existing Session, so the branch continues that history. Use session_create instead for a blank Session. The default boundary is the latest completed turn.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Source Session id.' },
      at_seq: { type: 'integer', description: 'Inclusive source event seq to inherit through. Omit for the latest completed turn.' },
      initial_prompt: { type: 'string', description: 'Optional first user message to run in the new branch.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const source = await loadEvents(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, source.header)
      const boundary = args.at_seq ?? latestCompletedBoundary(source.events)
      if (boundary === undefined) {
        fail(`Session "${args.session_id}" has no completed turn to fork from`)
      }
      if (source.events[boundary]?.seq !== boundary) {
        fail(`event ${boundary} does not exist in Session "${args.session_id}"`)
      }
      const seed = buildForkSeed(source.events, boundary)
      const childId = `session-${randomUUID()}`
      const handle = track(await ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: boundary + 1,
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          isSeeded: true,
        },
        agentOptions: agentOptions(),
        signal: exec.signal,
      }))
      if (typeof args.initial_prompt === 'string' && args.initial_prompt.trim().length > 0) {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: args.initial_prompt }],
          source: { kind: 'user' },
        }))
      }
      return {
        session_id: childId,
        source_session_id: args.session_id,
        boundary_seq: boundary,
        status: handle.agent.status,
        created: true,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_interrupt',
    description: 'Stop the current turn of the target Session. An idle target is a no-op and is reported as not interrupted. It does not close the Session or delete messages.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id from session_list.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 15_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const header = await loadHeader(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const target = liveAgent(ctx, args.session_id)
      if (target === undefined) {
        fail(`Session "${args.session_id}" is cold and has nothing to interrupt`)
      }
      if (target.status !== 'running') {
        return { session_id: args.session_id, interrupted: false, status: target.status }
      }
      target.cancel({ kind: 'user' }, { keepInbox: true })
      return { session_id: args.session_id, interrupted: true, status: target.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_rename',
    description: 'Set the title of one Session. It changes only the title, never messages or state. A cold target is opened first.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id.' },
      title: { type: 'string', required: true, description: 'New non-empty title.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    execute: async (args, exec) => {
      const caller = requireCaller(exec)
      const header = await loadHeader(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) {
        fail('renaming is unavailable: this deployment mounts no session-title service')
      }
      let target = liveAgent(ctx, args.session_id)
      if (target === undefined) {
        target = track(await ctx.agents.resume({ resumeSessionId: args.session_id, signal: exec.signal })).agent
      }
      const accepted = titles.rename(target.session, args.title)
      return { session_id: args.session_id, title: accepted.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_archive',
    description: 'Add one Session to, or remove it from, the archived set. Archived Sessions leave the normal sidebar list. It never deletes the log.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id.' },
      archived: { type: 'boolean', required: true, description: 'true archives the Session; false restores it.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    execute: async (args, exec) => {
      if (!resolved.allowArchive) {
        fail('archiving is disabled; set allowArchive: true in the relay plugin config to enable it')
      }
      const caller = requireCaller(exec)
      const header = await loadHeader(ctx, args.session_id, exec.signal)
      assertAuthorized(resolved, caller, header)
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) {
        fail('archiving is unavailable: this deployment mounts no workspace registry')
      }
      if (args.archived === true) await registry.archiveSession(args.session_id)
      else await registry.unarchiveSession(args.session_id)
      return { session_id: args.session_id, archived: args.archived === true }
    },
  }))
}

/**
 * 虹云通本地消息的工具族。全部只读：插件没有注册任何写入口。
 *
 * 五个工具按「先看有哪些账号 → 看有哪些会话 → 查具体消息」的顺序使用；
 * `hyt_search` 是跨会话正文检索，`hyt_stats` 给聚合口径。
 * @module hyt-im/tools
 */

import { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import { createCursor } from './cursor.js'
import { renderMessages } from './render.js'
import * as Messages from './messages.js'
import * as Store from './store.js'

/** 时间参数说明，多个工具共用一份措辞。 */
const TIME_HINT = '时间下界/上界，接受毫秒时间戳或 `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS`（本地时区）。只给日期时下界取 00:00:00、上界取 23:59:59。'

/** 单条消息的输出结构。 */
const messageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    msgId: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    sessionType: { type: 'string', required: true, enum: ['single', 'group'] },
    direction: { type: 'string', required: true, enum: ['in', 'out'] },
    sender: { type: 'string', required: true },
    receiver: { type: 'string', required: true },
    peer: { type: 'string', required: true },
    peerNick: { type: 'string', required: true },
    msgType: { type: 'integer', required: true },
    msgTypeName: { type: 'string', required: true },
    content: { type: 'string', required: true },
    contentTruncated: { type: 'boolean', required: true },
    timeMs: { type: 'integer', required: true },
    time: { type: 'string', required: true },
    timeIso: { type: 'string', required: true },
    isSuccess: { type: 'integer', required: true },
    readStatus: { type: 'integer', required: true },
    replyFlag: { type: 'integer', required: true },
    fileName: { type: 'string', required: true },
    fileSize: { type: 'string', required: true },
    fileUrl: { type: 'string', required: true },
    webTitle: { type: 'string', required: true },
    webDesc: { type: 'string', required: true },
    webUrl: { type: 'string', required: true },
  },
}

/**
 * 把消息列表渲染成紧凑文本的实现在 `src/render.js`：那边不依赖 harness，能脱离运行时单测。
 */

/** 消息类工具的统一返回包装。 */
function messagePayload(result, account, self) {
  return {
    account: account.account,
    self,
    messages: result.messages,
    count: result.count,
    hasMore: result.hasMore,
    oldestId: result.oldestId,
    newestId: result.newestId,
    ...(result.keyword === undefined ? {} : { keyword: result.keyword }),
  }
}

/** 消息类工具的统一输出定义。 */
function messageOutput(keywordField) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: { type: 'string', required: true },
        self: { type: 'string', required: true },
        messages: { type: 'array', required: true, items: messageSchema },
        count: { type: 'integer', required: true },
        hasMore: { type: 'boolean', required: true },
        oldestId: { type: 'integer', required: true },
        newestId: { type: 'integer', required: true },
        ...(keywordField ? { keyword: { type: 'string', required: true } } : {}),
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderMessages(value) }],
  }
}

/**
 * 注册全部工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 校验后的插件配置。
 */
export function register(ctx, config) {
  /** 增量游标，`hyt_new` 用。归属本 fiber：重载插件就重新立基线。 */
  const cursor = createCursor()

  /**
   * 在选定账号库上跑一次只读查询，统一处理「库不可用」这类环境错误。
   * @template T
   * @param {(db: import('node:sqlite').DatabaseSync, account: object, self: string, contacts: Map<string,string>) => T} fn
   * @returns {T}
   */
  const run = fn => Store.withAccountDb(config, (db, account) => {
    const self = account.account
    // 账号昵称来自通讯录，群名来自消息库的 keepgroup：群号不在 Person 表里，两张表
    // 合成一张显示名表用，键空间（cs… 与 g8…）不冲突。
    const names = new Map([...Store.loadContacts(config, account), ...Store.loadGroupNames(config, account)])
    return fn(db, account, self, names)
  })

  ctx.tools.register(defineTool({
    name: 'hyt_accounts',
    description: '列出本机 CHFile 下发现的虹云通账号库：账号名、消息库路径、大小、最后写入时间，以及当前生效的是哪一个。用来确认插件读的是哪个账号的数据。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dataDir: { type: 'string', required: true },
          selected: { type: 'string', required: true },
          accounts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                account: { type: 'string', required: true },
                dbPath: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                mtime: { type: 'string', required: true },
                selected: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `扫描目录：${value.dataDir}`,
          `当前生效：${value.selected || '（无）'}`,
          ...value.accounts.map(a => `${a.selected ? '*' : ' '} ${a.account}  ${(a.bytes / 1048576).toFixed(1)} MB  最后写入 ${a.mtime}`),
        ].join('\n'),
      }],
    },
    execute: async () => {
      const dataDir = Store.expandHome(config.dataDir)
      const accounts = Store.findAccounts(dataDir)
      if (accounts.length === 0) {
        return { dataDir, selected: '', accounts: [] }
      }
      const wanted = (config.account || '').trim()
      const selected = wanted
        ? (accounts.find(a => a.account === wanted)?.account ?? '')
        : accounts[0].account
      return {
        dataDir,
        selected,
        accounts: accounts.map(a => ({
          account: a.account,
          dbPath: a.dbPath,
          bytes: a.bytes,
          mtime: new Date(a.mtimeMs).toISOString().replace('T', ' ').slice(0, 19),
          selected: a.account === selected,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hyt_sessions',
    description: '列出虹云通会话，按最后一条消息时间倒序。给出会话 ID、单聊/群聊、对方账号与昵称、总条数、收发条数、最后消息时间与预览。要找某个人的会话或看最近有哪些活跃对话时用这个。',
    parameters: {
      limit: { type: 'integer', description: '返回会话数上限，默认取插件配置（一般 50）。' },
      from: { type: 'string', description: `只统计这个时间之后的消息。${TIME_HINT}` },
      includePreview: { type: 'boolean', description: '是否带最后一条消息的预览正文，默认 true。关掉更快。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', required: true },
          self: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                sessionType: { type: 'string', required: true, enum: ['single', 'group'] },
                peer: { type: 'string', required: true },
                peerNick: { type: 'string', required: true },
                total: { type: 'integer', required: true },
                sent: { type: 'integer', required: true },
                received: { type: 'integer', required: true },
                lastId: { type: 'integer', required: true },
                lastTimeMs: { type: 'integer', required: true },
                lastTime: { type: 'string', required: true },
                lastMsgType: { type: 'string', required: true },
                lastDirection: { type: 'string', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `账号 ${value.account}｜${value.count} 个会话`,
          ...value.sessions.map(s => `${s.lastTime || '(无时间)'}  ${s.sessionType === 'group' ? '[群]' : '    '} `
            + `${s.peerNick}(${s.sessionId})  共${s.total}/发${s.sent}/收${s.received}`
            + `${s.preview ? `  最后(${s.lastMsgType}): ${s.preview.replaceAll('\n', ' ')}` : ''}`),
        ].join('\n'),
      }],
    },
    execute: async (args) => run((db, account, self, contacts) => {
      const sessions = Messages.listSessions(db, self, {
        limit: args.limit ?? config.maxRows,
        from: args.from,
        includePreview: args.includePreview ?? true,
      }, Math.min(config.contentLimit || 200, 200), contacts)
      return { account: account.account, self, count: sessions.length, sessions }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'hyt_messages',
    description: '查虹云通本地消息库里的消息，支持按会话、对方账号、时间区间、收发方向、消息类型过滤，默认按 Id 倒序返回最新的。增量拉取用 afterId + order=asc。只读，不会改动客户端数据。',
    parameters: {
      session: { type: 'string', description: '会话 ID：单聊是对方账号（cs…），群聊是群号（g8…）。' },
      exclude: { type: 'array', items: { type: 'string' }, description: '按会话 ID 排除，用于剔掉通知号 `hyt_kfpt_16823633` 这类高噪声会话。' },
      peer: { type: 'string', description: '按对方账号过滤，单聊里对方可能是发送方也可能是接收方，两边都匹配。' },
      from: { type: 'string', description: `时间下界。${TIME_HINT}` },
      to: { type: 'string', description: `时间上界。${TIME_HINT}` },
      direction: { type: 'string', enum: ['in', 'out'], description: 'in=只看收到的，out=只看本人发出的，省略为全部。' },
      msgType: { type: 'integer', description: '消息类型码：1 文本、4 图片、6/7 文件、11 群@、25 撤回、26 命令、150 服务号卡片。' },
      keyword: { type: 'string', description: '正文子串匹配（like %…%）。跨会话全文检索建议用 hyt_search。' },
      afterId: { type: 'integer', description: '只返回 Id 大于这个值的消息，用于增量拉取新消息。' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'asc 按 Id 升序（配合 afterId 增量拉取），desc 取最新的。默认 desc。' },
      limit: { type: 'integer', description: '返回条数上限，默认取插件配置。' },
    },
    output: messageOutput(false),
    execute: async (args) => {
      if (args.limit !== undefined && args.limit < 1) throw new ToolArgsError(['limit 必须大于 0'])
      return run((db, account, self, contacts) => messagePayload(Messages.queryMessages(db, self, {
        session: args.session,
        exclude: args.exclude,
        peer: args.peer,
        from: args.from,
        to: args.to,
        direction: args.direction,
        msgType: args.msgType,
        keyword: args.keyword,
        afterId: args.afterId,
        order: args.order,
        limit: Math.min(args.limit ?? config.maxRows, config.maxRows),
      }, config.contentLimit, contacts), account, self))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hyt_search',
    description: '在虹云通本地消息库里跨会话检索正文，可叠加时间区间、方向与会话过滤。关键词是子串匹配，不是分词检索。',
    parameters: {
      keyword: { type: 'string', required: true, description: '要检索的正文子串。' },
      from: { type: 'string', description: `时间下界。${TIME_HINT}` },
      to: { type: 'string', description: `时间上界。${TIME_HINT}` },
      direction: { type: 'string', enum: ['in', 'out'], description: '限定收发方向。' },
      session: { type: 'string', description: '限定单个会话。' },
      exclude: { type: 'array', items: { type: 'string' }, description: '按会话 ID 排除，用于把通知号从检索结果里剔掉。' },
      limit: { type: 'integer', description: '返回条数上限，默认取插件配置。' },
    },
    output: messageOutput(true),
    execute: async (args) => {
      const keyword = String(args.keyword ?? '').trim()
      if (!keyword) throw new ToolArgsError(['keyword 不能为空'])
      return run((db, account, self, contacts) => messagePayload(Messages.searchMessages(db, self, {
        keyword,
        from: args.from,
        to: args.to,
        direction: args.direction,
        session: args.session,
        exclude: args.exclude,
        limit: Math.min(args.limit ?? config.maxRows, config.maxRows),
      }, config.contentLimit, contacts), account, self))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hyt_stats',
    description: '虹云通消息统计：总量与收发比、时间跨度、按消息类型分布、最近 31 天按天收发量、最活跃会话。可限定时间区间。',
    parameters: {
      from: { type: 'string', description: `时间下界。${TIME_HINT}` },
      to: { type: 'string', description: `时间上界。${TIME_HINT}` },
      topPeers: { type: 'integer', description: '最活跃会话返回条数，默认 10。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', required: true },
          self: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          sent: { type: 'integer', required: true },
          received: { type: 'integer', required: true },
          firstTime: { type: 'string', required: true },
          lastTime: { type: 'string', required: true },
          byType: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                msgType: { type: 'integer', required: true },
                msgTypeName: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
          byDay: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                day: { type: 'string', required: true },
                count: { type: 'integer', required: true },
                sent: { type: 'integer', required: true },
              },
            },
          },
          topSessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `账号 ${value.account}｜共 ${value.total} 条（发 ${value.sent} / 收 ${value.received}）`,
          `时间跨度：${value.firstTime || '?'} ~ ${value.lastTime || '?'}`,
          '按类型：' + value.byType.map(t => `${t.msgTypeName} ${t.count}`).join('，'),
          '最活跃会话：' + value.topSessions.map(s => `${s.sessionId}(${s.count})`).join('，'),
          '最近按天：' + value.byDay.slice(0, 10).map(d => `${d.day}:${d.count}`).join(' '),
        ].join('\n'),
      }],
    },
    execute: async (args) => run((db, account, self) => ({
      account: account.account,
      self,
      ...Messages.stats(db, self, { from: args.from, to: args.to, topPeers: args.topPeers }),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'hyt_overview',
    description: '虹云通消息库概况与增量游标：总行数、Id 最小/最大值、会话数。要做新消息轮询时，先取 maxId 当起点，之后用 hyt_messages 的 afterId 拉增量。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', required: true },
          dbPath: { type: 'string', required: true },
          rows: { type: 'integer', required: true },
          maxId: { type: 'integer', required: true },
          minId: { type: 'integer', required: true },
          sessions: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.account}｜${value.rows} 行，Id ${value.minId}~${value.maxId}，${value.sessions} 个会话\n${value.dbPath}`,
      }],
    },
    execute: async () => run((db, account) => ({
      account: account.account,
      dbPath: account.dbPath,
      ...Messages.overview(db),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'hyt_new',
    description: '取上次调用之后新到达的消息，并把插件内的增量游标推进到这批的最后一条。第一次调用只以当前库水位立基线、返回空，之后就是「盯接下来来的」。游标不持久化，进程重启后回到未初始化：用 set 显式接续位置，用 reset 丢弃积压，用 peek 只看不动游标。',
    parameters: {
      limit: { type: 'integer', description: '本次最多取多少条，默认取插件配置。积压超过它时 hasMore 为真，再调一次接着拿。' },
      session: { type: 'string', description: '只看某一个会话的增量。' },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: '按会话 ID 排除。通知号 hyt_kfpt_16823633 一个会话就占全库三分之一，盯真人对话时通常排掉。',
      },
      peek: { type: 'boolean', description: '只看不推进游标，默认 false。' },
      set: { type: 'integer', description: '把游标显式设到这个 Id 再取增量：用于重启后接续上次读到的位置，或回看重读。' },
      reset: { type: 'boolean', description: '把游标重置到当前库水位并返回空，丢弃积压。与 set 互斥。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', required: true },
          self: { type: 'string', required: true },
          cursorBefore: { type: 'integer', required: true },
          cursorAfter: { type: 'integer', required: true },
          firstRun: { type: 'boolean', required: true },
          messages: { type: 'array', required: true, items: messageSchema },
          count: { type: 'integer', required: true },
          hasMore: { type: 'boolean', required: true },
          oldestId: { type: 'integer', required: true },
          newestId: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.firstRun
          ? `${value.account}｜首次调用：游标基线设在 Id ${value.cursorAfter}，之后的调用返回这个位置之后到达的消息`
          : renderMessages(value),
      }],
    },
    execute: async (args) => {
      if (args.limit !== undefined && args.limit < 1) throw new ToolArgsError(['limit 必须大于 0'])
      if (args.set !== undefined && args.reset) throw new ToolArgsError(['set 和 reset 不能同时给'])
      if (args.set !== undefined && (!Number.isFinite(Number(args.set)) || Number(args.set) < 0)) {
        throw new ToolArgsError(['set 必须是非负整数 Id'])
      }
      return run((db, account, self, names) => {
        const maxId = Messages.overview(db).maxId
        if (args.set !== undefined) cursor.set(args.set)
        if (args.reset) cursor.set(maxId)
        const firstRun = cursor.init(maxId)
        const cursorBefore = cursor.value
        const res = Messages.queryMessages(db, self, {
          afterId: cursorBefore,
          order: 'asc',
          session: args.session,
          exclude: args.exclude,
          limit: Math.min(args.limit ?? config.maxRows, config.maxRows),
        }, config.contentLimit, names)
        // 查询成功才推进；空结果的 newestId 是 0，advance 本身也不会动游标，
        // 但 peek 要显式留在原位，不能靠这个巧合。
        if (args.peek !== true) cursor.advance(res.newestId)
        return {
          account: account.account,
          self,
          cursorBefore,
          cursorAfter: cursor.value,
          firstRun,
          messages: res.messages,
          count: res.count,
          hasMore: res.hasMore,
          oldestId: res.oldestId,
          newestId: res.newestId,
        }
      })
    },
  }))
}

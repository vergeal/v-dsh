/**
 * Model-facing tools for the read-only data facade. Each tool resolves a source or an ad-hoc dialect, checks that the
 * engine belongs to the family the tool speaks, and then runs the matching gate through {@link executor.run}.
 * Passwords are read per call from the credential store, an explicit configuration value, or the environment — never
 * from tool arguments and never returned.
 * @module dbro/tools
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import * as Dialects from './dialects.js'
import { DBRO_ERRORS, DbroError } from './errors.js'
import * as Executor from './executor.js'
import * as Sources from './sources.js'

const sqlParameter = {
  type: 'string',
  required: true,
  description: '单条 select / show / desc / describe / explain 语句。只读入口会拒绝多语句以及 into、for update、nextval() 等写法，插件没有写开关。',
}

const familyTool = {
  sql: 'dbro_query / dbro_tables / dbro_columns',
  kv: 'dbro_kv_command / dbro_kv_scan',
  search: 'dbro_search_query / dbro_search_indices',
}

const connection = {
  dialect: {
    type: 'string',
    enum: Dialects.VALUES,
    description: '库类型。给了 source 时可省略；两者都给且不一致会报错。',
  },
  source: { type: 'string', description: '配置里 source 的条目名。省略时用 defaultSource。' },
  database: {
    type: 'string',
    description: '连接目标：达梦 / Oracle 是 schema，MySQL / SQL Server / PostgreSQL 是库名，SQLite 是文件路径，Redis 是逻辑库号，Elasticsearch 是索引模式。',
  },
  schema: {
    type: 'string',
    description: '仅 tables / columns 使用的 schema 过滤。省略时达梦、MySQL、Oracle 取 database，PostgreSQL 与 SQL Server 取各自的当前 schema，SQLite 忽略。',
  },
  host: { type: 'string', description: '覆盖数据源或环境变量里的主机。SQLite 不需要。' },
  port: { type: 'integer', description: '覆盖端口。默认达梦 5236、MySQL 3306、PostgreSQL 5432、Oracle 1521、SQL Server 1433、Redis 6379、Elasticsearch 9200。' },
  user: { type: 'string', description: '覆盖用户名。SQLite 不需要。' },
  timeout: { type: 'integer', description: '连接与语句超时秒数，1–120，默认取插件配置。' },
  maxRows: { type: 'integer', description: '结果行数 / 成员数上限，所有引擎的执行器都生效，默认取插件配置。' },
}

const resultOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dialect: { type: 'string', required: true },
      source: { type: 'string' },
      database: { type: 'string' },
      request: { type: 'string', required: true },
      text: { type: 'string', required: true },
      stderr: { type: 'string', required: true },
      durationMs: { type: 'number', required: true },
      truncated: { type: 'boolean', required: true },
    },
  },
  render: (_args, value) => renderResult(value),
}

const sourcesOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sources: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            dialect: { type: 'string', required: true },
            family: { type: 'string', required: true },
            host: { type: 'string', required: true },
            port: { type: 'integer', required: true },
            user: { type: 'string', required: true },
            database: { type: 'string' },
            options: { type: 'string' },
            passwordFrom: { type: 'string', required: true },
            default: { type: 'boolean', required: true },
          },
        },
      },
      errors: { type: 'array', required: true, items: { type: 'string' } },
      defaultSource: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: renderSources(value) }],
}

const doctorOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      python: { type: 'string', required: true },
      version: { type: 'string' },
      drivers: { type: 'object', additionalProperties: true, required: true },
      files: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
          },
        },
      },
      directory: { type: 'string' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: renderDoctor(value) }],
}

/**
 * Register every `dbro_*` tool against one plugin activation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying `ctx.tools`.
 * @param {object} config - validated plugin configuration.
 * @param {string} pluginRoot - installed plugin directory.
 */
export function register(ctx, config, pluginRoot) {
  const settings = () => Sources.settings(config)
  // Read the optional services per call: a profile may mount the credential store after this bundle loads.
  const credentials = () => ctx.get('credentials', false)

  ctx.tools.register(defineTool({
    name: 'dbro_sources',
    description: '列出配置的数据源：名称、引擎、引擎族、地址、目标、默认标记和口令来源（绝不返回明文口令）。配置写错时在 errors 里报告。',
    parameters: {},
    output: sourcesOutput,
    execute: async () => {
      const parsed = settings()
      const sources = await Promise.all(parsed.sources.map(async (source) => ({
        name: source.name,
        dialect: source.dialect,
        family: Dialects.familyOf(source.dialect),
        host: source.host,
        port: source.port,
        user: source.user,
        database: source.database,
        options: Object.entries(source.options ?? {}).map(([key, value]) => `${key}=${value}`).join(','),
        passwordFrom: (await passwordFor(credentials(), source, source.dialect)).from,
        default: source.name === parsed.defaultSource,
      })))
      return { sources, errors: [...parsed.errors], defaultSource: parsed.defaultSource }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_query',
    description: `执行一条只读 SQL，返回执行器渲染的文本表格。支持 ${Dialects.VALUES.filter((id) => Dialects.familyOf(id) === 'sql').join(' / ')}；Redis 走 dbro_kv_command，Elasticsearch 走 dbro_search_query。用 source 选已配置的数据源，或直接给 dialect（可再加 host/port/user/database 临时连库）。口令不进参数，取自凭据存储或环境变量。`,
    parameters: { sql: sqlParameter, ...connection },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      if (args.sql.length > 100_000) throw new ToolArgsError(['sql 最长 100000 字符'])
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'sql')
      return execute(parsed, target, { gate: target.gate, payload: args.sql, request: args.sql }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_tables',
    description: '按方言列出当前库或指定 schema 的表和视图。达梦 / Oracle 查 all_tables/user_tables，MySQL / PostgreSQL / SQL Server 查 information_schema.tables，SQLite 查 sqlite_master。',
    parameters: { ...connection },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'sql')
      const sql = Dialects.tables(target.dialect, schemaFor(target, args))
      return execute(parsed, target, { gate: target.gate, payload: sql, request: sql }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_columns',
    description: '按方言列出单张表的列：列名、类型、可空性和默认值。达梦 / Oracle 用 all_tab_columns/user_tab_columns，MySQL / PostgreSQL / SQL Server 用 information_schema.columns，SQLite 用 pragma_table_info。',
    parameters: {
      table: { type: 'string', required: true, description: '表名，区分大小写由各库规则决定。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      if (args.table.length > 128) throw new ToolArgsError(['table 最长 128 字符'])
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'sql')
      const sql = Dialects.columns(target.dialect, args.table, schemaFor(target, args))
      return execute(parsed, target, { gate: target.gate, payload: sql, request: sql }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_kv_command',
    description: '执行一条只读 Redis 命令，结果按 JSON 返回。命令走白名单（默认拒绝）：GET/HGETALL/LRANGE/SMEMBERS/ZRANGE/XRANGE/SCAN/TYPE/TTL/INFO/DBSIZE/CONFIG GET/CLIENT LIST/CLUSTER INFO 等。SET/DEL/EXPIRE/FLUSH*/EVAL*/SORT/KEYS 一律拒绝，插件没有写开关；KEYS 请改用 dbro_kv_scan。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: '一条完整命令，例如 "HGETALL user:1" 或 "CONFIG GET maxmemory"。参数里有空格时用引号包住。',
      },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      if (args.command.length > 4_000) throw new ToolArgsError(['command 最长 4000 字符'])
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'kv')
      return execute(parsed, target, { gate: target.gate, payload: args.command, request: args.command }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_kv_scan',
    description: '用 SCAN 增量遍历 Redis 键。首次不传 cursor，之后把上一次返回的 cursor 原样传回来，直到 cursor 为 "0"。比 KEYS 安全：每次只扫 COUNT 个桶，不阻塞实例。',
    parameters: {
      cursor: { type: 'string', description: '上一次 SCAN 返回的游标；首次省略（等价于 "0"）。' },
      match: { type: 'string', description: '键名匹配模式，例如 user:*。省略时不过滤。' },
      count: { type: 'integer', description: '本次扫描的桶数量提示，1–10000，默认取 maxRows。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 10_000))
        throw new ToolArgsError(['count 必须是 1–10000 的整数'])
      const violations = []
      if (args.cursor !== undefined && !/^\d{1,20}$/.test(args.cursor)) violations.push('cursor 必须是不超过 20 位的数字字符串')
      if (args.match !== undefined && args.match.length > 512) violations.push('match 最长 512 字符')
      if (violations.length > 0) throw new ToolArgsError(violations)

      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'kv')
      const parts = ['SCAN', args.cursor ?? '0']
      if (args.match) parts.push('MATCH', args.match)
      parts.push('COUNT', String(args.count ?? target.maxRows))
      const command = parts.join(' ')
      return execute(parsed, target, { gate: target.gate, payload: command, request: command }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_search_query',
    description: '对 Elasticsearch 索引执行一次只读 _search 或 _count，返回 JSON。查询体是标准 DSL；含 script / script_fields / runtime_mappings 会被拒绝（脚本能读写任意键，静态判不出来）。database 或 index 传索引模式，系统索引（.kibana 等）不让碰。',
    parameters: {
      op: { type: 'string', enum: ['search', 'count'], description: 'search 返回命中文档，count 只返回条数。默认 search。' },
      body: { type: 'string', required: true, description: 'JSON 查询体，例如 {"query":{"match_all":{}},"size":5}。' },
      index: { type: 'string', description: '索引名或模式，覆盖 database。可逗号分隔多个。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      searchArgs(args)
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'search')
      const index = args.index ?? target.database
      return execute(parsed, target, {
        gate: target.gate,
        argv: [args.op ?? 'search'],
        payload: args.body,
        request: `${args.op ?? 'search'} ${index ?? '*'} ${args.body}`,
        database: index,
      }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_search_indices',
    description: '列出 Elasticsearch 索引及其健康、文档数、存储大小（_cat/indices），或解析索引模式（_resolve）。database / index 给索引模式，默认 *。',
    parameters: {
      op: { type: 'string', enum: ['indices', 'resolve'], description: '默认 indices。' },
      index: { type: 'string', description: '索引名或模式，覆盖 database。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      searchArgs(args)
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'search')
      const index = args.index ?? target.database
      const op = args.op ?? 'indices'
      return execute(parsed, target, {
        gate: target.gate,
        argv: [op],
        payload: '',
        request: `${op} ${index ?? '*'}`,
        database: index,
      }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_search_mapping',
    description: '查看 Elasticsearch 索引的 mapping 或 settings（都是只读 GET）。index 传索引名或模式。',
    parameters: {
      part: { type: 'string', enum: ['mapping', 'settings'], description: '默认 mapping。' },
      index: { type: 'string', description: '索引名或模式，覆盖 database。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      searchArgs(args)
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'search')
      const index = args.index ?? target.database
      const part = args.part ?? 'mapping'
      return execute(parsed, target, {
        gate: target.gate,
        argv: [part],
        payload: '',
        request: `${part} ${index ?? '*'}`,
        database: index,
      }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_search_cluster',
    description: '查看 Elasticsearch 集群状态：health（_cluster/health）、allocation（_cat/allocation）、nodes（_nodes/stats 的内存/磁盘/索引摘要）、templates（_index_template）。',
    parameters: {
      part: { type: 'string', enum: ['health', 'allocation', 'nodes', 'templates'], description: '默认 health。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials(), 'search')
      const part = args.part ?? 'health'
      return execute(parsed, target, {
        gate: target.gate,
        argv: [part],
        payload: '',
        request: part,
        database: undefined,
      }, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_doctor',
    description: '自检数据查询链路：Python 是否可用、各引擎驱动是否可导入、门禁与执行脚本是否就位。连接失败前先跑它。',
    parameters: {},
    output: doctorOutput,
    execute: async (_args, exec) => {
      const parsed = settings()
      const directory = Executor.locate(pluginRoot, parsed.toolDirectory)
      const files = Dialects.SCRIPTS.map((name) => ({
        name,
        ok: directory !== undefined
          && (name === 'dbro.py' ? Executor.scriptPath(directory) !== undefined : existsSync(join(directory, name)) || existsSync(join(directory, 'dbro', name))),
      }))
      const probe = await Executor.probe(parsed.python, exec.signal)
      return { ...probe, files, directory }
    },
  }))
}

function checkArgs(args) {
  const violations = []
  if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535))
    violations.push('port 必须是 1–65535 的整数')
  if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || args.timeout < 1 || args.timeout > 120))
    violations.push('timeout 必须是 1–120 的整数秒')
  if (args.maxRows !== undefined && (!Number.isInteger(args.maxRows) || args.maxRows < 1 || args.maxRows > 10_000))
    violations.push('maxRows 必须是 1–10000 的整数')
  const limits = { source: 64, database: 512, schema: 128, host: 255, user: 128 }
  for (const [field, limit] of Object.entries(limits))
    if (typeof args[field] === 'string' && args[field].length > limit) violations.push(`${field} 最长 ${limit} 字符`)
  if (violations.length > 0) throw new ToolArgsError(violations)
}

function searchArgs(args) {
  const violations = []
  if (args.index !== undefined && args.index.length > 512) violations.push('index 最长 512 字符')
  if (args.body !== undefined && args.body.length > 100_000) violations.push('body 最长 100000 字符')
  if (violations.length > 0) throw new ToolArgsError(violations)
}

/**
 * The catalogue schema filter. Engines that reuse `database` as the schema (达梦, MySQL, Oracle) take it directly;
 * PostgreSQL and SQL Server keep catalog and schema apart, and SQLite has one attached schema, so `undefined` lets
 * {@link Dialects.tables} and {@link Dialects.columns} emit the engine's own default scope.
 */
function schemaFor(target, input) {
  if (input.schema) return input.schema
  return Dialects.SCHEMA_IS_DATABASE.has(target.dialect) ? target.database : undefined
}

/**
 * @param {Settings} settings - validated settings.
 * @param {object} input - tool arguments.
 * @param {object} credentials - `ctx.credentials` when the profile mounts a credential store.
 * @param {'sql'|'kv'|'search'} family - the tool surface making the call.
 * @returns {Promise<object>} the resolved connection target, carrying its gate and option environment.
 */
async function resolveTarget(settings, input, credentials, family) {
  // An explicit dialect means "this call is not the default source", otherwise a defaultSource would make it
  // impossible to reach another engine without naming a second source.
  const name = input.source ?? (input.dialect ? undefined : settings.defaultSource)
  const source = name ? Sources.find(settings, name) : undefined
  if (name && !source) {
    const known = settings.sources.map((entry) => entry.name).join('、') || '（无）'
    throw new DbroError(`没有名为「${name}」的数据源。已配置：${known}。`, DBRO_ERRORS.SOURCE_NOT_FOUND)
  }
  if (!source && !input.dialect)
    throw new DbroError(`缺少 dialect。先在插件配置里配置 sources 和 defaultSource，或直接传 dialect（${Dialects.VALUES.join(' / ')}）。`, DBRO_ERRORS.MISSING_DIALECT)

  const dialect = source?.dialect ?? input.dialect
  if (source && input.dialect && input.dialect !== source.dialect)
    throw new DbroError(`数据源「${source.name}」是 ${source.dialect}，与传入的 dialect=${input.dialect} 不一致。`, DBRO_ERRORS.DIALECT_MISMATCH)
  if (Dialects.familyOf(dialect) !== family)
    throw new DbroError(
      `${Dialects.LABEL[dialect]} 不归这类工具管：它走 ${familyTool[Dialects.familyOf(dialect)]}。本工具只接受 ${labelFor(family)}。`,
      DBRO_ERRORS.DIALECT_MISMATCH,
    )

  const credential = await passwordFor(credentials, source, dialect)
  // PostgreSQL and Redis have a safe default target; the others either have no useful default (MySQL, SQL Server,
  // Oracle, SQLite) or would silently widen the search scope (Elasticsearch).
  const database = input.database ?? source?.database ?? defaultDatabase(dialect)
  if (!database && Dialects.REQUIRES_DATABASE.has(dialect))
    throw new DbroError(`${Dialects.LABEL[dialect]} 需要 database（${databaseMeaning(dialect)}）：在数据源里配置，或在调用时传入。`, DBRO_ERRORS.MISSING_DATABASE)

  return {
    dialect,
    family,
    gate: Dialects.GATE[dialect],
    source: source?.name,
    database,
    host: input.host ?? source?.host,
    port: input.port ?? source?.port,
    user: input.user ?? source?.user,
    password: credential.password,
    options: source ? Sources.optionEnv(source) : {},
    timeout: input.timeout ?? settings.timeout,
    maxRows: input.maxRows ?? settings.maxRows,
  }
}

function defaultDatabase(dialect) {
  if (dialect === 'pg') return 'postgres'
  if (dialect === 'redis') return '0'
  if (dialect === 'es') return '*'
  return undefined
}

function databaseMeaning(dialect) {
  if (dialect === 'oracle' || dialect === 'dm') return 'schema / 服务名'
  if (dialect === 'sqlite') return '数据库文件路径'
  return '库名'
}

function labelFor(family) {
  return Dialects.VALUES
    .filter((id) => Dialects.familyOf(id) === family)
    .map((id) => Dialects.LABEL[id])
    .join(' / ')
}

/**
 * @param {Settings} settings - validated settings.
 * @param {object} target - resolved target from {@link resolveTarget}.
 * @param {{gate: string, argv?: string[], payload: string, request: string, database?: string}} request - gate, its
 *   positional arguments, the stdin payload, and the text to echo back to the model.
 * @param {AbortSignal} signal - caller cancellation.
 * @param {string} pluginRoot - installed plugin directory.
 * @returns {Promise<object>} the rendered result row.
 */
async function execute(settings, target, request, signal, pluginRoot) {
  const directory = Executor.locate(pluginRoot, settings.toolDirectory)
  if (!directory)
    throw new DbroError('找不到 dbro 门禁脚本（python/dbro/dbro.py）。重新安装插件，或用 toolDirectory 指向脚本目录。', DBRO_ERRORS.SCRIPTS_NOT_FOUND)

  const outcome = await Executor.run({
    dialect: target.dialect,
    gate: request.gate,
    argv: request.argv,
    input: request.payload,
    python: settings.python,
    directory,
    host: target.host,
    port: target.port,
    user: target.user,
    database: request.database ?? target.database,
    timeout: target.timeout,
    maxRows: target.maxRows,
    password: target.password,
    options: target.options,
    signal,
  })

  if (outcome.timedOut)
    throw new DbroError(`查询超过 ${target.timeout} 秒被终止。缩小结果集、加 LIMIT，或提高 timeout（上限 120）。`, DBRO_ERRORS.TIMEOUT)
  if (signal?.aborted) signal.throwIfAborted()
  if (outcome.exitCode !== 0) throw failure(outcome)

  return {
    dialect: target.dialect,
    source: target.source,
    database: request.database ?? target.database,
    request: request.request,
    text: outcome.stdout.trimEnd(),
    stderr: outcome.stderr.trim(),
    durationMs: outcome.durationMs,
    truncated: outcome.truncated,
  }
}

/**
 * Encrypted credential wins, then an explicit plaintext value, then the named environment variable, then the dialect
 * default. The same key addresses the credential store and the environment, so a stored value outranks an export.
 * @param {object} credentials - `ctx.credentials` when the profile mounts a credential store.
 * @param {Sources.Source|undefined} source - configured source, when one was selected.
 * @param {import('./dialects.js').Dialect} dialect - target engine.
 * @returns {Promise<{password: string|undefined, from: string}>} the password and a non-secret description of where it came from.
 */
async function passwordFor(credentials, source, dialect) {
  if (source) {
    const key = Sources.passwordEnv(source)
    const stored = await resolveCredential(credentials, key)
    if (stored !== undefined) return { password: stored, from: `凭据存储 ${key}` }
    if (source.password !== undefined) return { password: source.password, from: '配置里的明文 password' }
    const value = process.env[key]
    if (value !== undefined) return { password: value, from: `环境变量 ${key}` }
  }
  const env = Dialects.PASSWORD_ENV[dialect]
  if (!env) return { password: undefined, from: '该引擎无口令' }
  const value = process.env[env]
  if (value !== undefined) return { password: value, from: `环境变量 ${env}` }
  return { password: undefined, from: '未设置，使用执行器默认' }
}

/** A missing or unreadable credential must not turn a working query into a failure. */
async function resolveCredential(credentials, key) {
  if (!credentials || !isCredentialRefName(key)) return undefined
  try {
    const hit = await credentials.resolve(credentialRef(key))
    return hit?.value
  } catch {
    // A broken credential provider still leaves the plaintext and environment fallbacks in place.
    return undefined
  }
}

function failure(outcome) {
  const detail = [outcome.stderr.trim(), outcome.stdout.trim()].filter(Boolean).join('\n')
  // The gates exit 3 for both a rejected request and bad connection arguments; only the former is a read-only refusal.
  const rejected = outcome.exitCode === 3 && /只允许|检测到 .* 条语句|禁止的写法|不允许的写法|不在只读|白名单|写命令|写端点|系统索引|已拒绝|不支持|需要 -i|需要子命令|查询体/
    .test(detail)
  const hint = rejected
    ? '\n只读入口拒绝了这条请求：SQL 用单条 select/show/desc/describe/explain；Redis 用只读命令白名单里的命令；Elasticsearch 用不带脚本的查询体。'
    : ''
  return new DbroError(`dbro 退出码 ${outcome.exitCode}${detail ? `：\n${detail}` : '。'}${hint}`, rejected ? DBRO_ERRORS.REJECTED : DBRO_ERRORS.QUERY_FAILED)
}

function renderResult(value) {
  const parts = [value.text || '（执行器没有输出）']
  if (value.stderr) parts.push(`--- stderr ---\n${value.stderr}`)
  if (value.truncated) parts.push(`--- 输出已截断（上限 ${Executor.MAX_OUTPUT} 字符），请加过滤条件或聚合后再查 ---`)
  return [{ type: 'text', text: parts.join('\n\n') }]
}

function renderSources(value) {
  const lines = value.sources.map((source) => {
    const where = source.family === 'sql' && Dialects.FILE_DIALECTS.has(source.dialect)
      ? source.database || '（未配置文件路径）'
      : `${source.host}:${source.port}${source.database ? `/${source.database}` : '（默认目标）'}`
    const options = source.options ? `｜options：${source.options}` : ''
    const user = source.user ? ` 用户 ${source.user}` : ''
    return `- ${source.default ? '* ' : '  '}${source.name}（${Dialects.LABEL[source.dialect] ?? source.dialect}）${where}${user}｜口令：${source.passwordFrom}${options}`
  })
  if (lines.length === 0) lines.push('（没有配置数据源。可以在插件配置的 sources 里配置。）')
  if (value.errors.length > 0) lines.push('', '配置错误：', ...value.errors.map((error) => `- ${error}`))
  return lines.join('\n')
}

function renderDoctor(value) {
  const missing = Object.entries(value.drivers).filter(([, ok]) => !ok).map(([name]) => name)
  const installable = missing.map((name) => Dialects.DRIVER_PACKAGE[name]).filter(Boolean)
  const absent = missing.filter((name) => Dialects.DRIVER_PACKAGE[name] === null)
  return [
    value.error ? `Python 探测失败：${value.error}` : `Python：${value.version ?? value.python}`,
    `驱动：${Object.entries(value.drivers)
      .map(([name, ok]) => `${name} ${ok ? '可用' : '缺失'}`)
      .join('，') || '未探测到'}`,
    `脚本目录：${value.directory ?? '未找到'}`,
    value.files.some((file) => !file.ok)
      ? `缺少脚本：${value.files.filter((file) => !file.ok).map((file) => file.name).join('、')}`
      : `${value.files.length} 个门禁与执行脚本齐全`,
    installable.length > 0 ? `安装缺失驱动：${value.python} -m pip install ${installable.join(' ')}` : '',
    absent.length > 0 ? `需要从厂商分发安装的驱动：${absent.join('、')}（达梦 dmPython 通常在 $DM_HOME/drivers/python）` : '',
    missing.length > 0
      ? `缺哪个驱动只影响它自己的引擎：${missing.map((name) => `${name} → ${engineForDriver(name)}`).join('；')}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function engineForDriver(driver) {
  const dialect = Object.entries(Dialects.DRIVER).find(([, name]) => name === driver)?.[0]
  return dialect ? Dialects.LABEL[dialect] : driver
}

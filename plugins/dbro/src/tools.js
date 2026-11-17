/**
 * Model-facing tools for the read-only database facade. Each tool resolves a source or an ad-hoc dialect, then runs
 * `dbro.py` through {@link executor.run}. Passwords are read per call from the credential store, an explicit
 * configuration value, or the environment — never from tool arguments and never returned.
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

const connection = {
  dialect: {
    type: 'string',
    enum: Dialects.VALUES,
    description: '库类型。给了 source 时可省略；两者都给且不一致会报错。',
  },
  source: { type: 'string', description: '配置里 source 的条目名。省略时用 defaultSource。' },
  database: {
    type: 'string',
    description: '连接用的数据库名：达梦是 schema，MySQL 是库名，PostgreSQL 是库名（省略时用 postgres）。',
  },
  schema: {
    type: 'string',
    description: '仅 tables / columns 使用的 schema 过滤。省略时达梦和 MySQL 取 database，PostgreSQL 取 current_schema()。',
  },
  host: { type: 'string', description: '覆盖数据源或环境变量里的主机。' },
  port: { type: 'integer', description: '覆盖端口。默认达梦 5236、MySQL 3306、PostgreSQL 5432。' },
  user: { type: 'string', description: '覆盖用户名。' },
  timeout: { type: 'integer', description: '连接与语句超时秒数，1–120，默认取插件配置。' },
  maxRows: { type: 'integer', description: '结果行数上限。当前只对 PostgreSQL 执行器生效，默认取插件配置。' },
}

const resultOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dialect: { type: 'string', required: true },
      source: { type: 'string' },
      database: { type: 'string' },
      sql: { type: 'string', required: true },
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
            host: { type: 'string', required: true },
            port: { type: 'integer', required: true },
            user: { type: 'string', required: true },
            database: { type: 'string' },
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
      drivers: {
        type: 'object',
        additionalProperties: true,
        required: true,
        properties: {
          pymysql: { type: 'boolean' },
          psycopg2: { type: 'boolean' },
          dmPython: { type: 'boolean' },
        },
      },
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
    description: '列出配置的数据源：名称、方言、地址、库名、默认标记和口令来源（绝不返回明文口令）。配置写错时在 errors 里报告。',
    parameters: {},
    output: sourcesOutput,
    execute: async () => {
      const parsed = settings()
      const sources = await Promise.all(parsed.sources.map(async (source) => ({
        name: source.name,
        dialect: source.dialect,
        host: source.host,
        port: source.port,
        user: source.user,
        database: source.database,
        passwordFrom: (await passwordFor(credentials(), source, source.dialect)).from,
        default: source.name === parsed.defaultSource,
      })))
      return { sources, errors: [...parsed.errors], defaultSource: parsed.defaultSource }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_query',
    description: '执行一条只读 SQL，返回执行器渲染的文本表格。用 source 选已配置的数据源，或直接给 dialect（可再加 host/port/user/database 临时连库）。口令不进参数，取自凭据存储或环境变量。',
    parameters: { sql: sqlParameter, ...connection },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      if (args.sql.length > 100_000) throw new ToolArgsError(['sql 最长 100000 字符'])
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials())
      return executeStatement(parsed, target, args.sql, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_tables',
    description: '按方言列出当前库或指定 schema 的表和视图。达梦查 all_tables/user_tables，MySQL 查 information_schema.tables，PostgreSQL 查 information_schema.tables 并限定 current_schema()。',
    parameters: { ...connection },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials())
      const sql = Dialects.tables(target.dialect, schemaFor(target, args))
      return executeStatement(parsed, target, sql, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_columns',
    description: '按方言列出单张表的列：列名、类型、可空性和默认值。达梦用 all_tab_columns/user_tab_columns，MySQL 与 PostgreSQL 用 information_schema.columns。',
    parameters: {
      table: { type: 'string', required: true, description: '表名，区分大小写由各库规则决定。' },
      ...connection,
    },
    output: resultOutput,
    execute: async (args, exec) => {
      checkArgs(args)
      if (args.table.length > 128) throw new ToolArgsError(['table 最长 128 字符'])
      const parsed = settings()
      const target = await resolveTarget(parsed, args, credentials())
      const sql = Dialects.columns(target.dialect, args.table, schemaFor(target, args))
      return executeStatement(parsed, target, sql, exec.signal, pluginRoot)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dbro_doctor',
    description: '自检数据库查询链路：Python 是否可用、pymysql/psycopg2/dmPython 是否可导入、四个执行脚本是否就位。连接失败前先跑它。',
    parameters: {},
    output: doctorOutput,
    execute: async (_args, exec) => {
      const parsed = settings()
      const directory = Executor.locate(pluginRoot, parsed.toolDirectory)
      const files = ['dbro.py', ...Dialects.VALUES.map((dialect) => Dialects.EXECUTOR[dialect])].map((name) => ({
        name,
        ok: directory !== undefined
          && (name === 'dbro.py' ? Executor.scriptPath(directory) !== undefined : existsSync(join(directory, name))),
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
  const limits = { source: 64, database: 128, schema: 128, host: 255, user: 128 }
  for (const [field, limit] of Object.entries(limits))
    if (typeof args[field] === 'string' && args[field].length > limit) violations.push(`${field} 最长 ${limit} 字符`)
  if (violations.length > 0) throw new ToolArgsError(violations)
}

/** PostgreSQL treats the connection database and the schema separately; 达梦 and MySQL reuse the database name. */
function schemaFor(target, input) {
  if (input.schema) return input.schema
  return target.dialect === 'pg' ? undefined : target.database
}

async function resolveTarget(settings, input, credentials) {
  // An explicit dialect means "this call is not the default source", otherwise a defaultSource would make it
  // impossible to reach another engine without naming a second source.
  const name = input.source ?? (input.dialect ? undefined : settings.defaultSource)
  const source = name ? Sources.find(settings, name) : undefined
  if (name && !source) {
    const known = settings.sources.map((entry) => entry.name).join('、') || '（无）'
    throw new DbroError(`没有名为「${name}」的数据源。已配置：${known}。`, DBRO_ERRORS.SOURCE_NOT_FOUND)
  }
  if (!source && !input.dialect)
    throw new DbroError('缺少 dialect。先在插件配置里配置 sources 和 defaultSource，或直接传 dialect（dm / mysql / pg）。', DBRO_ERRORS.MISSING_DIALECT)

  const dialect = source?.dialect ?? input.dialect
  if (source && input.dialect && input.dialect !== source.dialect)
    throw new DbroError(`数据源「${source.name}」是 ${source.dialect}，与传入的 dialect=${input.dialect} 不一致。`, DBRO_ERRORS.DIALECT_MISMATCH)

  const credential = await passwordFor(credentials, source, dialect)
  // dbro.py requires a database for PostgreSQL and MySQL. PostgreSQL falls back to its own default `postgres`; MySQL
  // has no safe default, because a query may rely on the connection database.
  const database = input.database ?? source?.database ?? (dialect === 'pg' ? 'postgres' : undefined)
  if (!database && dialect === 'mysql')
    throw new DbroError('MySQL 需要 database（库名）：在数据源里配置 database，或在调用时传入。', DBRO_ERRORS.MISSING_DATABASE)

  return {
    dialect,
    source: source?.name,
    database,
    host: input.host ?? source?.host,
    port: input.port ?? source?.port,
    user: input.user ?? source?.user,
    password: credential.password,
    timeout: input.timeout ?? settings.timeout,
    maxRows: input.maxRows ?? settings.maxRows,
  }
}

async function executeStatement(settings, target, sql, signal, pluginRoot) {
  const directory = Executor.locate(pluginRoot, settings.toolDirectory)
  if (!directory)
    throw new DbroError('找不到 dbro 执行脚本（python/dbro/dbro.py）。重新安装插件，或用 toolDirectory 指向脚本目录。', DBRO_ERRORS.SCRIPTS_NOT_FOUND)

  const outcome = await Executor.run({
    dialect: target.dialect,
    sql,
    python: settings.python,
    directory,
    host: target.host,
    port: target.port,
    user: target.user,
    database: target.database,
    timeout: target.timeout,
    maxRows: target.maxRows,
    password: target.password,
    signal,
  })

  if (outcome.timedOut)
    throw new DbroError(`查询超过 ${target.timeout} 秒被终止。缩小结果集、加 LIMIT，或提高 timeout（上限 120）。`, DBRO_ERRORS.TIMEOUT)
  if (signal?.aborted) signal.throwIfAborted()
  if (outcome.exitCode !== 0) throw failure(outcome)

  return {
    dialect: target.dialect,
    source: target.source,
    database: target.database,
    sql,
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
 * @param {'dm'|'mysql'|'pg'} dialect - target engine.
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
  // dbro.py exits 3 for both a rejected statement and bad connection arguments; only the former is a read-only refusal.
  const rejected = outcome.exitCode === 3 && /只允许|检测到 .* 条语句|禁止的写法/.test(detail)
  const hint = rejected
    ? '\n只读入口拒绝了这条语句：改成单条 select/show/desc/describe/explain，并去掉 into、for update、nextval() 等写法。'
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
  const lines = value.sources.map(
    (source) =>
      `- ${source.default ? '* ' : '  '}${source.name}（${Dialects.LABEL[source.dialect] ?? source.dialect}）${source.host}:${source.port}/${source.database ?? '（默认库）'} 用户 ${source.user}｜口令：${source.passwordFrom}`,
  )
  if (lines.length === 0) lines.push('（没有配置数据源。可以在插件配置的 sources 里配置。）')
  if (value.errors.length > 0) lines.push('', '配置错误：', ...value.errors.map((error) => `- ${error}`))
  return lines.join('\n')
}

function renderDoctor(value) {
  const missing = Object.entries(value.drivers)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  const installable = missing.filter((name) => name !== 'dmPython').map((name) => (name === 'psycopg2' ? 'psycopg2-binary' : name))
  return [
    value.error ? `Python 探测失败：${value.error}` : `Python：${value.version ?? value.python}`,
    `驱动：${Object.entries(value.drivers)
      .map(([name, ok]) => `${name} ${ok ? '可用' : '缺失'}`)
      .join('，') || '未探测到'}`,
    `脚本目录：${value.directory ?? '未找到'}`,
    value.files.some((file) => !file.ok) ? `缺少脚本：${value.files.filter((file) => !file.ok).map((file) => file.name).join('、')}` : '四个脚本齐全',
    installable.length > 0 ? `安装缺失驱动：${value.python} -m pip install ${installable.join(' ')}` : '',
    missing.includes('dmPython') && missing.length === 1
      ? '达梦驱动 dmPython 需要从 $DM_HOME/drivers/python 安装；缺它只影响 dm，不影响 MySQL/PostgreSQL。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

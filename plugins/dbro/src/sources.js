/**
 * Parse the plugin's `sources` configuration into connection templates, reporting bad entries instead of dropping
 * them. Passwords never belong in a source string or object; they come from the credential store or environment.
 * @module dbro/sources
 */

import * as Dialects from './dialects.js'

/**
 * One configured data source. `database` means a schema for 达梦 and Oracle, the database for MySQL and SQL Server,
 * the connection database for PostgreSQL, a file path for SQLite, a logical db index for Redis, and the default index
 * pattern for Elasticsearch.
 * @typedef {object} Source
 * @property {string} name - unique source name.
 * @property {import('./dialects.js').Dialect} dialect - target engine.
 * @property {string} host - host name or address; empty for a file-based engine.
 * @property {number} port - TCP port; `0` for a file-based engine.
 * @property {string} user - login name; empty when the engine takes no user.
 * @property {string} [database] - engine-specific target named above.
 * @property {string} [passwordEnv] - environment variable holding the password.
 * @property {string} [password] - plaintext password; only set when the user accepted it in configuration.
 * @property {Record<string, string>} [options] - per-engine connection options, keyed by {@link Dialects.optionNames}.
 */

/**
 * Validated plugin settings.
 * @typedef {object} Settings
 * @property {Source[]} sources - configured sources, later entries win by name.
 * @property {string} [defaultSource] - source used when neither `source` nor `dialect` is given.
 * @property {string} python - Python interpreter to run the executors with.
 * @property {number} timeout - connection and statement timeout in seconds.
 * @property {number} maxRows - row cap passed to every executor.
 * @property {string} [toolDirectory] - explicit directory holding the gates and executors.
 * @property {string[]} errors - configuration entries that could not be parsed.
 */

/**
 * Normalize plugin configuration. The bundle has one configuration layer: the `cordis.yml` row, whose field defaults
 * the Config schema applies.
 * @param {Record<string, unknown>} config - validated plugin configuration.
 * @returns {Settings} parsed settings with the configured sources merged by name.
 */
export function settings(config) {
  const parsed = parseEntries(config.sources)
  const merged = [...parsed.sources.reduce((byName, source) => byName.set(source.name, source), new Map()).values()]

  return {
    sources: merged,
    defaultSource: text(config.defaultSource),
    python: text(config.python) ?? 'python3',
    timeout: integer(config.timeout) ?? 30,
    maxRows: integer(config.maxRows) ?? 200,
    toolDirectory: text(config.toolDirectory),
    errors: parsed.errors,
  }
}

/**
 * @param {Settings} settings - validated settings.
 * @param {string} name - source name to look up.
 * @returns {Source|undefined} the matching source.
 */
export function find(settings, name) {
  return settings.sources.find((source) => source.name === name)
}

/**
 * The environment variable that holds a source's password. The same name is used as the credential-store key, so a
 * stored key and an exported variable address the same secret.
 * @param {Source} source - the source whose password variable to name.
 * @returns the variable name.
 */
export function passwordEnv(source) {
  if (source.passwordEnv) return source.passwordEnv
  return `DBRO_${source.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD`
}

/**
 * The environment variables a source's options set, keyed by the name the gate reads them from.
 * @param {Source} source - the source whose options to resolve.
 * @returns {Record<string, string>} option variables; empty for engines without options.
 */
export function optionEnv(source) {
  const names = Dialects.OPTION_ENV[source.dialect] ?? {}
  const out = {}
  for (const [option, value] of Object.entries(source.options ?? {})) {
    const variable = names[option]
    if (variable) out[variable] = value
  }
  return out
}

function parseEntries(value) {
  if (value === undefined || value === null) return { sources: [], errors: [] }
  if (!Array.isArray(value)) return { sources: [], errors: ['sources 必须是字符串或对象数组。'] }

  const sources = []
  const errors = []
  for (const entry of value) {
    const result = parseEntry(entry)
    if (typeof result === 'string') {
      errors.push(result)
      continue
    }
    sources.push(result)
  }
  return { sources, errors }
}

function parseEntry(entry) {
  if (typeof entry === 'string') return parseString(entry)
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '数据源条目必须是字符串或对象。'

  const name = text(entry.name)
  const dialect = text(entry.dialect)
  if (!name) return '数据源对象缺少 name。'
  if (!dialect || !Dialects.is(dialect))
    return `数据源 ${name} 的 dialect 必须是 ${Dialects.VALUES.join(' / ')}。`

  const options = parseOptions(dialect, entry.options, name)
  if (typeof options === 'string') return options

  return {
    name,
    dialect,
    host: text(entry.host) ?? (Dialects.FILE_DIALECTS.has(dialect) ? '' : '127.0.0.1'),
    port: integer(entry.port) ?? Dialects.DEFAULT_PORT[dialect],
    user: text(entry.user) ?? Dialects.DEFAULT_USER[dialect],
    database: text(entry.database),
    passwordEnv: text(entry.passwordEnv),
    password: text(entry.password),
    options,
  }
}

/**
 * `name=dm://user@host:5236/schema` or the same URL without a name, in which case the name is derived from it.
 * Passwords never belong in this string: use `passwordEnv` or the credential store key of the same name.
 * Query parameters become the source's connection options, for example `es://user@host:9200/logs-*?tls=1`.
 * @param {string} entry - one configured source string.
 * @returns {Source|string} the parsed source, or a report explaining why it was rejected.
 */
function parseString(entry) {
  const trimmed = entry.trim()
  const separator = trimmed.indexOf('=')
  const named = separator > 0 && !trimmed.slice(0, separator).includes('://')
  const name = named ? trimmed.slice(0, separator).trim() : undefined
  const address = named ? trimmed.slice(separator + 1).trim() : trimmed

  let url
  try {
    url = new URL(address)
  } catch {
    return `无法解析数据源：${trimmed}。格式是 name=dm://user@host:5236/database。`
  }

  const dialect = url.protocol.replace(/:$/, '')
  if (!Dialects.is(dialect)) return `数据源 ${trimmed} 的协议必须是 ${Dialects.VALUES.join(' / ')}。`

  const fileBased = Dialects.FILE_DIALECTS.has(dialect)
  // A file engine addresses a path, not a host: `sqlite:///D:/data/app.db` (Windows) and `sqlite:////var/lib/a.db`
  // (absolute POSIX) keep the path in the pathname, one leading slash stripped. The two-slash form is unrecoverable
  // because the URL parser eats the drive colon into the host, so it is rejected instead of silently mangled.
  if (fileBased && url.hostname)
    return `数据源 ${trimmed} 的路径写法不对：SQLite 请用三条斜杠加路径（sqlite:///D:/data/app.db，POSIX 绝对路径用四条），或改用对象写法。`
  const host = fileBased ? '' : url.hostname
  const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const options = parseOptions(dialect, Object.fromEntries(url.searchParams), dialect)
  if (typeof options === 'string') return `数据源 ${trimmed} 的 options 有问题：${options}`

  const port = url.port ? Number(url.port) : Dialects.DEFAULT_PORT[dialect]
  if (!Number.isInteger(port) || port < 0 || port > 65535) return `数据源 ${trimmed} 的端口无效。`

  const user = decodeURIComponent(url.username) || Dialects.DEFAULT_USER[dialect]
  const database = path || undefined

  return {
    name: name || (fileBased ? `${dialect}:${database ?? '默认'}` : `${dialect}:${url.hostname}${database ? `/${database}` : ''}`),
    dialect,
    host,
    port,
    user: fileBased ? '' : user,
    database,
    options,
  }
}

/**
 * @param {import('./dialects.js').Dialect} dialect - target engine.
 * @param {unknown} value - the configured options.
 * @param {string} label - source name or dialect, for the error report.
 * @returns {Record<string, string>|string} the normalized options, or a report naming the rejected key.
 */
function parseOptions(dialect, value, label) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return `数据源 ${label} 的 options 必须是对象。`

  const allowed = Dialects.optionNames(dialect)
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue
    if (!allowed.includes(key))
      return `数据源 ${label}（${dialect}）不支持 option「${key}」${allowed.length > 0 ? `；可用：${allowed.join(' / ')}。` : '。'}`
    out[key] = String(raw)
  }
  return out
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function integer(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * The engines dbro.py and the two non-SQL gates front. Every engine is one entry in parallel maps keyed by the dialect
 * id, and `FAMILY` says which tool surface addresses it: `sql` engines take one read-only statement through
 * `dbro_query`, `kv` engines take one whitelisted command through `dbro_kv_command`, and `search` engines take a
 * structured request through `dbro_search_query`.
 *
 * `dm` is 达梦 8, whose `-d` argument is a schema rather than a database; `sqlite` has no host, port or password at
 * all, because its `-d` argument is a file path. The SQL below keeps those differences in one place instead of letting
 * every caller branch on the dialect.
 * @module dbro/dialects
 */

/**
 * @typedef {'dm' | 'mysql' | 'pg' | 'oracle' | 'mssql' | 'sqlite' | 'redis' | 'es'} Dialect
 *   One supported engine id.
 */

/** Accepted dialect ids, in the order the tools advertise them. */
export const VALUES = ['dm', 'mysql', 'pg', 'oracle', 'mssql', 'sqlite', 'redis', 'es']

/** Which tool surface addresses each engine. */
export const FAMILY = {
  dm: 'sql',
  mysql: 'sql',
  pg: 'sql',
  oracle: 'sql',
  mssql: 'sql',
  sqlite: 'sql',
  redis: 'kv',
  es: 'search',
}

/** Human-readable engine names. */
export const LABEL = {
  dm: '达梦 8',
  mysql: 'MySQL',
  pg: 'PostgreSQL',
  oracle: 'Oracle',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
  redis: 'Redis',
  es: 'Elasticsearch',
}

/** Default port per engine, matching the executors. `0` marks an engine with no network port. */
export const DEFAULT_PORT = {
  dm: 5236,
  mysql: 3306,
  pg: 5432,
  oracle: 1521,
  mssql: 1433,
  sqlite: 0,
  redis: 6379,
  es: 9200,
}

/** Default user per engine, matching the executors. `''` marks an engine with no authentication. */
export const DEFAULT_USER = {
  dm: 'SYSDBA',
  mysql: 'root',
  pg: 'postgres',
  oracle: 'system',
  mssql: 'sa',
  sqlite: '',
  redis: '',
  es: 'elastic',
}

/** The password environment variable each executor reads. Absent for engines that take no password. */
export const PASSWORD_ENV = {
  dm: 'DM8_PASSWORD',
  mysql: 'MYSQL_PASSWORD',
  pg: 'PGPASSWORD',
  oracle: 'ORACLE_PASSWORD',
  mssql: 'MSSQL_PASSWORD',
  redis: 'REDIS_PASSWORD',
  es: 'ES_PASSWORD',
}

/** The script behind each dialect, all flattened beside `dbro.py` in `python/`. */
export const EXECUTOR = {
  dm: 'dm8_exec.py',
  mysql: 'mysql_exec.py',
  pg: 'pgsql_exec.py',
  oracle: 'oracle_exec.py',
  mssql: 'mssql_exec.py',
  sqlite: 'sqlite_exec.py',
  redis: 'redis_exec.py',
  es: 'es_exec.py',
}

/** The gate in front of each executor: SQL statements, Redis commands, or Elasticsearch requests. */
export const GATE = {
  dm: 'dbro.py',
  mysql: 'dbro.py',
  pg: 'dbro.py',
  oracle: 'dbro.py',
  mssql: 'dbro.py',
  sqlite: 'dbro.py',
  redis: 'dbro_kv.py',
  es: 'dbro_search.py',
}

/** Gate and executor scripts the bundle must ship, in `dbro_doctor` order. */
export const SCRIPTS = [
  'dbro.py',
  'dbro_kv.py',
  'dbro_search.py',
  ...VALUES.map((dialect) => EXECUTOR[dialect]),
]

/** The Python module each engine's driver is imported from, for `dbro_doctor`. */
export const DRIVER = {
  dm: 'dmPython',
  mysql: 'pymysql',
  pg: 'psycopg2',
  oracle: 'oracledb',
  mssql: 'pymssql',
  sqlite: 'sqlite3',
  redis: 'redis',
}

/** Engines reached through a file path instead of a host and port. */
export const FILE_DIALECTS = new Set(['sqlite'])

/** Engines whose `database` argument names a catalog the statement must run against. */
export const REQUIRES_DATABASE = new Set(['mysql', 'oracle', 'mssql', 'sqlite'])

/**
 * Engines whose `database` doubles as the catalogue schema filter. SQL Server and PostgreSQL keep the catalog and the
 * schema apart, and SQLite has one attached schema named `main`, so a `database` filter would silently return nothing.
 */
export const SCHEMA_IS_DATABASE = new Set(['dm', 'mysql', 'oracle', 'redis'])

/** The pip requirement behind each {@link DRIVER}, for the `dbro_doctor` install hint. */
export const DRIVER_PACKAGE = {
  dm: null,
  mysql: 'pymysql',
  pg: 'psycopg2-binary',
  oracle: 'oracledb',
  mssql: 'pymssql',
  redis: 'redis',
}

/**
 * Connection options an engine's executor accepts, mapped to the environment variable the gate reads. Anything else in
 * a source's `options` is a configuration error rather than a silently dropped setting.
 */
export const OPTION_ENV = {
  redis: { tls: 'REDIS_TLS', insecure: 'REDIS_INSECURE' },
  es: { tls: 'ES_TLS', insecure: 'ES_INSECURE', scheme: 'ES_SCHEME' },
}

/**
 * @param dialect - target engine.
 * @returns the accepted option names, empty for engines with no extra options.
 */
export function optionNames(dialect) {
  return Object.keys(OPTION_ENV[dialect] ?? {})
}

/**
 * @param value - candidate dialect id.
 * @returns whether the value names one of {@link VALUES}.
 */
export function is(value) {
  return VALUES.includes(value)
}

/**
 * @param value - candidate dialect id.
 * @returns the tool family of the engine, or `undefined` for an unknown id.
 */
export function familyOf(value) {
  return FAMILY[value]
}

/**
 * A single-quoted SQL string literal. Callers only ever compare names, never splice identifiers.
 * @param value - the literal text to quote.
 * @returns the quoted literal with embedded quotes doubled.
 */
export function literal(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * @param dialect - target engine.
 * @param database - schema filter, or `undefined` for the engine's own default scope.
 * @returns the catalogue query listing tables and views.
 */
export function tables(dialect, database) {
  switch (dialect) {
    case 'dm':
    case 'oracle':
      return database
        ? `SELECT owner, table_name FROM all_tables WHERE owner = upper(${literal(database)}) ORDER BY table_name`
        : 'SELECT table_name FROM user_tables ORDER BY table_name'
    case 'mysql':
      return `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ${database ? literal(database) : 'DATABASE()'} ORDER BY table_name`
    case 'pg':
      return `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = ${database ? literal(database) : 'current_schema()'} AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name`
    case 'mssql':
      return `SELECT table_schema, table_name, table_type FROM information_schema.tables ${database ? `WHERE table_schema = ${literal(database)}` : 'WHERE table_schema <> \'INFORMATION_SCHEMA\''} ORDER BY table_name`
    case 'sqlite':
      return "SELECT name AS table_name, type AS table_type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    default:
      throw new Error(`未知方言：${dialect}`)
  }
}

/**
 * @param dialect - target engine.
 * @param table - table name to inspect.
 * @param database - schema filter, or `undefined` for the engine's own default scope.
 * @returns the catalogue query listing the table's columns.
 */
export function columns(dialect, table, database) {
  const qualified = database ? ` AND ${schemaColumn(dialect)} = ${literal(database)}` : ''
  switch (dialect) {
    case 'dm':
    case 'oracle':
      return database
        ? `SELECT column_name, data_type, data_length, nullable FROM all_tab_columns WHERE owner = upper(${literal(database)}) AND table_name = upper(${literal(table)}) ORDER BY column_id`
        : `SELECT column_name, data_type, data_length, nullable FROM user_tab_columns WHERE table_name = upper(${literal(table)}) ORDER BY column_id`
    case 'mysql':
      return `SELECT column_name, column_type, is_nullable, column_default, column_key FROM information_schema.columns WHERE table_schema = ${database ? literal(database) : 'DATABASE()'} AND table_name = ${literal(table)} ORDER BY ordinal_position`
    case 'pg':
      return `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${database ? literal(database) : 'current_schema()'} AND table_name = ${literal(table)} ORDER BY ordinal_position`
    case 'mssql':
      return `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = ${literal(table)}${qualified} ORDER BY ordinal_position`
    case 'sqlite':
      return `SELECT cid AS column_id, name AS column_name, type AS data_type, "notnull" AS not_null, dflt_value AS column_default FROM pragma_table_info(${literal(table)}) ORDER BY cid`
    default:
      throw new Error(`未知方言：${dialect}`)
  }
}

function schemaColumn(dialect) {
  return dialect === 'oracle' || dialect === 'dm' ? 'owner' : 'table_schema'
}

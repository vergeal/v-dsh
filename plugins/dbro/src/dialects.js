/**
 * The three engines dbro.py fronts. `dm` is 达梦 8, whose `-d` argument is the schema rather than a database; the SQL
 * below keeps that difference in one place instead of letting every caller branch on the dialect.
 * @module dbro/dialects
 */

/** Accepted dialect ids, in the order the tools advertise them. */
export const VALUES = ['dm', 'mysql', 'pg']

/** Human-readable engine names. */
export const LABEL = {
  dm: '达梦 8',
  mysql: 'MySQL',
  pg: 'PostgreSQL',
}

/** Default port per engine, matching the executors. */
export const DEFAULT_PORT = {
  dm: 5236,
  mysql: 3306,
  pg: 5432,
}

/** Default user per engine, matching the executors. */
export const DEFAULT_USER = {
  dm: 'SYSDBA',
  mysql: 'root',
  pg: 'postgres',
}

/** The password environment variable each executor reads, matching dbro.py and the three executors. */
export const PASSWORD_ENV = {
  dm: 'DM8_PASSWORD',
  mysql: 'MYSQL_PASSWORD',
  pg: 'PGPASSWORD',
}

/** The executor script behind each dialect, all flattened beside `dbro.py` in `python/`. */
export const EXECUTOR = {
  dm: 'dm8_exec.py',
  mysql: 'mysql_exec.py',
  pg: 'pgsql_exec.py',
}

/**
 * @param value - candidate dialect id.
 * @returns whether the value names one of {@link VALUES}.
 */
export function is(value) {
  return VALUES.includes(value)
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
      return database
        ? `SELECT owner, table_name FROM all_tables WHERE owner = upper(${literal(database)}) ORDER BY table_name`
        : 'SELECT table_name FROM user_tables ORDER BY table_name'
    case 'mysql':
      return `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ${database ? literal(database) : 'DATABASE()'} ORDER BY table_name`
    case 'pg':
      return `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = ${database ? literal(database) : 'current_schema()'} AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name`
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
  switch (dialect) {
    case 'dm':
      return database
        ? `SELECT column_name, data_type, data_length, nullable FROM all_tab_columns WHERE owner = upper(${literal(database)}) AND table_name = upper(${literal(table)}) ORDER BY column_id`
        : `SELECT column_name, data_type, data_length, nullable FROM user_tab_columns WHERE table_name = upper(${literal(table)}) ORDER BY column_id`
    case 'mysql':
      return `SELECT column_name, column_type, is_nullable, column_default, column_key FROM information_schema.columns WHERE table_schema = ${database ? literal(database) : 'DATABASE()'} AND table_name = ${literal(table)} ORDER BY ordinal_position`
    case 'pg':
      return `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${database ? literal(database) : 'current_schema()'} AND table_name = ${literal(table)} ORDER BY ordinal_position`
    default:
      throw new Error(`未知方言：${dialect}`)
  }
}

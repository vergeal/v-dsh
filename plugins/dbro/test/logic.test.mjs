/**
 * Behavior checks for the pure parts of the port: source parsing, dialect SQL, gate routing, and executor location.
 * Run with `node --test plugins/dbro/test/logic.test.mjs`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import * as Dialects from '../src/dialects.js'
import * as Executor from '../src/executor.js'
import * as Sources from '../src/sources.js'
import { registerSkill, SKILL_NAME } from '../src/skill.js'

test('parses URL shorthand and defaults the port, user and name', () => {
  const settings = Sources.settings({ sources: ['mysql://readonly@10.0.0.6/mall'] })
  assert.deepEqual(settings.errors, [])
  assert.deepEqual(settings.sources, [
    { name: 'mysql:10.0.0.6/mall', dialect: 'mysql', host: '10.0.0.6', port: 3306, user: 'readonly', database: 'mall', options: {} },
  ])
})

test('accepts object entries with dialect defaults', () => {
  const settings = Sources.settings({ sources: [{ name: 'report', dialect: 'pg', host: '10.0.0.7', database: 'analytics' }] })
  assert.deepEqual(settings.errors, [])
  assert.deepEqual(settings.sources[0], {
    name: 'report', dialect: 'pg', host: '10.0.0.7', port: 5432, user: 'postgres', database: 'analytics',
    passwordEnv: undefined, password: undefined, options: {},
  })
})

test('parses a SQLite file path and rejects the unrecoverable two-slash form', () => {
  const windows = Sources.settings({ sources: ['app=sqlite:///D:/data/app.db'] })
  assert.deepEqual(windows.errors, [])
  assert.deepEqual(windows.sources[0], {
    name: 'app', dialect: 'sqlite', host: '', port: 0, user: '', database: 'D:/data/app.db', options: {},
  })

  const absolute = Sources.settings({ sources: ['app=sqlite:////var/lib/app.db'] })
  assert.equal(absolute.sources[0]?.database, '/var/lib/app.db')

  const derived = Sources.settings({ sources: ['sqlite:///D:/data/app.db'] })
  assert.equal(derived.sources[0]?.name, 'sqlite:D:/data/app.db')

  const twoSlash = Sources.settings({ sources: ['sqlite://D:/data/app.db'] })
  assert.deepEqual(twoSlash.sources, [])
  assert.equal(twoSlash.errors.length, 1)
  assert.match(twoSlash.errors[0] ?? '', /三条斜杠/)
  assert.equal(Dialects.familyOf(windows.sources[0]?.dialect), 'sql')
})

test('parses a Redis db index and an Elasticsearch index pattern', () => {
  const settings = Sources.settings({ sources: ['cache=redis://10.0.0.9:6379/2', 'logs=es://readonly@10.0.0.10:9200/logs-*'] })
  assert.deepEqual(settings.errors, [])
  const [cache, logs] = settings.sources
  assert.deepEqual([cache.dialect, cache.port, cache.database], ['redis', 6379, '2'])
  assert.equal(Dialects.familyOf(cache.dialect), 'kv')
  assert.deepEqual([logs.dialect, logs.user, logs.database], ['es', 'readonly', 'logs-*'])
  assert.equal(Dialects.familyOf(logs.dialect), 'search')
})

test('reads connection options from URL query parameters and maps them to variables', () => {
  const settings = Sources.settings({ sources: ['search=es://readonly@10.0.0.10/logs-*?tls=1&insecure=1'] })
  assert.deepEqual(settings.errors, [])
  assert.deepEqual(settings.sources[0].options, { tls: '1', insecure: '1' })
  assert.deepEqual(Sources.optionEnv(settings.sources[0]), { ES_TLS: '1', ES_INSECURE: '1' })
})

test('rejects an option the engine does not understand', () => {
  const settings = Sources.settings({ sources: [{ name: 'report', dialect: 'pg', options: { tls: '1' } }] })
  assert.deepEqual(settings.sources, [])
  assert.equal(settings.errors.length, 1)
  assert.match(settings.errors[0] ?? '', /不支持 option/)
})

test('lets a later entry with the same name win', () => {
  const settings = Sources.settings({
    sources: ['mall=dm://SYSDBA@10.0.0.5/BIZ', 'mall=pg://readonly@10.0.0.7/analytics'],
  })
  assert.equal(settings.sources.length, 1)
  assert.equal(settings.sources[0]?.dialect, 'pg')
  assert.equal(settings.sources[0]?.database, 'analytics')
})

test('reports bad entries instead of dropping them silently', () => {
  const settings = Sources.settings({ sources: ['mongodb://host/db', 'name=broken'] })
  assert.deepEqual(settings.sources, [])
  assert.equal(settings.errors.length, 2)
})

test('names the password environment variable and credential key', () => {
  const settings = Sources.settings({ sources: ['report prod=pg://readonly@host/db'] })
  assert.equal(Sources.passwordEnv(settings.sources[0]), 'DBRO_REPORT_PROD_PASSWORD')
})

test('passes configured python and row limits through', () => {
  const settings = Sources.settings({ python: 'python3.12', timeout: 12, maxRows: 50, defaultSource: 'biz' })
  assert.equal(settings.python, 'python3.12')
  assert.equal(settings.timeout, 12)
  assert.equal(settings.maxRows, 50)
  assert.equal(settings.defaultSource, 'biz')
})

test('escapes a single quote in a compared literal', () => {
  assert.equal(Dialects.literal("o'brien"), "'o''brien'")
  assert.ok(Dialects.columns('pg', "t'1").includes("table_name = 't''1'"))
})

test('uses each engine catalogue', () => {
  assert.ok(Dialects.tables('dm', 'BIZ').includes('all_tables'))
  assert.ok(Dialects.tables('dm').includes('user_tables'))
  assert.ok(Dialects.tables('mysql').includes('DATABASE()'))
  assert.ok(Dialects.tables('pg', 'report').includes('information_schema.tables'))
  assert.ok(Dialects.tables('oracle', 'BIZ').includes('all_tables'), 'Oracle shares the 达梦 data-dictionary query')
  assert.ok(Dialects.tables('mssql').includes('INFORMATION_SCHEMA'), 'SQL Server without a schema filter skips its own catalogue')
  assert.ok(Dialects.tables('sqlite').includes('sqlite_master'))
  assert.ok(Dialects.columns('dm', 'orders', 'BIZ').includes('all_tab_columns'))
  assert.ok(Dialects.columns('mysql', 'orders').includes('information_schema.columns'))
  assert.ok(Dialects.columns('pg', 'orders').includes('current_schema()'))
  assert.ok(Dialects.columns('oracle', 'orders', 'BIZ').includes('upper('))
  assert.ok(Dialects.columns('mssql', 'orders', 'dbo').includes('table_schema'))
  assert.ok(Dialects.columns('sqlite', 'orders').includes('pragma_table_info'))
})

test('keeps database and schema apart only where the engine does', () => {
  for (const dialect of ['dm', 'mysql', 'oracle'])
    assert.ok(Dialects.SCHEMA_IS_DATABASE.has(dialect), `${dialect} reuses database as the schema filter`)
  for (const dialect of ['pg', 'mssql', 'sqlite'])
    assert.ok(!Dialects.SCHEMA_IS_DATABASE.has(dialect), `${dialect} names a catalog, not a schema`)
})

test('routes every engine to one gate and executor', () => {
  assert.deepEqual(Dialects.VALUES.map((id) => Dialects.familyOf(id)),
    ['sql', 'sql', 'sql', 'sql', 'sql', 'sql', 'kv', 'search'])
  for (const dialect of Dialects.VALUES) {
    assert.ok(Dialects.SCRIPTS.includes(Dialects.GATE[dialect]), `${dialect} gate is shipped`)
    assert.ok(Dialects.SCRIPTS.includes(Dialects.EXECUTOR[dialect]), `${dialect} executor is shipped`)
  }
  assert.equal(Dialects.GATE.redis, 'dbro_kv.py')
  assert.equal(Dialects.GATE.es, 'dbro_search.py')
  assert.equal(Dialects.PASSWORD_ENV.sqlite, undefined, 'SQLite has no password')
  assert.ok(Dialects.REQUIRES_DATABASE.has('sqlite'))
  assert.ok(!Dialects.REQUIRES_DATABASE.has('es'))
})

test('locates the bundled python scripts from the plugin root', () => {
  const pluginRoot = join(import.meta.dirname, '..')
  const directory = Executor.locate(pluginRoot)
  assert.equal(directory, join(pluginRoot, 'python'))
  assert.equal(Executor.scriptPath(directory), join(directory, 'dbro', 'dbro.py'))
})

test('registers the bundled skill with a source the loader accepts', () => {
  const registered = []
  registerSkill({ register: (skill) => { registered.push(skill) } }, join(import.meta.dirname, '..'))
  assert.equal(registered.length, 1)
  const [skill] = registered
  assert.equal(skill.name, SKILL_NAME)
  // Registration passes without `source`, loading then fails with SKILL_INVALID_DEFINITION:
  // the registry passes this field straight through to the load-path check.
  assert.equal(skill.source, 'runtime')
  assert.ok(skill.content.startsWith('# DBRO'), 'frontmatter must stay off the body')
})

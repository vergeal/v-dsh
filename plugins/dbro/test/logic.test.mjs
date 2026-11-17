/**
 * Behavior checks for the pure parts of the port: source parsing, dialect SQL, and executor script location.
 * Run with `node --test plugins/dbro/test/logic.test.mjs`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import * as Dialects from '../src/dialects.js'
import * as Executor from '../src/executor.js'
import * as Sources from '../src/sources.js'

test('parses URL shorthand and defaults the port, user and name', () => {
  const settings = Sources.settings({ sources: ['mysql://readonly@10.0.0.6/mall'] })
  assert.deepEqual(settings.errors, [])
  assert.deepEqual(settings.sources, [
    { name: 'mysql:10.0.0.6/mall', dialect: 'mysql', host: '10.0.0.6', port: 3306, user: 'readonly', database: 'mall' },
  ])
})

test('accepts object entries with dialect defaults', () => {
  const settings = Sources.settings({ sources: [{ name: 'report', dialect: 'pg', host: '10.0.0.7', database: 'analytics' }] })
  assert.deepEqual(settings.errors, [])
  assert.deepEqual(settings.sources[0], {
    name: 'report', dialect: 'pg', host: '10.0.0.7', port: 5432, user: 'postgres', database: 'analytics',
    passwordEnv: undefined, password: undefined,
  })
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
  const settings = Sources.settings({ sources: ['oracle://host/db', 'name=broken'] })
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
  assert.ok(Dialects.columns('dm', 'orders', 'BIZ').includes('all_tab_columns'))
  assert.ok(Dialects.columns('mysql', 'orders').includes('information_schema.columns'))
  assert.ok(Dialects.columns('pg', 'orders').includes('current_schema()'))
})

test('locates the bundled python scripts from the plugin root', () => {
  const pluginRoot = join(import.meta.dirname, '..')
  const directory = Executor.locate(pluginRoot)
  assert.equal(directory, join(pluginRoot, 'python'))
  assert.equal(Executor.scriptPath(directory), join(directory, 'dbro', 'dbro.py'))
})

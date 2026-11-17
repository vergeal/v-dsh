/**
 * End-to-end check of the real production path: src/executor.js assembling arguments for a source resolved by
 * src/sources.js, running the bundled gate, against a live SQLite database.
 */
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import * as Dialects from '../src/dialects.js'
import * as Executor from '../src/executor.js'
import * as Sources from '../src/sources.js'

const DB = process.env.DSH_TEST_DB ?? 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\dbro_e2e.db'
const pluginRoot = join(import.meta.dirname, '..')

async function request(dialect, payload, argv, maxRows = 2) {
  const directory = Executor.locate(pluginRoot)
  assert.ok(directory, 'locate() finds the bundled python directory')
  const outcome = await Executor.run({
    dialect,
    gate: Dialects.GATE[dialect],
    argv,
    input: payload,
    python: process.env.DSH_TEST_PYTHON ?? 'python',
    directory,
    host: '', port: 0, user: '',
    database: DB,
    timeout: 20,
    maxRows,
    password: undefined,
    options: {},
  })
  return outcome
}

const results = []
function record(label, outcome, assertions) {
  results.push({ label, exit: outcome.exitCode, out: outcome.stdout.trim(), err: outcome.stderr.trim(), assertions })
}

// 1. plain select through the gate
record('select', await request('sqlite', 'select id, name, org from users order by id'), (r) => {
  assert.equal(r.exit, 0)
  assert.match(r.out, /alice/)
})

// 2. the exact SQL dbro_columns generates for SQLite, quotes and all
const columnsSql = Dialects.columns('sqlite', 'users')
record('dbro_columns SQL', await request('sqlite', columnsSql), (r) => {
  assert.equal(r.exit, 0, `columns failed: ${r.err}`)
  assert.match(r.out, /not_null|notnull/)
  assert.match(r.out, /id/)
})

// 3. the exact SQL dbro_tables generates for SQLite; the default cap of 2 would hide the third object
const tablesSql = Dialects.tables('sqlite')
record('dbro_tables SQL', await request('sqlite', tablesSql, undefined, 50), (r) => {
  assert.equal(r.exit, 0, `tables failed: ${r.err}`)
  assert.match(r.out, /users/)
  assert.match(r.out, /v_users/, 'views are listed too')
  assert.doesNotMatch(r.out, /sqlite_/i, 'internal tables stay hidden')
})

// 4. maxRows cap actually truncates (3 rows exist, cap is 2)
record('max-rows cap', await request('sqlite', 'select id from users order by id'), (r) => {
  assert.equal(r.exit, 0)
  assert.match(r.out, /\(2 rows\)/)
  assert.match(r.err, /max-rows/)
})

// 5. write attempt is refused by the gate before any connection
record('gate rejects write', await request('sqlite', 'delete from users'), (r) => {
  assert.equal(r.exit, 3)
  assert.match(r.err, /只允许/)
})

// 6. multi-statement is refused
record('gate rejects multi', await request('sqlite', 'select 1; select 2'), (r) => {
  assert.equal(r.exit, 3)
})

// 7. Chinese row data and Chinese gate diagnostics survive the child process
record('chinese data', await request('sqlite', 'select id, body from notes order by id'), (r) => {
  assert.equal(r.exit, 0, `query failed: ${r.err}`)
  assert.match(r.out, /只读入口测试/, 'row data arrives as UTF-8')
  assert.match(r.out, /达梦与PostgreSQL/)
})

for (const { label, exit, out, err, assertions } of results) {
  try {
    assertions({ exit, out, err })
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label}: ${error.message}`)
    console.log(`   exit=${exit} stdout=${JSON.stringify(out.slice(0, 300))} stderr=${JSON.stringify(err.slice(0, 300))}`)
    process.exitCode = 1
  }
}

// Prove the table really is untouched afterwards.
const after = await request('sqlite', 'select count(*) as n from users')
try {
  assert.equal(after.exitCode, 0)
  assert.match(after.stdout, /\|\s*3\s*\|/, 'row count still 3')
  console.log('ok   database unchanged (3 rows)')
} catch (error) {
  console.log(`FAIL database unchanged: ${error.message} :: ${after.stdout}${after.stderr}`)
  process.exitCode = 1
}

console.log(process.exitCode ? '\nE2E FAILURES' : '\nE2E OK')

/**
 * Run the bundled Python gates and executors. Each gate owns its read-only admission: `dbro.py` for one SQL
 * statement, `dbro_kv.py` for one whitelisted Redis command, `dbro_search.py` for one Elasticsearch operation. This
 * module never adds `--force`, `--allow-write`, or a write method, so the plugin cannot widen those gates.
 * @module dbro/executor
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as Dialects from './dialects.js'
import { DBRO_ERRORS, DbroError } from './errors.js'

/** Cap on rendered output returned to the model; every gate also caps its own row count. */
export const MAX_OUTPUT = 200_000

/** Extra wall-clock time granted beyond the SQL timeout before the child is killed. */
const KILL_GRACE_MS = 5_000

/**
 * Resolve the directory holding the gates and executors. The bundle ships them under `python/`, and
 * `toolDirectory` is the explicit override for a relocated checkout.
 * @param {string} pluginRoot - the installed plugin directory.
 * @param {string} [configured] - explicit `toolDirectory` setting.
 * @returns {string|undefined} the directory, or `undefined` when the scripts are missing.
 */
export function locate(pluginRoot, configured) {
  const candidates = [configured, join(pluginRoot, 'python')].filter((path) => Boolean(path))
  return candidates.find((path) => existsSync(scriptIn(path)))
}

function scriptIn(directory) {
  const flat = join(directory, 'dbro.py')
  return existsSync(flat) ? flat : join(directory, 'dbro', 'dbro.py')
}

/**
 * @param {string} directory - directory resolved by {@link locate}.
 * @param {string} name - script file name.
 * @returns {string} the candidate path, preferring the bundled `dbro/` subdirectory.
 */
function scriptNamed(directory, name) {
  const nested = join(directory, 'dbro', name)
  return existsSync(nested) ? nested : join(directory, name)
}

/**
 * @param {string} directory - directory resolved by {@link locate}.
 * @returns {string|undefined} the `dbro.py` entry script.
 */
export function scriptPath(directory) {
  const script = scriptNamed(directory, 'dbro.py')
  return existsSync(script) ? script : undefined
}

/**
 * @typedef {object} Run
 * @property {import('./dialects.js').Dialect} dialect - target engine.
 * @property {string} gate - gate script to run, from {@link Dialects.GATE}.
 * @property {string} input - payload on standard input: one SQL statement, one Redis command, or one JSON body.
 * @property {string[]} [argv] - extra gate arguments, such as the Elasticsearch operation and index.
 * @property {string} python - Python interpreter.
 * @property {string} directory - directory resolved by {@link locate}.
 * @property {string} [host] - host override.
 * @property {number} [port] - port override.
 * @property {string} [user] - user override.
 * @property {string} [database] - database, schema, file path, db index, or index pattern.
 * @property {number} timeout - statement timeout in seconds.
 * @property {number} maxRows - row cap for every executor.
 * @property {string} [password] - password passed through the executor's environment variable.
 * @property {Record<string, string>} [options] - connection option variables, from {@link Sources.optionEnv}.
 * @property {AbortSignal} [signal] - caller cancellation.
 */

/**
 * @typedef {object} Outcome
 * @property {string} stdout - captured standard output, capped at {@link MAX_OUTPUT}.
 * @property {string} stderr - captured standard error, capped at {@link MAX_OUTPUT}.
 * @property {number} exitCode - child exit code, or -1 when it ended without one.
 * @property {number} durationMs - wall-clock duration.
 * @property {boolean} truncated - whether either stream hit the cap.
 * @property {boolean} timedOut - whether the timeout killed the child.
 */

/**
 * Run one read-only request through its gate. The payload goes through stdin because argv has a platform size limit
 * and a 100k-character query with Chinese literals can exceed it.
 * @param {Run} input - connection, payload, and cancellation details.
 * @returns {Promise<Outcome>} the child's streams and exit status.
 * @throws {DbroError} `DBRO_SCRIPTS_NOT_FOUND` or `DBRO_PYTHON_NOT_FOUND` when the launch cannot start.
 */
export async function run(input) {
  const script = scriptNamed(input.directory, input.gate)
  if (!existsSync(script))
    throw new DbroError(`找不到 ${input.gate}：${input.directory}。重新安装插件，或用 toolDirectory 指向脚本目录。`, DBRO_ERRORS.SCRIPTS_NOT_FOUND)

  // Gates write Chinese diagnostics and, for some engines, Chinese row data. On Windows a child Python inherits the
  // console code page (cp936 on a zh_CN host) and its output arrives as mojibake once decoded as UTF-8 here, so the
  // interpreter is pinned to UTF-8 unless the caller already set it.
  const env = { PYTHONIOENCODING: 'utf-8', ...process.env, ...(input.options ?? {}) }
  const passwordEnv = Dialects.PASSWORD_ENV[input.dialect]
  if (input.password !== undefined && passwordEnv) env[passwordEnv] = input.password

  const outcome = await capture(input.python, argumentsFor(script, input), {
    input: input.input,
    timeoutMs: Math.max(1, input.timeout) * 1000 + KILL_GRACE_MS,
    signal: input.signal,
    env,
  })
  if (outcome.signalAborted) input.signal?.throwIfAborted()
  return outcome
}

/**
 * Assemble the gate's command line. The three families differ: the SQL gate takes the dialect as a positional and a
 * server address, the Redis gate takes only address flags, and the Elasticsearch gate takes an operation positional
 * plus an index pattern, reading the request body from stdin.
 * @param {string} script - gate script path.
 * @param {Run} input - resolved target.
 * @returns {string[]} interpreter arguments.
 */
function argumentsFor(script, input) {
  const args = [script]
  const family = Dialects.familyOf(input.dialect)
  if (family === 'sql') args.push(input.dialect)
  else args.push(...(input.argv ?? []))

  const addressed = family !== 'sql' || !Dialects.FILE_DIALECTS.has(input.dialect)
  if (addressed) {
    if (input.host) args.push('-H', input.host)
    if (input.port !== undefined && input.port > 0) args.push('-P', String(input.port))
    if (input.user) args.push('-u', input.user)
  }
  if (input.database) args.push(family === 'search' ? '-i' : '-d', input.database)
  args.push('--timeout', String(input.timeout), '--max-rows', String(input.maxRows))
  return args
}

/**
 * @typedef {object} Probe
 * @property {string} python - the interpreter that was probed.
 * @property {string} [version] - first line of `python --version`.
 * @property {Record<string, boolean>} drivers - importability of every driver named in {@link Dialects.DRIVER}.
 * @property {string} [error] - why the probe failed, when it did.
 */

/**
 * Check the interpreter and each driver without importing it, so a broken dmPython install cannot fail the whole
 * probe.
 * @param {string} python - Python interpreter.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Probe>} interpreter version and driver availability.
 */
export async function probe(python, signal) {
  const drivers = [...new Set(Object.values(Dialects.DRIVER))]
  const script = [
    'import importlib.util, json',
    'print(json.dumps({name: importlib.util.find_spec(name) is not None for name in %s}))' % JSON.stringify(drivers),
  ].join('\n')

  try {
    const version = await capture(python, ['--version'], { signal })
    if (version.exitCode !== 0) throw new DbroError(version.stderr.trim() || `${python} 退出码 ${version.exitCode}`, DBRO_ERRORS.PROBE_FAILED)
    const drivers = await capture(python, ['-c', script], { signal })
    if (drivers.exitCode !== 0) throw new DbroError(drivers.stderr.trim() || `${python} 退出码 ${drivers.exitCode}`, DBRO_ERRORS.PROBE_FAILED)
    return {
      python,
      version: version.stdout.trim().split('\n')[0],
      drivers: JSON.parse(drivers.stdout.trim() || '{}'),
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    return { python, drivers: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

function spawnError(python, error) {
  if (error?.code === 'ENOENT')
    return new DbroError(`找不到 Python 解释器「${python}」。安装 python3，或在插件设置里把 python 指向可执行文件。`, DBRO_ERRORS.PYTHON_NOT_FOUND, { cause: error })
  return new DbroError(`启动 Python 解释器「${python}」失败：${error instanceof Error ? error.message : String(error)}`, DBRO_ERRORS.PYTHON_FAILED, { cause: error })
}

function capture(python, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let child
    try {
      child = spawn(python, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(spawnError(python, error))
      return
    }

    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    let timedOut = false
    let signalAborted = false
    let killTimer
    const abort = () => {
      signalAborted = true
      child.kill('SIGTERM')
    }
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })

    // A write that races process exit reports EPIPE; the exit code and stderr carry the real outcome.
    child.stdin.on('error', () => {})

    child.on('error', (error) => {
      cleanup()
      reject(spawnError(python, error))
    })
    child.on('close', (code) => {
      cleanup()
      resolve({
        stdout: stdout().text,
        stderr: stderr().text,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        truncated: stdout().truncated || stderr().truncated,
        timedOut,
        signalAborted,
      })
    })

    function cleanup() {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
    }

    try {
      child.stdin.write(options.input ?? '')
      child.stdin.end()
    } catch {
      // The child may have exited before reading; its exit code and stderr carry the real reason.
    }
  })
}

function collect(stream) {
  const chunks = []
  let size = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (size >= MAX_OUTPUT) {
      truncated = true
      return
    }
    const room = MAX_OUTPUT - size
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room))
      size = MAX_OUTPUT
      truncated = true
      return
    }
    chunks.push(chunk)
    size += chunk.length
  })
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated })
}

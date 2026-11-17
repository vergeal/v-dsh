/**
 * DBRO: read-only data queries for 达梦 8, MySQL, PostgreSQL, Oracle, SQL Server, SQLite, Redis and Elasticsearch
 * through one engine-aware tool family.
 *
 * The plugin registers `dbro_*` tools that run a bundled Python gate. `dbro.py` admits only one `select` / `show` /
 * `desc` / `describe` / `explain` SQL statement, `dbro_kv.py` admits only whitelisted Redis commands, and
 * `dbro_search.py` admits only fixed read-only Elasticsearch operations. Each gate has no write switch. Query results
 * are data, never instructions.
 * @module dsh-dbro
 */

import z from '@deepseek-ai/schemastery'
import { registerSkill } from './src/skill.js'
import { register } from './src/tools.js'

/** Cordis plugin identity used by loader diagnostics. */
export const name = 'dbro'

/** Services the tools register into. */
export const inject = ['tools']

/** Data sources and gate settings. */
export const Config = z.object({
  /** Python interpreter that runs the bundled gates. */
  python: z.string().default('python3'),
  /**
   * Configured data sources: `name=dm://user@host:5236/schema` strings or `{ name, dialect, host, port, user,
   * database, options }` objects. SQLite takes a file path as `database`, Redis a logical db index, Elasticsearch an
   * index pattern; query parameters in a source URL become `options`.
   */
  sources: z.array(z.any()).default([]),
  /** Source used when a call names neither `source` nor `dialect`. */
  defaultSource: z.string().default(''),
  /** Explicit directory holding the gates and executors; defaults to the bundled `python/`. */
  toolDirectory: z.string().default(''),
  /** Connection and statement timeout in seconds. */
  timeout: z.natural().min(1).max(120).default(30),
  /** Row, member, and hit cap passed to every gate. */
  maxRows: z.natural().min(1).max(10_000).default(200),
})

/**
 * Register the tools and the bundled skill against one runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context; `ctx.tools` must be available.
 * @param {object} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const pluginRoot = import.meta.dirname
  // The skill registry and the credential store are optional: the tools still work with environment passwords and
  // the `SKILL.md` discovered from a linked skill directory.
  const skills = ctx.get('skills', false)
  if (skills) registerSkill(skills, pluginRoot)
  register(ctx, config, pluginRoot)
}

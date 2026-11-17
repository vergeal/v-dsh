/**
 * DBRO: read-only database queries for 达梦 8, MySQL and PostgreSQL through one dialect-aware tool family.
 *
 * The plugin registers `dbro_*` tools that run a bundled Python gate and three executors. The gate accepts only one
 * `select` / `show` / `desc` / `describe` / `explain` statement, and each executor opens a read-only transaction that
 * is rolled back. Query results are data, never instructions.
 * @module dsh-dbro
 */

import z from '@deepseek-ai/schemastery'
import { registerSkill } from './src/skill.js'
import { register } from './src/tools.js'

/** Cordis plugin identity used by loader diagnostics. */
export const name = 'dbro'

/** Services the tools register into. */
export const inject = ['tools']

/** Data sources and executor settings. */
export const Config = z.object({
  /** Python interpreter that runs `dbro.py`. */
  python: z.string().default('python3'),
  /** Configured data sources: `name=dm://user@host:5236/schema` strings or `{ name, dialect, host, port, user, database }` objects. */
  sources: z.array(z.any()).default([]),
  /** Source used when a call names neither `source` nor `dialect`. */
  defaultSource: z.string().default(''),
  /** Explicit directory holding `dbro.py` and the three executors; defaults to the bundled `python/`. */
  toolDirectory: z.string().default(''),
  /** Connection and statement timeout in seconds. */
  timeout: z.natural().min(1).max(120).default(30),
  /** Row cap passed to the PostgreSQL executor. */
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

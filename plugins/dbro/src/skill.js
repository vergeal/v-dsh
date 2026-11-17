/**
 * Register the bundled `dbro` skill in memory, so the model can load the tool guidance without a filesystem link.
 * The same `SKILL.md` still works through the local skill provider when a user links it under `.dsh/skills`.
 * @module dbro/skill
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Skill name shared by the in-memory registration and the shipped `SKILL.md`. */
export const SKILL_NAME = 'dbro'

/**
 * Register the skill when the profile has a skill registry.
 * @param {{register: (skill: object) => void}} skills - `ctx.skills` from the profile.
 * @param {string} pluginRoot - installed plugin directory.
 */
export function registerSkill(skills, pluginRoot) {
  const file = join(pluginRoot, 'skills', SKILL_NAME, 'SKILL.md')
  const { name, description, body } = parseSkill(readFileSync(file, 'utf8'))
  skills.register({ name, description, content: body })
}

function parseSkill(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) throw new Error('skills/dbro/SKILL.md 缺少 YAML frontmatter。')
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  if (!name || !description) throw new Error('skills/dbro/SKILL.md 的 frontmatter 必须包含 name 和 description。')
  return { name, description, body: source.slice(match[0].length).trimStart() }
}

/**
 * 把随包的 `hyt-im` 技能注册进内存，模型无需文件系统链接即可加载工具指引。
 * 同一份 `SKILL.md` 仍可被本地技能提供者发现（用户把它链到 `.dsh/skills` 时）。
 * @module hyt-im/skill
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内存注册与随包 `SKILL.md` 共用的技能名。 */
export const SKILL_NAME = 'hyt-im'

/**
 * 在 profile 有技能注册表时注册技能。
 * @param {{register: (skill: object) => void}} skills - 来自 profile 的 `ctx.skills`。
 * @param {string} pluginRoot - 已安装的插件目录。
 */
export function registerSkill(skills, pluginRoot) {
  const file = join(pluginRoot, 'skills', SKILL_NAME, 'SKILL.md')
  const { name, description, body } = parseSkill(readFileSync(file, 'utf8'))
  // `source` 必填：注册表原样透传给加载路径校验，缺它会让技能注册成功但加载报
  // SKILL_INVALID_DEFINITION。与 provider 的默认值 'runtime' 对齐。
  skills.register({ name, description, content: body, source: 'runtime' })
}

function parseSkill(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) throw new Error('skills/hyt-im/SKILL.md 缺少 YAML frontmatter。')
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  if (!name || !description) throw new Error('skills/hyt-im/SKILL.md 的 frontmatter 必须包含 name 和 description。')
  return { name, description, body: source.slice(match[0].length).trimStart() }
}

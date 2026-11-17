/**
 * 装配检查：编译 Config、用桩 context 跑一遍 apply，确认 6 个工具和随包技能都带着完整定义注册。
 * 运行：`node plugins/hyt-im/test/register.mjs`。
 *
 * 这里不碰消息库：工具注册只登记 schema，连库发生在 execute。
 */
import { apply, Config, inject, name } from '../index.js'

const tools = []
const skills = []
const ctx = {
  get(service) {
    if (service === 'skills') return { register(skill) { skills.push(skill); return () => {} } }
    return undefined
  },
  tools: { register(tool) { tools.push(tool); return () => {} } },
}
const config = Config({})

apply(ctx, config)

console.log('plugin:', name, '| inject:', inject.join(','))
console.log('config:', JSON.stringify(config))
console.log('registered tools:', tools.length)
for (const tool of tools) console.log(' -', tool.name)

const expected = ['hyt_accounts', 'hyt_sessions', 'hyt_messages', 'hyt_search', 'hyt_stats', 'hyt_overview', 'hyt_new']
if (tools.length !== expected.length) throw new Error(`expected ${expected.length} tools, got ${tools.length}`)
for (const toolName of expected) {
  if (!tools.some(tool => tool.name === toolName)) throw new Error('missing tool ' + toolName)
}
for (const tool of tools) {
  if (typeof tool.description !== 'string' || tool.description.length < 10) throw new Error('bad description ' + tool.name)
  if (!tool.parameters || !tool.output || typeof tool.output.render !== 'function') throw new Error('missing schema ' + tool.name)
  if (tool.name === 'hyt_search' && tool.parameters.keyword?.required !== true) {
    throw new Error('hyt_search keyword must be required')
  }
}

if (skills.length !== 1) throw new Error(`expected 1 skill, got ${skills.length}`)
const [skill] = skills
if (skill.name !== 'hyt-im') throw new Error('bad skill name ' + skill.name)
if (!skill.content.startsWith('# 虹云通本地消息查询')) throw new Error('skill content kept its frontmatter')
// 回归锁：注册表把 source 原样透传给加载路径校验，缺它技能能注册但加载报
// SKILL_INVALID_DEFINITION，而注册期不报错——只有这里能拦住。
if (skill.source !== 'runtime') throw new Error(`skill.source must be 'runtime', got ${JSON.stringify(skill.source)}`)
if (typeof skill.description !== 'string' || skill.description.length < 10) throw new Error('bad skill description')
console.log('skill:', skill.name, '| source:', skill.source, '| bytes:', skill.content.length)
console.log('OK')

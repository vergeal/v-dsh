/**
 * Registration check: compile the Config, apply the plugin against a stub context, and confirm every tool and the
 * bundled skill register with complete schemas. Run with `node plugins/dbro/test/register.mjs`.
 */
import { Config, apply, inject, name } from '../index.js'

const tools = []
const skills = []
const ctx = {
  get(service) {
    if (service === 'skills') return { register(skill) { skills.push(skill); return () => {} } }
    return undefined
  },
  tools: { register(tool) { tools.push(tool); return () => {} } },
}
const config = Config({ sources: ['biz=dm://SYSDBA@10.0.0.5:5236/BIZ', 'app=sqlite:///D:/data/app.db', 'cache=redis://10.0.0.9/2', 'logs=es://readonly@10.0.0.10/logs-*?tls=1'] })

apply(ctx, config)

console.log('plugin:', name, '| inject:', inject.join(','))
console.log('config:', JSON.stringify(config))
console.log('registered tools:', tools.length)
for (const tool of tools) console.log(' -', tool.name)

const expected = [
  'dbro_sources', 'dbro_query', 'dbro_tables', 'dbro_columns',
  'dbro_kv_command', 'dbro_kv_scan',
  'dbro_search_query', 'dbro_search_indices', 'dbro_search_mapping', 'dbro_search_cluster',
  'dbro_doctor',
]
if (tools.length !== expected.length) throw new Error(`expected ${expected.length} tools, got ${tools.length}`)
for (const toolName of expected) {
  if (!tools.some((tool) => tool.name === toolName)) throw new Error('missing tool ' + toolName)
}
for (const tool of tools) {
  if (typeof tool.description !== 'string' || tool.description.length < 10) throw new Error('bad description ' + tool.name)
  if (!tool.parameters || !tool.output || typeof tool.output.render !== 'function') throw new Error('missing schema ' + tool.name)
}
if (skills.length !== 1) throw new Error(`expected 1 skill, got ${skills.length}`)
const [skill] = skills
if (skill.name !== 'dbro') throw new Error('bad skill name ' + skill.name)
if (!skill.content.startsWith('# DBRO')) throw new Error('skill content kept its frontmatter')
console.log('skill:', skill.name, '| bytes:', skill.content.length)
console.log('OK')

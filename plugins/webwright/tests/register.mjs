import { apply, name, inject, Config } from '../index.js'

const tools = []
const disposers = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  tools: { register(tool) { tools.push(tool); return () => {} } },
}

apply(ctx, {})

console.log('plugin:', name, '| inject:', inject.join(','))
console.log('registered tools:', tools.length)
for (const tool of tools) console.log(' -', tool.name)
if (tools.length !== 27) throw new Error('expected 27 tools, got ' + tools.length)
for (const tool of tools) {
  if (!tool.name.startsWith('webwright_')) throw new Error('bad name ' + tool.name)
  if (typeof tool.description !== 'string' || tool.description.length < 10) throw new Error('bad description ' + tool.name)
  if (!tool.parameters || !tool.output) throw new Error('missing schema ' + tool.name)
}
const fillForm = tools.find((tool) => tool.name === 'webwright_fill_form')
console.log('fill_form params:', JSON.stringify(fillForm.parameters).slice(0, 240))
console.log('disposers:', disposers.length)
for (const dispose of disposers) await dispose()
console.log('OK')

/**
 * think-zh — force Chinese thinking and a per-step progress sentence.
 *
 * Registers its own prompt-section name (`deployment:think-zh`), so an agent
 * preset's `persona` row — which shadows `deployment:persona-suffix` — cannot
 * remove it. Registering on the deployment context makes it a global section:
 * every agent scope inherits it, and the prompt registry re-renders sections on
 * every model step.
 */

/** Cordis plugin name. */
export const name = 'think-zh'

/** The prompt registry this instruction contributes to. */
export const inject = ['systemPrompt']

/** The instruction every model step receives. */
export const TEXT = '【强制要求一】你的全部内部思考（reasoning）必须使用中文，禁止使用英文思考。你给用户的回复也必须使用中文。'
  + '【强制要求二】每个 step 在调用任何工具之前，你必须先输出一句简短的中文正文'
  + '（普通文本，不是思考内容），说明你正在做什么或刚发现了什么。'
  + '用户看不到你的思考过程，缺少这句正文，用户就完全不知道任务进度，这是不允许的。'
  + '不要在一个 step 里连续调用多个工具而不先写这句正文。'

/**
 * Register the think-zh section before all first-party tool guidance.
 * @param ctx - the deployment context carrying the prompt registry.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:think-zh',
    order: 1,
    text: TEXT,
  }), 'think-zh.section()')
}

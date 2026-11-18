/**
 * briefing — Chinese reasoning with a short progress briefing at key steps.
 *
 * Registers its own prompt-section name (`deployment:briefing`), so an agent
 * preset's `persona` row — which shadows `deployment:persona-suffix` — cannot
 * remove it. Registering on the deployment context makes it a global section:
 * every agent scope inherits it, and the prompt registry re-renders sections on
 * every model step.
 */

/** Cordis plugin name. */
export const name = 'briefing'

/** The prompt registry this instruction contributes to. */
export const inject = ['systemPrompt']

/** The instruction every model step receives. */
export const TEXT = '【强制要求一】你的全部内部思考（reasoning）必须使用中文，禁止使用英文思考。你给用户的回复也必须使用中文。'
  + '【强制要求二】进度汇报：在关键 step 调用工具前，输出一句不超过 20 字的中文正文（只此一句，'
  + '不解释、不列点、不复述工具参数）。必须汇报的时机：开始新任务或新阶段、发现关键结果或异常、'
  + '改变方向、收尾结论。可以跳过汇报的时机：与前一步同属一个动作的连续机械性小操作（如接着读'
  + '下一个文件、重复同类命令），跳过时任务主线不能有任何变化。整段任务中大约一半 step 带一句'
  + '即可，不要每个 step 都刷。'

/**
 * Register the briefing section before all first-party tool guidance.
 * @param ctx - the deployment context carrying the prompt registry.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:briefing',
    order: 1,
    text: TEXT,
  }), 'briefing.section()')
}

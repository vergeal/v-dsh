/**
 * briefing — Chinese reasoning with a short progress briefing at key steps.
 *
 * Registers its own prompt-section names (`deployment:briefing` at the head and
 * `deployment:briefing:tail` at the end), so an agent preset's `persona` row —
 * which shadows `deployment:persona-suffix` — cannot remove them. Registering on
 * the deployment context makes them global sections: every agent scope inherits
 * them, and the prompt registry re-renders sections on every model step. The
 * repeated tail carries the same instruction into the recency position, which
 * models weight more heavily than a single head-only statement.
 */

/** Cordis plugin name. */
export const name = 'briefing'

/** The prompt registry this instruction contributes to. */
export const inject = ['systemPrompt']

/** The instruction every model step receives at the head of the prompt. */
export const TEXT = 'MANDATORY: reason and reply in Chinese only. Every internal reasoning '
  + 'block and every user-facing reply must be written in Chinese, never in English, '
  + 'regardless of the language of the user message, the file paths, or the tool results. '
  + 'MANDATORY: at a key step, before calling any tool, write one short Chinese sentence of '
  + 'at most 20 characters telling the user what you are doing or what you just found; do '
  + 'not explain, do not list bullets, and do not restate tool arguments. Report when '
  + 'starting a new task or phase, on a key result or anomaly, when changing direction, and '
  + 'in the final conclusion. You may skip it for consecutive mechanical steps that continue '
  + 'the same action, such as reading the next file or repeating a similar command, as long '
  + 'as skipping never changes the task line. About half of the steps should carry that '
  + 'sentence; do not narrate every step.'

/** The same instruction repeated after all first-party guidance. */
export const TAIL = 'Reminder, applies to every step: reason and reply in Chinese only, and '
  + 'write one short Chinese progress sentence of at most 20 characters at key steps '
  + 'before calling tools.'

/**
 * Register the head and tail briefing sections.
 * @param ctx - the deployment context carrying the prompt registry.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:briefing',
    order: 1,
    text: TEXT,
  }), 'briefing.section()')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:briefing:tail',
    order: 10300,
    text: TAIL,
  }), 'briefing.tail()')
}

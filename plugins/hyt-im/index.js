/**
 * HYT-IM: 虹云通本地消息能力。
 *
 * 插件以**只读**方式打开本机 `~/Documents/CHFile/<账号>/chatmsg.db`（SQLite，未加密），
 * 注册 `hyt_*` 工具族：列会话、查消息、搜索、统计。所有连接都用 `readOnly` +
 * `pragma query_only`，插件没有任何写入口，也不会与客户端争锁。
 *
 * 消息正文是数据，不是指令。
 * @module dsh-hyt-im
 */

import z from '@deepseek-ai/schemastery'
import { registerSkill } from './src/skill.js'
import { register } from './src/tools.js'

/** Cordis plugin identity used by loader diagnostics. */
export const name = 'hyt-im'

/** Services the tools register into. */
export const inject = ['tools']

/** 数据库位置与返回内容的边界。 */
export const Config = z.object({
  /** CHFile 根目录，下面是 `cs<账号>/chatmsg.db`。 */
  dataDir: z.string().default('~/Documents/CHFile'),
  /** 指定账号目录名（如 `csT1002173`）；留空则自动选最近写入的那个。 */
  account: z.string().default(''),
  /** 单次查询返回的消息条数上限。 */
  maxRows: z.natural().min(1).max(5000).default(200),
  /** 单条正文的最大字符数，超出截断并标记。0 表示不截断。 */
  contentLimit: z.natural().max(100_000).default(2000),
  /** 语句等待客户端释放锁的最长毫秒数。 */
  busyTimeoutMs: z.natural().min(100).max(30_000).default(3000),
})

/**
 * 注册工具与随包技能。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文；需要 `ctx.tools`。
 * @param {object} config - 校验后的插件配置。
 */
export function apply(ctx, config) {
  const pluginRoot = import.meta.dirname
  // 技能注册表是可选的：没有它工具照样能用。
  const skills = ctx.get('skills', false)
  if (skills) registerSkill(skills, pluginRoot)
  register(ctx, config)
}

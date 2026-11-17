/**
 * 增量消费的内存游标。
 *
 * 状态归插件 fiber：`tools.js` 的 `register()` 里建一个实例，工具闭包持有它。不放在
 * 模块顶层，因为插件可以被 profile 重载，模块活得比 fiber 久就会把上一次的游标串过来。
 *
 * 游标不持久化，进程重启后回到未初始化，第一次 `hyt_new` 重新以当前 `maxId` 立基线。
 * 要接续重启前的位置，用 `set` 显式给 Id。
 * @module hyt-im/cursor
 */

/**
 * 建一个游标状态机。
 * @returns {{
 *   readonly value: number,
 *   readonly initialized: boolean,
 *   init: (maxId: number) => boolean,
 *   set: (id: number) => number,
 *   advance: (id: number) => void,
 * }} 游标句柄。
 */
export function createCursor() {
  let value = 0
  let initialized = false
  return {
    /** 已消费到的 Id；未初始化时是 0。 */
    get value() {
      return value
    },
    /** 是否已经立过基线。 */
    get initialized() {
      return initialized
    },
    /**
     * 没立过基线就以当前库水位立一个，之后只报基线之后的消息。已立过则不动。
     * @param {number} maxId - 当前库水位。
     * @returns {boolean} 本次是否刚刚建立基线；调用方据此区分「第一次」和「确实没有新消息」。
     */
    init(maxId) {
      if (initialized) return false
      value = Math.max(0, Number(maxId) || 0)
      initialized = true
      return true
    },
    /**
     * 显式设位，同时标记已初始化。用于重启后接续，或回到某个 Id 重读。
     * @param {number} id - 非负 Id。
     * @returns {number} 设成的值。
     * @throws {RangeError} 非数字或负数。
     */
    set(id) {
      const n = Number(id)
      if (!Number.isFinite(n) || n < 0) throw new RangeError(`游标 Id 必须是非负数，收到 ${JSON.stringify(id)}`)
      value = Math.floor(n)
      initialized = true
      return value
    },
    /**
     * 消费成功后推进。只朝前走；要回退请显式 `set`。
     * 空结果传 0 不会改动游标，所以调用方不需要特判。
     * @param {number} id - 本次消费到的最大 Id。
     */
    advance(id) {
      const n = Number(id) || 0
      if (n > value) value = n
    },
  }
}

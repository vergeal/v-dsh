/**
 * 本机虹云通消息库的只读访问层。
 *
 * 库是普通 SQLite（未加密，`journal_mode=delete`），客户端在持续写入，所以这里
 * 一律只读打开并设置 `busy_timeout`：实测 `select max(Id)` 约 0.6 ms，外部只读
 * 连接不会阻塞客户端写入。每次调用开短连接、用完即关，避免长期持有文件句柄。
 * @module hyt-im/store
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 消息库文件名。 */
const DB_FILE = 'chatmsg.db'

/** 通讯录库文件名，用来把账号补成昵称。 */
const ADDRESS_DB_FILE = 'AddressBookDB.db'

/**
 * 展开开头的 `~`。
 * @param {string} p - 可能以 `~` 开头的路径。
 * @returns {string} 绝对路径。
 */
export function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * 扫描 CHFile 根目录，列出所有带消息库的账号。
 * @param {string} dataDir - CHFile 根目录（已展开）。
 * @returns {Array<{account: string, dir: string, dbPath: string, bytes: number, mtimeMs: number}>} 按最近写入排序。
 */
export function findAccounts(dataDir) {
  if (!existsSync(dataDir)) return []
  const out = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(dataDir, entry.name)
    const dbPath = join(dir, DB_FILE)
    if (!existsSync(dbPath)) continue
    let st
    try {
      st = statSync(dbPath)
    } catch {
      continue
    }
    out.push({ account: entry.name, dir, dbPath, bytes: st.size, mtimeMs: st.mtimeMs })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 选定要用的账号库：配置指定优先，否则取最近写入的。
 * @param {object} config - 插件配置。
 * @returns {{account: string, dir: string, dbPath: string, bytes: number, mtimeMs: number, candidates: number}}
 * @throws {Error} 找不到任何消息库时抛错，消息里带上扫描目录。
 */
export function pickAccount(config) {
  const dataDir = expandHome(config.dataDir)
  const accounts = findAccounts(dataDir)
  if (accounts.length === 0) {
    throw new Error(`在 ${dataDir} 下没找到任何 ${DB_FILE}；确认虹云通已登录过，或把 dataDir 配到正确的 CHFile 目录。`)
  }
  const wanted = (config.account || '').trim()
  if (wanted) {
    const hit = accounts.find(a => a.account === wanted)
    if (!hit) {
      throw new Error(`配置指定的账号 ${wanted} 不存在；可选：${accounts.map(a => a.account).join(', ')}`)
    }
    return { ...hit, candidates: accounts.length }
  }
  return { ...accounts[0], candidates: accounts.length }
}

/**
 * 只读打开一个库，执行回调，然后关闭。
 *
 * `readOnly` 让 SQLite 以 `SQLITE_OPEN_READONLY` 打开，`query_only` 再兜一层：
 * 即便后续代码写错了语句也不可能有副作用。
 * @template T
 * @param {string} dbPath - 库文件绝对路径。
 * @param {number} busyTimeoutMs - 等锁上限。
 * @param {(db: DatabaseSync) => T} fn - 使用连接的回调。
 * @returns {T} 回调的返回值。
 */
export function withDb(dbPath, busyTimeoutMs, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec(`pragma busy_timeout = ${Math.max(0, busyTimeoutMs | 0)}`)
    db.exec('pragma query_only = on')
    return fn(db)
  } finally {
    try {
      db.close()
    } catch {
      // 关不掉也不影响调用方结果；句柄随进程回收。
    }
  }
}

/**
 * 在选定账号的消息库上执行只读查询。
 * @template T
 * @param {object} config - 插件配置。
 * @param {(db: DatabaseSync, account: ReturnType<typeof pickAccount>) => T} fn - 使用连接的回调。
 * @returns {T} 回调的返回值。
 */
export function withAccountDb(config, fn) {
  const account = pickAccount(config)
  return withDb(account.dbPath, config.busyTimeoutMs, db => fn(db, account))
}

/**
 * 通讯录库路径（可能不存在）。
 * @param {{dir: string}} account - 账号信息。
 * @returns {string} AddressBookDB.db 的绝对路径。
 */
export function addressBookPath(account) {
  return join(account.dir, ADDRESS_DB_FILE)
}

/**
 * 把标识符包成 SQLite 双引号形式，内部双引号按 SQL 规则翻倍转义。
 *
 * 表名来自 `sqlite_master`，不是调用方输入，但仍要正确转义：含 `"` 的表名会让
 * 拼出来的语句改变含义。
 * @param {string} name - 表名或列名。
 * @returns {string} 可嵌入 SQL 的带引号标识符。
 */
function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`
}

/**
 * 从消息库的 `keepgroup` 表读群号 → 群名。
 *
 * 通讯录 `Person` 里没有群号，所以群聊不读这张表就只能把 `g8…` 群号当名字显示。
 * 本机 `keepgroup` 只覆盖一部分会话，读不到群名的仍回退成群号。
 * @param {object} config - 插件配置。
 * @param {{dir: string, dbPath: string}} account - 账号信息。
 * @returns {Map<string, string>} 群号到群名。
 */
export function loadGroupNames(config, account) {
  const map = new Map()
  try {
    withDb(account.dbPath, config.busyTimeoutMs, (db) => {
      const present = db.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'keepgroup'").get()
      if (Number(present?.n ?? 0) === 0) return
      for (const r of db.prepare('select GroupId as g, GroupName as n from keepgroup').all()) {
        const group = r.g === null || r.g === undefined ? '' : String(r.g)
        const name = r.n === null || r.n === undefined ? '' : String(r.n).trim()
        if (group && name) map.set(group, name)
      }
    })
  } catch {
    // 群名是可选增强：表或列随客户端版本变化时退化成显示群号，不影响消息查询。
  }
  return map
}

/**
 * 读通讯录里的账号 → 昵称映射；库不存在或表结构不符时返回空表。
 * @param {object} config - 插件配置。
 * @param {{dir: string}} account - 账号信息。
 * @returns {Map<string, string>} 账号到昵称。
 */
export function loadContacts(config, account) {
  const map = new Map()
  const path = addressBookPath(account)
  if (!existsSync(path)) return map
  try {
    withDb(path, config.busyTimeoutMs, (db) => {
      const tables = db.prepare("select name from sqlite_master where type='table'").all()
      // 通讯录表名随版本变化，挑第一个同时有账号列和昵称列的表。
      for (const { name } of tables) {
        const cols = db.prepare(`pragma table_info(${quoteIdent(name)})`).all()
        const names = cols.map(c => String(c.name).toLowerCase())
        const acct = ['account', 'accid', 'userid', 'username'].find(k => names.includes(k))
        const nick = ['nickname', 'nick', 'remarkname', 'displayname', 'name'].find(k => names.includes(k))
        if (!acct || !nick || acct === nick) continue
        const rows = db.prepare(`select ${quoteIdent(acct)} as a, ${quoteIdent(nick)} as n from ${quoteIdent(name)}`).all()
        for (const r of rows) {
          const a = r.a === null || r.a === undefined ? '' : String(r.a)
          const n = r.n === null || r.n === undefined ? '' : String(r.n)
          if (a && n) map.set(a, n)
        }
        if (map.size > 0) return
      }
    })
  } catch {
    // 通讯录是可选增强，读不到就退化成只有账号。
  }
  return map
}

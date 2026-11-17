/**
 * 消息库上的查询逻辑。所有函数都只接收一个**已经只读打开**的连接，自己不碰文件系统，
 * 便于单测。
 *
 * 库里的字段语义（实测确认）：
 * - `SessionId` 是会话标识：单聊为对方账号（`cs…`），群聊为群 ID（`g8…`）。
 * - `SessionType` 0=单聊，1=群聊；`GroupId` 实际基本为空，不要依赖。
 * - 方向靠 `Sender` 是否等于本人账号判断；本人账号即 CHFile 下的目录名。
 * - `CreatedTime` 是毫秒时间戳**字符串**，存在 `0` 的脏值。
 * - `Msg` 是明文正文；`isSuccess` 1=成功、0=未完成、-2=失败。
 * @module hyt-im/messages
 */

/**
 * `MsgType` 取值到中文名的映射，来自客户端 `RX_DataDefine/AgentEnum.h`。
 * 150 未在该枚举中出现，实测是客服平台通知号 `hyt_kfpt_*` 的卡片消息。
 */
export const MSG_TYPES = {
  1: '文本',
  2: '语音',
  3: '视频',
  4: '图片',
  5: '位置',
  6: '文件(压缩)',
  7: '文件(不压缩)',
  8: '分享链接',
  9: '群组通知',
  10: '未接来电',
  11: '群@',
  12: '输入状态/透传',
  13: '名片',
  15: '大文件',
  17: '第三方推送',
  20: '服务器透传',
  21: '删除/阅后即焚通知',
  22: '匿名开关通知',
  24: '已读通知',
  25: '撤回',
  26: '命令控制',
  30: 'SDK透传JSON',
  31: '公众号',
  36: '泛微OA自定义',
  50: '会议通知',
  60: '位置共享',
  61: '点赞',
  101: '自定义(101)',
  150: '服务号卡片',
  245: '自定义(245)',
  246: '自定义(246)',
}

/**
 * 消息类型名。
 * @param {number|null} t - MsgType。
 * @returns {string} 中文名，未知类型回退成 `未知(N)`；空值回退成 `未知`。
 */
export function msgTypeName(t) {
  // 先挡空值：Number(null) 是 0，不挡就会把「没有类型」显示成「未知(0)」。
  if (t === null || t === undefined || t === '') return '未知'
  const n = Number(t)
  if (!Number.isFinite(n)) return '未知'
  return MSG_TYPES[n] ?? `未知(${n})`
}

/**
 * 把库里的毫秒时间戳字符串转成可读时间与 ISO 串。
 * @param {string|number|null} raw - `CreatedTime` 原值。
 * @returns {{ms: number, iso: string, local: string, valid: boolean}}
 */
export function parseTime(raw) {
  const ms = Number.parseInt(raw === null || raw === undefined ? '' : String(raw), 10)
  if (!Number.isFinite(ms) || ms <= 0) return { ms: 0, iso: '', local: '', valid: false }
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return { ms, iso: d.toISOString(), local, valid: true }
}

/**
 * 解析调用方给的时间边界：接受毫秒时间戳或 `YYYY-MM-DD[ HH:MM:SS]`。
 * @param {string|number|undefined} value - 原始输入。
 * @param {'start'|'end'} edge - 只给日期时，start 取 00:00:00，end 取 23:59:59.999。
 * @returns {number|null} 毫秒时间戳，无法解析时返回 null。
 */
export function parseBoundary(value, edge) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const s = String(value).trim()
  if (/^\d{10,}$/.test(s)) return Number.parseInt(s, 10)
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    const tail = edge === 'end' ? 'T23:59:59.999' : 'T00:00:00.000'
    const t = Date.parse(`${y}-${m}-${d}${tail}`)
    return Number.isNaN(t) ? null : t
  }
  const t = Date.parse(s.replace(' ', 'T'))
  return Number.isNaN(t) ? null : t
}

/**
 * 按上限截断正文。
 * @param {string} text - 原始正文。
 * @param {number} limit - 上限，0 表示不截断。
 * @returns {{text: string, truncated: boolean}}
 */
export function clip(text, limit) {
  const s = text ?? ''
  if (!limit || limit <= 0 || s.length <= limit) return { text: s, truncated: false }
  return { text: s.slice(0, limit), truncated: true }
}

/** 查询时取出的列；`Msg` 之外都是元数据。 */
const COLUMNS = 'Id, MsgId, MsgType, Msg, Sender, Receiver, CreatedTime, SessionId, SessionType, '
  + 'SenderNick, isSuccess, ReadStatus, FileName, FileSize, FileUrl, webTitle, webDesc, webUrl, ReplyFlag'

/**
 * 把一行库记录映射成对外结构。
 * @param {object} row - 数据库行。
 * @param {string} self - 本人账号。
 * @param {number} contentLimit - 正文上限。
 * @param {Map<string,string>} [contacts] - 账号→昵称。
 * @returns {object} 对外的消息对象。
 */
export function shapeMessage(row, self, contentLimit, contacts = new Map()) {
  const t = parseTime(row.CreatedTime)
  const sender = row.Sender == null ? '' : String(row.Sender)
  const receiver = row.Receiver == null ? '' : String(row.Receiver)
  const outgoing = sender === self
  const peer = outgoing ? receiver : sender
  const body = clip(row.Msg == null ? '' : String(row.Msg), contentLimit)
  // 昵称兜底只在收消息时可用：SenderNick 是发送者的昵称，发出的消息里它就是本人
  // 自己的名字，不能当成对方（receiver）的昵称。
  const nickFromRow = outgoing ? '' : row.SenderNick == null ? '' : String(row.SenderNick)
  return {
    id: Number(row.Id),
    msgId: row.MsgId == null ? '' : String(row.MsgId),
    sessionId: row.SessionId == null ? '' : String(row.SessionId),
    sessionType: Number(row.SessionType) === 1 ? 'group' : 'single',
    direction: outgoing ? 'out' : 'in',
    sender,
    receiver,
    peer,
    peerNick: contacts.get(peer) || nickFromRow || peer,
    msgType: Number(row.MsgType),
    msgTypeName: msgTypeName(row.MsgType),
    content: body.text,
    contentTruncated: body.truncated,
    timeMs: t.ms,
    time: t.local,
    timeIso: t.iso,
    isSuccess: Number(row.isSuccess),
    readStatus: Number(row.ReadStatus),
    replyFlag: Number(row.ReplyFlag ?? 0),
    fileName: row.FileName ? String(row.FileName) : '',
    fileSize: row.FileSize ? String(row.FileSize) : '',
    fileUrl: row.FileUrl ? String(row.FileUrl) : '',
    webTitle: row.webTitle ? String(row.webTitle) : '',
    webDesc: row.webDesc ? String(row.webDesc) : '',
    webUrl: row.webUrl ? String(row.webUrl) : '',
  }
}

/**
 * 组装消息查询的 where 子句。
 * @param {object} opts - 查询条件。
 * @param {string} self - 本人账号，用于方向过滤。
 * @returns {{sql: string, params: Array<string|number>}}
 */
function buildWhere(opts, self) {
  const where = []
  const params = []
  if (opts.session) {
    where.push('SessionId = ?')
    params.push(String(opts.session))
  }
  if (Array.isArray(opts.exclude)) {
    // 按会话排除：通知号 `hyt_kfpt_*` 一个会话就占全库三分之一，做真人对话口径时要能剔掉。
    // 值仍走占位符绑定，不拼进 SQL。
    const list = opts.exclude.map(String).filter(Boolean)
    if (list.length > 0) {
      where.push(`SessionId not in (${list.map(() => '?').join(', ')})`)
      params.push(...list)
    }
  }
  if (opts.peer) {
    // 单聊里对方既可能是 Sender 也可能是 Receiver。
    where.push('(Sender = ? or Receiver = ?)')
    params.push(String(opts.peer), String(opts.peer))
  }
  const from = parseBoundary(opts.from, 'start')
  if (from !== null) {
    where.push('cast(CreatedTime as integer) >= ?')
    params.push(from)
  }
  const to = parseBoundary(opts.to, 'end')
  if (to !== null) {
    where.push('cast(CreatedTime as integer) <= ?')
    params.push(to)
  }
  if (opts.direction === 'in') {
    where.push('Sender <> ?')
    params.push(self)
  } else if (opts.direction === 'out') {
    where.push('Sender = ?')
    params.push(self)
  }
  if (opts.msgType !== undefined && opts.msgType !== null && opts.msgType !== '') {
    where.push('MsgType = ?')
    params.push(Number(opts.msgType))
  }
  if (opts.keyword) {
    where.push('Msg like ?')
    params.push(`%${String(opts.keyword)}%`)
  }
  if (opts.afterId) {
    where.push('Id > ?')
    params.push(Number(opts.afterId))
  }
  return { sql: where.length ? ` where ${where.join(' and ')}` : '', params }
}

/**
 * 查消息。
 * @param {import('node:sqlite').DatabaseSync} db - 只读连接。
 * @param {string} self - 本人账号。
 * @param {object} opts - `{session, peer, from, to, direction, msgType, keyword, afterId, limit, desc}`。
 * @param {number} contentLimit - 正文上限。
 * @param {Map<string,string>} [contacts] - 账号→昵称。
 * @returns {{messages: object[], count: number, oldestId: number, newestId: number, hasMore: boolean}}
 */
export function queryMessages(db, self, opts, contentLimit, contacts = new Map()) {
  const limit = Math.max(1, Number(opts.limit) || 100)
  const { sql, params } = buildWhere(opts, self)
  // 默认取最新的窗口；`order=asc` 配合 afterId 从旧往新消费增量，取的是窗口里最旧的 N 条。
  const ascending = opts.order === 'asc'
  const rows = db.prepare(
    `select ${COLUMNS} from chatmsg${sql} order by Id ${ascending ? 'asc' : 'desc'} limit ?`,
  ).all(...params, limit + 1)
  const hasMore = rows.length > limit
  const kept = hasMore ? rows.slice(0, limit) : rows
  const messages = kept.map(r => shapeMessage(r, self, contentLimit, contacts))
  const firstId = messages[0]?.id ?? 0
  const lastId = messages[messages.length - 1]?.id ?? 0
  return {
    messages,
    count: messages.length,
    // Id 水位必须按排序方向取：倒序时首行才是最新一条，按位置写死会把两者颠倒，
    // 调用方拿 newestId 当 afterId 就会重复拉取已经读过的消息。
    oldestId: ascending ? firstId : lastId,
    newestId: ascending ? lastId : firstId,
    hasMore,
  }
}

/**
 * 列会话：按 `SessionId` 聚合，给出对方、条数、收发比与最后一条的时间。
 * @param {import('node:sqlite').DatabaseSync} db - 只读连接。
 * @param {string} self - 本人账号。
 * @param {{limit?: number, from?: string|number, includePreview?: boolean}} opts - 选项。
 * @param {number} contentLimit - 预览正文上限。
 * @param {Map<string,string>} [contacts] - 账号→昵称。
 * @returns {object[]} 会话列表，按最后消息时间倒序。
 */
export function listSessions(db, self, opts, contentLimit, contacts = new Map()) {
  const limit = Math.max(1, Number(opts.limit) || 50)
  const from = parseBoundary(opts.from, 'start')
  const where = from === null ? '' : ' where cast(CreatedTime as integer) >= ?'
  const params = from === null ? [] : [from]
  const rows = db.prepare(`
    select SessionId as sessionId,
           max(cast(SessionType as integer)) as sessionType,
           count(*) as total,
           sum(case when Sender = ? then 1 else 0 end) as sent,
           sum(case when Sender <> ? then 1 else 0 end) as received,
           max(Id) as lastId,
           max(cast(CreatedTime as integer)) as lastMs
    from chatmsg${where}
    group by SessionId
    order by lastMs desc
    limit ?
  `).all(self, self, ...params, limit)

  const previewLimit = Math.min(contentLimit || 200, 200)
  return rows.map((r) => {
    const sessionId = r.sessionId == null ? '' : String(r.sessionId)
    const t = parseTime(r.lastMs)
    const isGroup = Number(r.sessionType) === 1
    let preview = ''
    let previewType = ''
    let lastDirection = ''
    if (opts.includePreview !== false && r.lastId) {
      const last = db.prepare(`select ${COLUMNS} from chatmsg where Id = ?`).get(Number(r.lastId))
      if (last) {
        preview = clip(last.Msg == null ? '' : String(last.Msg), previewLimit).text
        previewType = msgTypeName(last.MsgType)
        lastDirection = String(last.Sender) === self ? 'out' : 'in'
      }
    }
    // 群聊的 SessionId 就是群号；单聊的 SessionId 是对方账号。
    const peer = isGroup ? '' : sessionId
    return {
      sessionId,
      sessionType: isGroup ? 'group' : 'single',
      peer,
      peerNick: isGroup ? (contacts.get(sessionId) || sessionId) : (contacts.get(peer) || peer),
      total: Number(r.total),
      sent: Number(r.sent),
      received: Number(r.received),
      lastId: Number(r.lastId ?? 0),
      lastTimeMs: t.ms,
      lastTime: t.local,
      lastMsgType: previewType,
      lastDirection,
      preview,
    }
  })
}

/**
 * 全库检索正文，跨会话。
 * @param {import('node:sqlite').DatabaseSync} db - 只读连接。
 * @param {string} self - 本人账号。
 * @param {{keyword: string, from?: string|number, to?: string|number, limit?: number, direction?: string, session?: string, exclude?: string[]}} opts - 检索条件。
 * @param {number} contentLimit - 正文上限。
 * @param {Map<string,string>} [contacts] - 账号到昵称，含群名。
 * @returns {{messages: object[], count: number, keyword: string}}
 */
export function searchMessages(db, self, opts, contentLimit, contacts = new Map()) {
  const res = queryMessages(db, self, {
    keyword: opts.keyword,
    from: opts.from,
    to: opts.to,
    limit: opts.limit,
    direction: opts.direction,
    session: opts.session,
    exclude: opts.exclude,
  }, contentLimit, contacts)
  return { ...res, keyword: String(opts.keyword ?? '') }
}

/**
 * 收发统计：总量、按方向、按类型、按天、最活跃会话。
 * @param {import('node:sqlite').DatabaseSync} db - 只读连接。
 * @param {string} self - 本人账号。
 * @param {{from?: string|number, to?: string|number, topPeers?: number}} opts - 选项。
 * @returns {object} 统计结果。
 */
export function stats(db, self, opts) {
  const where = []
  const params = []
  const from = parseBoundary(opts.from, 'start')
  const to = parseBoundary(opts.to, 'end')
  if (from !== null) {
    where.push('cast(CreatedTime as integer) >= ?')
    params.push(from)
  }
  if (to !== null) {
    where.push('cast(CreatedTime as integer) <= ?')
    params.push(to)
  }
  const w = where.length ? ` where ${where.join(' and ')}` : ''
  const top = Math.max(1, Number(opts.topPeers) || 10)

  // firstMs 要排除 CreatedTime=0 的脏值，否则全库统计时时间跨度的起点永远是空的。
  const total = db.prepare(`
    select count(*) as n,
           sum(case when Sender = ? then 1 else 0 end) as sent,
           sum(case when Sender <> ? then 1 else 0 end) as received,
           min(case when cast(CreatedTime as integer) > 0 then cast(CreatedTime as integer) end) as firstMs,
           max(cast(CreatedTime as integer)) as lastMs
    from chatmsg${w}
  `).get(self, self, ...params)

  const byType = db.prepare(`
    select MsgType as t, count(*) as n from chatmsg${w} group by MsgType order by n desc limit 20
  `).all(...params)

  // 按天聚合：CreatedTime 是毫秒时间戳，转成本地日期字符串再分组。
  // 这里额外要求 CreatedTime > 0，因为库里存在 CreatedTime 为 0 的脏值。
  const byDayRows = db.prepare(`
    select date(cast(CreatedTime as integer) / 1000, 'unixepoch', 'localtime') as day,
           count(*) as n,
           sum(case when Sender = ? then 1 else 0 end) as sent
    from chatmsg
    ${w ? `${w} and` : 'where'} cast(CreatedTime as integer) > 0
    group by day order by day desc limit 31
  `).all(self, ...params)

  const topPeers = db.prepare(`
    select SessionId as s, count(*) as n from chatmsg${w} group by SessionId order by n desc limit ?
  `).all(...params, top)

  return {
    total: Number(total?.n ?? 0),
    sent: Number(total?.sent ?? 0),
    received: Number(total?.received ?? 0),
    firstTime: parseTime(total?.firstMs).local,
    lastTime: parseTime(total?.lastMs).local,
    byType: byType.map(r => ({ msgType: Number(r.t), msgTypeName: msgTypeName(r.t), count: Number(r.n) })),
    byDay: byDayRows.map(r => ({ day: String(r.day ?? ''), count: Number(r.n), sent: Number(r.sent ?? 0) })),
    topSessions: topPeers.map(r => ({ sessionId: String(r.s ?? ''), count: Number(r.n) })),
  }
}

/**
 * 库概况：行数、Id 水位、时间跨度。给增量监听当游标起点。
 * @param {import('node:sqlite').DatabaseSync} db - 只读连接。
 * @returns {{rows: number, maxId: number, minId: number, sessions: number}}
 */
export function overview(db) {
  const r = db.prepare('select count(*) as n, max(Id) as mx, min(Id) as mn, count(distinct SessionId) as s from chatmsg').get()
  return {
    rows: Number(r?.n ?? 0),
    maxId: Number(r?.mx ?? 0),
    minId: Number(r?.mn ?? 0),
    sessions: Number(r?.s ?? 0),
  }
}

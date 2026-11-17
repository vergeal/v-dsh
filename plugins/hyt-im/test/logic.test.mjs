/**
 * 纯逻辑与内存库上的行为检查：时间解析、正文裁剪、消息整形、查询过滤、统计与概况。
 * 运行：`node --test plugins/hyt-im/test/logic.test.mjs`。
 *
 * `stats()` 的两个 where 分支都在这里实跑：它把 `self` 绑在 select 的占位符上、
 * 又把时间边界绑在 where 上，绑定顺序错了不会报错、只会静默算错收发比。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Messages from '../src/messages.js'
import { createCursor } from '../src/cursor.js'
import { renderMessages } from '../src/render.js'
import * as Store from '../src/store.js'
import { registerSkill, SKILL_NAME } from '../src/skill.js'

const SELF = 'cs_self'

// 用本地时区构造，和 parseBoundary 对无时区字符串的解析口径一致。
const T_20_10 = new Date(2026, 9, 20, 10, 0, 0).getTime()
const T_20_11 = new Date(2026, 9, 20, 11, 30, 0).getTime()
const T_21_09 = new Date(2026, 9, 21, 9, 0, 0).getTime()
const T_21_10 = new Date(2026, 9, 21, 10, 0, 0).getTime()
const T_22_15 = new Date(2026, 9, 22, 15, 0, 0).getTime()

/** 按 messages.js 的 COLUMNS 建一张最小 chatmsg，列名要和真实库一致。 */
function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table chatmsg (
      Id integer primary key, MsgId text, MsgType integer, Msg text,
      Sender text, Receiver text, CreatedTime text, SessionId text, SessionType integer,
      SenderNick text, isSuccess integer, ReadStatus integer,
      FileName text, FileSize text, FileUrl text,
      webTitle text, webDesc text, webUrl text, ReplyFlag integer
    )
  `)
  const insert = db.prepare(`
    insert into chatmsg (Id, MsgId, MsgType, Msg, Sender, Receiver, CreatedTime, SessionId, SessionType,
      SenderNick, isSuccess, ReadStatus, FileName, FileSize, FileUrl, webTitle, webDesc, webUrl, ReplyFlag)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const row = (v) => insert.run(
    v.Id, `m${v.Id}`, v.MsgType ?? 1, v.Msg ?? '', v.Sender, v.Receiver,
    String(v.CreatedTime ?? 0), v.SessionId, v.SessionType ?? 0, v.SenderNick ?? '',
    v.isSuccess ?? 1, 0, v.FileName ?? '', v.FileSize ?? '', v.FileUrl ?? '', '', '', '', 0,
  )
  row({ Id: 1, Sender: SELF, Receiver: 'cs_bob', CreatedTime: T_20_10, SessionId: 'cs_bob', Msg: 'hello from self', SenderNick: '_selfnick' })
  row({ Id: 2, Sender: 'cs_bob', Receiver: SELF, CreatedTime: T_20_11, SessionId: 'cs_bob', Msg: 'reply to self', SenderNick: 'Bob' })
  row({ Id: 3, Sender: SELF, Receiver: 'g8_room', CreatedTime: T_21_09, SessionId: 'g8_room', SessionType: 1, MsgType: 11, Msg: '@all meeting', SenderNick: '_selfnick' })
  // Id 4、5 用 isSuccess=0：复现本机真实分布（11342 条 0 / 2821 条 1 / 1155 条 -2），
  // 收到的消息本来就是本地落库水位，不是发送结果。
  row({ Id: 4, Sender: 'carol', Receiver: 'g8_room', CreatedTime: T_21_10, SessionId: 'g8_room', SessionType: 1, MsgType: 4, Msg: '', SenderNick: 'Carol', FileName: 'pic.png', FileSize: '123', isSuccess: 0 })
  row({ Id: 5, Sender: 'dave', Receiver: SELF, CreatedTime: 0, SessionId: 'cs_dave', MsgType: 150, Msg: 'dirty time no stamp', SenderNick: 'Dave', isSuccess: 0 })
  row({ Id: 6, Sender: SELF, Receiver: 'cs_bob', CreatedTime: T_22_15, SessionId: 'cs_bob', Msg: 'last one', SenderNick: '_selfnick', isSuccess: -2 })
  return db
}

test('msgTypeName maps known codes and labels unknown ones', () => {
  assert.equal(Messages.msgTypeName(1), '文本')
  assert.equal(Messages.msgTypeName(150), '服务号卡片')
  assert.equal(Messages.msgTypeName('11'), '群@')
  assert.equal(Messages.msgTypeName(999), '未知(999)')
  // 空值不等于类型 0：Number(null) 是 0，早退顺序错了就会显示成「未知(0)」。
  assert.equal(Messages.msgTypeName(null), '未知')
  assert.equal(Messages.msgTypeName(undefined), '未知')
  assert.equal(Messages.msgTypeName(''), '未知')
  assert.equal(Messages.msgTypeName('abc'), '未知')
  assert.equal(Messages.msgTypeName(0), '未知(0)')
})

test('parseTime rejects the zero and unparseable stamps the library stores', () => {
  assert.equal(Messages.parseTime('0').valid, false)
  assert.equal(Messages.parseTime(null).valid, false)
  assert.equal(Messages.parseTime('abc').valid, false)
  assert.equal(Messages.parseTime(-5).valid, false)
  const t = Messages.parseTime(T_20_10)
  assert.equal(t.valid, true)
  assert.equal(t.ms, T_20_10)
  assert.match(t.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(Messages.parseTime(T_20_10).local, Messages.parseTime(String(T_20_10)).local)
})

test('parseBoundary takes epochs and dates, and splits the day edges', () => {
  assert.equal(Messages.parseBoundary(String(T_20_10), 'start'), T_20_10)
  assert.equal(Messages.parseBoundary(T_20_10, 'start'), T_20_10)
  assert.equal(Messages.parseBoundary(undefined, 'start'), null)
  assert.equal(Messages.parseBoundary('', 'end'), null)
  assert.equal(Messages.parseBoundary('nonsense', 'start'), null)
  const dayStart = Messages.parseBoundary('2026-10-20', 'start')
  const dayEnd = Messages.parseBoundary('2026-10-20', 'end')
  assert.equal(dayStart, new Date(2026, 9, 20, 0, 0, 0, 0).getTime())
  assert.equal(dayEnd, new Date(2026, 9, 20, 23, 59, 59, 999).getTime())
  assert.ok(dayStart < T_20_10 && T_20_10 < dayEnd)
  assert.equal(Messages.parseBoundary('2026-10-20 08:00:00', 'start'), new Date(2026, 9, 20, 8, 0, 0).getTime())
})

test('clip truncates only past the limit and reports it', () => {
  assert.deepEqual(Messages.clip('abc', 10), { text: 'abc', truncated: false })
  assert.deepEqual(Messages.clip('abcdef', 3), { text: 'abc', truncated: true })
  assert.deepEqual(Messages.clip('abcdef', 0), { text: 'abcdef', truncated: false })
  assert.deepEqual(Messages.clip(undefined, 5), { text: '', truncated: false })
})

test('shapeMessage reads direction, peer and validity from the row', () => {
  const db = makeDb()
  const inRow = db.prepare('select * from chatmsg where Id = 2').get()
  const shaped = Messages.shapeMessage(inRow, SELF, 2000)
  assert.equal(shaped.direction, 'in')
  assert.equal(shaped.peer, 'cs_bob')
  assert.equal(shaped.peerNick, 'Bob')
  assert.equal(shaped.sessionType, 'single')
  assert.equal(shaped.timeMs, T_20_11)

  const groupRow = db.prepare('select * from chatmsg where Id = 3').get()
  assert.equal(Messages.shapeMessage(groupRow, SELF, 2000).sessionType, 'group')

  const dirty = Messages.shapeMessage(db.prepare('select * from chatmsg where Id = 5').get(), SELF, 2000)
  assert.equal(dirty.time, '')
  assert.equal(dirty.timeMs, 0)
})

test('an outgoing message never borrows the sender nick as the peer name', () => {
  const db = makeDb()
  const outRow = db.prepare('select * from chatmsg where Id = 1').get()
  // SenderNick 在这里是本人的群内昵称 _selfnick；把它当对方名字会把自己显示成收件人。
  const shaped = Messages.shapeMessage(outRow, SELF, 2000)
  assert.equal(shaped.direction, 'out')
  assert.equal(shaped.peer, 'cs_bob')
  assert.equal(shaped.peerNick, 'cs_bob')
  assert.equal(Messages.shapeMessage(outRow, SELF, 2000, new Map([['cs_bob', '鲍勃']])).peerNick, '鲍勃')
  // 收到的消息仍回退到 SenderNick。
  const inRow = db.prepare('select * from chatmsg where Id = 4').get()
  assert.equal(Messages.shapeMessage(inRow, SELF, 2000).peerNick, 'Carol')
})

test('queryMessages defaults to the newest window and flags more rows', () => {
  const db = makeDb()
  const res = Messages.queryMessages(db, SELF, { limit: 2 }, 2000)
  assert.equal(res.count, 2)
  assert.equal(res.hasMore, true)
  assert.deepEqual(res.messages.map(m => m.id), [6, 5])
  assert.equal(res.oldestId, 5)
  assert.equal(res.newestId, 6)
})

test('afterId with ascending order returns old to new', () => {
  const db = makeDb()
  const res = Messages.queryMessages(db, SELF, { afterId: 3, order: 'asc', limit: 50 }, 2000)
  assert.deepEqual(res.messages.map(m => m.id), [4, 5, 6])
  assert.equal(res.hasMore, false)
  // 两种排序方向下水位都要指对，newestId 是调用方下一次拉的 afterId。
  assert.equal(res.oldestId, 4)
  assert.equal(res.newestId, 6)
  const back = Messages.queryMessages(db, SELF, { afterId: 3, order: 'desc', limit: 50 }, 2000)
  assert.equal(back.oldestId, 4)
  assert.equal(back.newestId, 6)
  const window2 = Messages.queryMessages(db, SELF, { limit: 2 }, 2000)
  assert.equal(window2.oldestId, 5)
  assert.equal(window2.newestId, 6)
})

test('queryMessages filters by direction, peer, session, type and keyword', () => {
  const db = makeDb()
  const ids = (opts) => Messages.queryMessages(db, SELF, { ...opts, order: 'asc', limit: 50 }, 2000).messages.map(m => m.id)
  assert.deepEqual(ids({ direction: 'out' }), [1, 3, 6])
  assert.deepEqual(ids({ direction: 'in' }), [2, 4, 5])
  assert.deepEqual(ids({ peer: 'cs_bob' }), [1, 2, 6])
  assert.deepEqual(ids({ session: 'g8_room' }), [3, 4])
  assert.deepEqual(ids({ msgType: 150 }), [5])
  assert.deepEqual(ids({ keyword: 'self' }), [1, 2])
  assert.deepEqual(ids({ keyword: '没有这句话' }), [])
  assert.deepEqual(ids({ from: '2026-10-21', to: '2026-10-21' }), [3, 4])
})

test('queryMessages clips long bodies and reports it', () => {
  const db = makeDb()
  const res = Messages.queryMessages(db, SELF, { limit: 50 }, 4)
  const first = res.messages.find(m => m.id === 6)
  assert.equal(first.content, 'last')
  assert.equal(first.contentTruncated, true)
})

test('listSessions aggregates per session and previews the last row', () => {
  const db = makeDb()
  const sessions = Messages.listSessions(db, SELF, { limit: 50 }, 200)
  assert.deepEqual(sessions.map(s => s.sessionId), ['cs_bob', 'g8_room', 'cs_dave'])
  const [bob, room, dave] = sessions
  assert.equal(bob.sessionType, 'single')
  assert.equal(bob.peer, 'cs_bob')
  assert.deepEqual([bob.total, bob.sent, bob.received, bob.lastId], [3, 2, 1, 6])
  assert.equal(bob.preview, 'last one')
  assert.equal(bob.lastDirection, 'out')
  assert.equal(room.sessionType, 'group')
  assert.equal(room.peer, '')
  assert.deepEqual([room.total, room.sent, room.received], [2, 1, 1])
  // CreatedTime=0 的会话排最后，且没有可用时间。
  assert.equal(dave.lastTime, '')
  assert.equal(dave.lastId, 5)
})

test('listSessions skips the preview query when asked to', () => {
  const db = makeDb()
  const sessions = Messages.listSessions(db, SELF, { limit: 5, includePreview: false }, 200)
  assert.equal(sessions[0].preview, '')
  assert.equal(sessions[0].lastMsgType, '')
})

test('listSessions honors the from bound', () => {
  const db = makeDb()
  const sessions = Messages.listSessions(db, SELF, { limit: 50, from: '2026-10-21' }, 200)
  // CreatedTime=0 的 Id 5 落在界外，所以 cs_dave 整个会话消失；剩下按窗口内最大时间排。
  assert.deepEqual(sessions.map(s => s.sessionId), ['cs_bob', 'g8_room'])
  assert.equal(sessions[0].total, 1)
  assert.equal(sessions.find(s => s.sessionId === 'g8_room').total, 2)
})

test('stats works with no time window: total, ratio and first time past the dirty row', () => {
  const db = makeDb()
  const s = Messages.stats(db, SELF, {})
  assert.deepEqual([s.total, s.sent, s.received], [6, 3, 3])
  // Id 5 的 CreatedTime 是 0，起点必须跳到真正最早的那条。
  assert.equal(s.firstTime, Messages.parseTime(T_20_10).local)
  assert.equal(s.lastTime, Messages.parseTime(T_22_15).local)
  assert.equal(s.byDay.reduce((n, d) => n + d.count, 0), 5)
  assert.equal(s.byDay.length, 3)
  assert.equal(s.byDay[0].day, '2026-10-22')
  assert.equal(s.byType.find(t => t.msgType === 1).count, 3)
  assert.deepEqual(s.topSessions.map(t => t.sessionId), ['cs_bob', 'g8_room', 'cs_dave'])
})

test('stats honors a bounded window without mixing up the bound order', () => {
  const db = makeDb()
  const s = Messages.stats(db, SELF, { from: '2026-10-21', to: '2026-10-22' })
  // 落在窗口内的是 Id 3、4、6；Id 5 时间是 0，不满足下界。
  assert.deepEqual([s.total, s.sent, s.received], [3, 2, 1])
  assert.equal(s.firstTime, Messages.parseTime(T_21_09).local)
  assert.equal(s.byDay.reduce((n, d) => n + d.count, 0), 3)
  const day21 = s.byDay.find(d => d.day === '2026-10-21')
  assert.deepEqual([day21.count, day21.sent], [2, 1])
})

test('stats caps the top sessions list', () => {
  const db = makeDb()
  assert.equal(Messages.stats(db, SELF, { topPeers: 1 }).topSessions.length, 1)
})

test('overview reports row count, Id watermark and distinct sessions', () => {
  const db = makeDb()
  assert.deepEqual(Messages.overview(db), { rows: 6, maxId: 6, minId: 1, sessions: 3 })
})

test('an empty database yields zeros instead of throwing', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('create table chatmsg (Id integer primary key, MsgId text, MsgType integer, Msg text, Sender text, Receiver text, CreatedTime text, SessionId text, SessionType integer, SenderNick text, isSuccess integer, ReadStatus integer, FileName text, FileSize text, FileUrl text, webTitle text, webDesc text, webUrl text, ReplyFlag integer)')
  assert.deepEqual(Messages.overview(db), { rows: 0, maxId: 0, minId: 0, sessions: 0 })
  assert.deepEqual(Messages.queryMessages(db, SELF, {}, 2000), { messages: [], count: 0, oldestId: 0, newestId: 0, hasMore: false })
  assert.equal(Messages.listSessions(db, SELF, {}, 200).length, 0)
  const s = Messages.stats(db, SELF, {})
  assert.deepEqual([s.total, s.sent, s.received], [0, 0, 0])
  assert.equal(s.firstTime, '')
})

test('expandHome resolves the leading tilde only', () => {
  assert.equal(Store.expandHome(''), '')
  assert.equal(Store.expandHome(undefined), undefined)
  assert.match(Store.expandHome('~/Documents/CHFile'), /Documents[\\/]CHFile$/)
  assert.ok(!Store.expandHome('~/Documents/CHFile').startsWith('~'))
  assert.equal(Store.expandHome('/var/db'), '/var/db')
})

test('findAccounts and pickAccount read the CHFile layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyt-chfile-'))
  try {
    mkdirSync(join(root, 'csOLD'), { recursive: true })
    mkdirSync(join(root, 'csNEW'), { recursive: true })
    mkdirSync(join(root, 'noDb'), { recursive: true })
    writeFileSync(join(root, 'loose.txt'), 'x')
    const oldDb = join(root, 'csOLD', 'chatmsg.db')
    const newDb = join(root, 'csNEW', 'chatmsg.db')
    writeFileSync(oldDb, 'x')
    writeFileSync(newDb, 'yy')
    // 显式定 mtime：不靠写入顺序在同一毫秒内比大小。
    utimesSync(oldDb, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    utimesSync(newDb, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))

    assert.deepEqual(Store.findAccounts(join(root, 'missing')), [])
    const found = Store.findAccounts(root)
    assert.deepEqual(found.map(a => a.account), ['csNEW', 'csOLD'])
    assert.equal(found[1].bytes, 1)

    assert.equal(Store.pickAccount({ dataDir: root, account: '', busyTimeoutMs: 3000 }).account, 'csNEW')
    const pinned = Store.pickAccount({ dataDir: root, account: 'csOLD', busyTimeoutMs: 3000 })
    assert.equal(pinned.account, 'csOLD')
    assert.equal(pinned.candidates, 2)
    assert.throws(() => Store.pickAccount({ dataDir: root, account: 'csZZZ', busyTimeoutMs: 3000 }), /csZZZ/)
    assert.throws(() => Store.pickAccount({ dataDir: join(root, 'missing'), account: '', busyTimeoutMs: 3000 }), /chatmsg\.db/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 造一个临时账号目录，里面放好 chatmsg.db 占位和指定的 AddressBookDB 表。
 * @param {string[]} ddl - 建表语句。
 * @param {string[]} inserts - 插入语句。
 * @returns {{root: string, account: object, config: object}}
 */
function contactsFixture(ddl, inserts) {
  const root = mkdtempSync(join(tmpdir(), 'hyt-contacts-'))
  const dir = join(root, 'csX')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'chatmsg.db'), 'x')
  const book = new DatabaseSync(join(dir, 'AddressBookDB.db'))
  for (const sql of [...ddl, ...inserts]) book.exec(sql)
  book.close()
  return { root, account: { dir, dbPath: join(dir, 'chatmsg.db') }, config: { busyTimeoutMs: 3000 } }
}

test('loadContacts reads the account and nickname columns it looks for', () => {
  const fx = contactsFixture(
    ['create table contacts (account text primary key, nickname text, avatar text)', 'create table noise (id integer)'],
    ["insert into contacts values ('cs_bob','Bob 鲍勃','')"],
  )
  try {
    const contacts = Store.loadContacts(fx.config, fx.account)
    assert.equal(contacts.get('cs_bob'), 'Bob 鲍勃')
    rmSync(join(fx.account.dir, 'AddressBookDB.db'))
    assert.equal(Store.loadContacts(fx.config, fx.account).size, 0)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('loadContacts escapes a table name holding a double quote', () => {
  // 转义写错时整条 pragma 语句报错，被外层 catch 静默吞成空表——所以这里必须断言读到了值。
  const fx = contactsFixture(
    ['create table "we""ird" (account text, nickname text)', 'create table noise (id integer)'],
    ["insert into \"we\"\"ird\" values ('cs_dave','Dave 戴夫')"],
  )
  try {
    assert.equal(Store.loadContacts(fx.config, fx.account).get('cs_dave'), 'Dave 戴夫')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('loadContacts stops at the first table that yields rows', () => {
  // 现状语义：命中一张就返回，不合并多张表。真实通讯录只有一张表时这是对的行为。
  const fx = contactsFixture(
    ['create table contacts (account text, nickname text)', 'create table "we""ird" (account text, nickname text)'],
    ["insert into contacts values ('cs_bob','Bob 鲍勃')", "insert into \"we\"\"ird\" values ('cs_dave','Dave 戴夫')"],
  )
  try {
    const contacts = Store.loadContacts(fx.config, fx.account)
    assert.equal(contacts.get('cs_bob'), 'Bob 鲍勃')
    assert.equal(contacts.has('cs_dave'), false)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('registerSkill contributes a source so the skill can actually load', () => {
  const registered = []
  registerSkill({ register: skill => registered.push(skill) }, join(import.meta.dirname, '..'))
  assert.equal(registered.length, 1)
  const [skill] = registered
  assert.equal(skill.name, SKILL_NAME)
  // 少了 source，注册照过，`skill` 工具一加载就抛 SKILL_INVALID_DEFINITION。
  assert.equal(skill.source, 'runtime')
  assert.match(skill.description, /虹云通/)
  assert.ok(skill.content.startsWith('# 虹云通本地消息查询'), 'frontmatter must be stripped off the body')
})

test('loadGroupNames reads group titles out of keepgroup', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyt-groups-'))
  try {
    const dir = join(root, 'csX')
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'chatmsg.db')
    const db = new DatabaseSync(dbPath)
    db.exec('create table keepgroup (Id integer primary key, GroupId text, GroupName text)')
    const put = db.prepare('insert into keepgroup (GroupId, GroupName) values (?,?)')
    put.run('g8_room', '运维值班群')
    put.run('g8_blank', '   ')
    put.run('g8_null', null)
    put.run(null, '没有群号')
    db.close()

    const account = { dir, dbPath }
    const config = { busyTimeoutMs: 3000 }
    const names = Store.loadGroupNames(config, account)
    assert.equal(names.get('g8_room'), '运维值班群')
    // 空群名和没有群号的行都不进表，否则显示名会把空白当成名字。
    assert.equal(names.size, 1)

    rmSync(dbPath)
    assert.equal(Store.loadGroupNames(config, account).size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessions shows a group title when the names table carries it', () => {
  const db = makeDb()
  const names = new Map([['g8_room', '运维值班群'], ['cs_bob', '鲍勃']])
  const sessions = Messages.listSessions(db, SELF, { limit: 50 }, 200, names)
  assert.equal(sessions.find(s => s.sessionId === 'g8_room').peerNick, '运维值班群')
  assert.equal(sessions.find(s => s.sessionId === 'cs_bob').peerNick, '鲍勃')
  // 没有别名的会话回退成 ID 本身，不留空。
  assert.equal(sessions.find(s => s.sessionId === 'cs_dave').peerNick, 'cs_dave')
})

test('exclude drops whole sessions out of the window', () => {
  const db = makeDb()
  const ids = (opts) => Messages.queryMessages(db, SELF, { ...opts, order: 'asc', limit: 50 }, 2000).messages.map(m => m.id)
  assert.deepEqual(ids({ exclude: ['cs_dave'] }), [1, 2, 3, 4, 6])
  assert.deepEqual(ids({ exclude: ['cs_dave', 'g8_room'] }), [1, 2, 6])
  // 空数组和空串都不该改动结果，否则拼 SQL 时会留下 `not in ()`。
  assert.deepEqual(ids({ exclude: [] }), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(ids({ exclude: [''] }), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(ids({ exclude: ['g8_room'], session: 'cs_bob' }), [1, 2, 6])
  const hit = Messages.searchMessages(db, SELF, { keyword: 'self', exclude: ['cs_bob'], limit: 50 }, 2000)
  assert.deepEqual(hit.messages.map(m => m.id), [])
})

test('cursor baselines once, advances forward, and refuses bad positions', () => {
  const cursor = createCursor()
  assert.equal(cursor.initialized, false)
  assert.equal(cursor.value, 0)

  // 第一次立基线，第二次不动：调用方靠返回值区分「刚开始」和「真的没新消息」。
  assert.equal(cursor.init(100), true)
  assert.equal(cursor.value, 100)
  assert.equal(cursor.init(999), false)
  assert.equal(cursor.value, 100)

  cursor.advance(140)
  assert.equal(cursor.value, 140)
  // 只朝前走：回退必须显式 set，避免一次乱序返回把游标倒回去重复消费。
  cursor.advance(120)
  assert.equal(cursor.value, 140)
  // 空结果的水位是 0，不能把游标抹平。
  cursor.advance(0)
  assert.equal(cursor.value, 140)

  assert.equal(cursor.set(60), 60)
  assert.equal(cursor.value, 60)
  assert.equal(cursor.initialized, true)
  assert.throws(() => cursor.set(-1), RangeError)
  assert.throws(() => cursor.set('abc'), RangeError)
  assert.equal(cursor.value, 60)
  cursor.set(60.7)
  assert.equal(cursor.value, 60, 'fractional ids floor')
})
test('renderMessages keeps send status off received messages', () => {
  const db = makeDb()
  const res = Messages.queryMessages(db, SELF, { order: 'asc', limit: 50 }, 2000)
  const value = {
    account: SELF, self: SELF, count: res.count, hasMore: res.hasMore, newestId: res.newestId, messages: res.messages,
  }
  const lines = renderMessages(value).split('\n')
  assert.match(lines[0], /命中 6 条/)
  const byId = Object.fromEntries(lines.slice(1).map(l => [l.match(/^#(\d+)/)[1], l]))
  // 收到的消息即使 isSuccess 是 0 也不写「发送状态」，那是本地落库水位不是发送结果。
  assert.ok(!byId['5'].includes('发送状态'), byId['5'])
  assert.match(byId['4'], /\[群 图片 文件:pic\.png\]: /, byId['4'])
  // 本人发出的才写：失败的那条要看得见，成功的不必占位。
  assert.match(byId['6'], /发送状态:-2/, byId['6'])
  assert.ok(!byId['1'].includes('发送状态'), byId['1'])
  assert.ok(!byId['3'].includes('发送状态'), byId['3'])
})

# hyt-im 插件 · 未完成事项与勘察记录

> 更新时间：2026-11-17 18:55（Asia/Shanghai）。因关机中断，此文件是下次接续的唯一入口。
> 目标：把本机虹云通消息能力做成 DSH 插件，**收消息 + 发消息**，后续对接 `plugins/inbox`。

## 一、当前进度

### 已完成

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `package.json` | ✅ | `dsh-hyt-im`，peerDependencies 对齐 dbro 约定 |
| `cordis.patch.yml` | ✅ | `- insert: [{id: hyt-im, name: 'dsh-hyt-im', config: {}}]` |
| `index.js` | ✅ | `name` / `inject:['tools']` / `Config` / `apply` |
| `src/store.js` | ✅ | 账号发现 + 只读连接（`readOnly` + `pragma query_only`） |
| `src/messages.js` | ✅ | MsgType 映射、时间解析、会话/消息/搜索/统计/概况 |
| `src/tools.js` | ✅ | 6 个只读工具：`hyt_accounts` `hyt_sessions` `hyt_messages` `hyt_search` `hyt_stats` `hyt_overview` |

### 未完成（下次按此顺序做）

1. **`src/skill.js` + `skills/hyt-im/SKILL.md`** — ⚠️ `index.js` 已 `import { registerSkill } from './src/skill.js'`，
   **文件还不存在，现在装插件会加载失败**。要么补上（照抄 `plugins/dbro/src/skill.js`，31 行），
   要么先把 `index.js` 里那两行注释掉。
2. **`locale/zh.json` + `locale/en.json`** — Plugin Manager 标题与描述，键为 `meta.title` / `meta.description` / `meta.detail`。
3. **`icon.svg`** — `package.json` 的 `exports` 已声明 `./icon`，缺文件会有元数据诊断。
4. **`README.md` + `docs/DETAIL.md`** — `files` 已声明 `docs`，`meta.detail` 指向 `docs/DETAIL.md`。
5. **发消息通道** — 见第三节，**尚未实现任何发送能力**。
6. **新消息监听** — 轮询 `max(Id)`，增量拉取；`hyt_overview` 已经给了游标起点，但还没有监听器与事件推送。
7. **inbox 对接** — 见第四节。
8. **安装与验证** — 用 `plugin_manager` `install_bundle` + 绝对路径 `/Users/ekko/Projects/deepseek-harness/plugins/hyt-im`，
   然后在新会话里调 `hyt_accounts` 验证。**尚未安装过，全部代码未经运行时验证。**
9. **`test/logic.test.mjs`** — dbro 有这个约定，本插件还没写。

### 未验证的风险点

- `src/messages.js` 的 `stats()` 里按天聚合那句 SQL 用了 `${w ? \`${w} and\` : 'where'}` 拼接，
  **没跑过**，where 为空/非空两种分支都要实测。
- `Store.loadContacts()` 对 `AddressBookDB.db` 的表名和列名是**猜的**（用 `pragma table_info` 探测
  account/nickname 类列名），没验证过真实表结构。读不到会静默退化成空表，不影响主流程。
- `pragma table_info(...)` 那行的表名转义写法 `JSON.stringify(name).replaceAll('"','"')` 是无意义的自替换，
  表名含特殊字符时会出问题；应改成白名单校验或反引号转义。
- `node:sqlite` 在 Node 22.16 是**实验性**的，import 时打 ExperimentalWarning。插件里是否会被 DSH 当成错误，待验证。

## 二、已确认的环境事实（勘察结论，别重复查）

### 客户端

- 路径 `/Applications/虹云通.app`，`CFBundleIdentifier = cloopen.rsdc`，可执行文件 `ChangHong`，版本 **6.5.8**。
- **技术栈 Qt 5.12.3**，`Contents/Frameworks/` 下有 `libRX_Agent.1.dylib`、`libRX_BusinessView.1.dylib` 等。
- **完全没有代码签名**（`codesign` 报 `code object is not signed at all`）→ 无 hardened runtime。
- 架构 **x86_64**；本机 Intel i7-9750H，x86_64 原生，无 Rosetta 变量。
- 进程名是 **`ChangHong`**（不是 yuntongxun/rongxin，`ps | grep hyt` 搜不到，踩过一次）。
- 单实例机制：`QLocalServer` 监听名 `"RongXin"`，重复启动会把请求转发给已有实例后退出。
- **没有任何 TCP 监听端口**（`lsof -nP -iTCP -sTCP:LISTEN -p <pid>` 为空）。
  → 全局监听里也没有 9846 / 15800 / 15802。
- 完整客户端源码在 `~/Projects/ChangHong/native/`（qmake 工程 `RongXin_XP.pro`），另有 `~/Projects/ChangHong/newhyt/native`。
- ⚠️ 安装的 6.5.8 **比手上源码新**：二进制里有 `sig_sendTextMessageOnlyEX`（6 参），源码 `im_agent.h` 里没有。
  凡涉及内部接口，**以二进制符号为准，源码只作参考**。

### 消息库

- 路径 `~/Documents/CHFile/<账号>/chatmsg.db`，本机有 `csT1002173`（本人罗添胜）、`csT1000735`、`cs80000008`。
- **未加密**，普通 SQLite，`journal_mode=delete`（**不是 WAL**），19.8 MB，14178 行，`max(Id)=16401`（Id 有跳号但单调递增）。
- 4 张表：`chatmsg`、`lastmsg`、`keepgroup`、`sqlite_sequence`。
- `chatmsg` 关键字段：`Id`(自增PK) `MsgId`(UNIQUE) `MsgType` `Msg`(**明文**) `Sender` `Receiver`
  `CreatedTime`(毫秒时间戳**字符串**，有 `0` 脏值) `SessionId` `SessionType` `SenderNick` `isSuccess` `Progress`
  `ReadStatus` `FileName` `FileUrl` `webTitle` `webDesc` `webUrl` `ReplyFlag` `uuid` `ServiceId`。
- **字段语义（实测）**：
  - `SessionId`：单聊 = 对方账号（`cs…`），群聊 = 群 ID（`g8…`）。
  - `SessionType`：0 = 单聊，1 = 群聊。`GroupId` 实际基本为空，**不要依赖**。
  - 方向：`Sender == 本人账号` 即发出。本人账号 = CHFile 下的目录名（`csT1002173`）。
  - `isSuccess`：1 成功、0 未完成、-2 失败。
  - 通知号 `hyt_kfpt_16823633`，`MsgType=150`，7052 条占全库一半 —— **OA 登录验证码就在这里**
    （`tools/INDEX.md` 记的「码在 chatmsg.db 的消息通知卡片里，不在短信」）。
- ⚠️ **`lastmsg.UnReadCount` 不可用**：167 个会话总未读全是 0，客户端已读就清零。判断新消息只能靠 `Id` 游标。

### 实测性能与陷阱

- 只读连接 `file:<path>?mode=ro` 或 `new DatabaseSync(path,{readOnly:true})`，两种都可用。
- `select max(Id) from chatmsg` 开销 **0.58 ms**；单次写入 2.0 ms；外部只读**不阻塞**客户端写入。
- ⚠️ **kqueue 是陷阱**：单次写入触发 **26.8 万次** VNODE 写事件（journal 文件反复创建删除）。
  必须 debounce，实测不如 200–500 ms 轮询 `max(Id)` 简单可靠。
- Node **v22.16.0**，内置 `node:sqlite` 可用（`DatabaseSync` / `StatementSync` / `constants` / `backup`）。
  `better-sqlite3` 没装，也不需要。系统 `sqlite3` CLI 是 3.51.0。

## 三、发消息：路线已定，实现未开始

**用户已选定路线 A**（dylib 注入调客户端内部接口），但后来改为「做成 DSH 插件」，
注入那条路**已停止**，未写任何注入代码。下面是已经勘察到的、下次要用的事实。

### 已排除

- **ChatSdk 9846 端口：死的。** `RX_Demo/ChatMsgStub/ChatSdk/ChatSdk.h` 里有完整 API
  （`connectServer("localhost", 9846)`、`SendTextMessageEX`、`sig_onReceiveTextMessage`），
  但只有 Windows 的 `.dll/.lib`，`Bin_mac/` 里没有 mac 版；`libRX_Agent`/`libRX_MainUI`
  二进制里各有一处 `9846` 字符串残留，**但搜不到任何 ChatSdk 类符号**，实测也没监听。
- **`RX_PluginMgr` 的 UDP 通道**（`PluginConfig.ini` 里 `LocalPort=15800`、`SunFlower Port=15802`）
  是给「向日葵远程监控」插件的（`Plugin_SunFlower=20000`，任务类型全是 CreateRemote/CreateClient），
  **不是消息通道**，且实测没监听。
- **`ProcessLintener`**（`RX_BusinessView/processlintener.cpp`）：`QLocalServer` 名 `"RongXin"`，
  协议是 **Base64(JSON)**，有账号 MD5 校验，但 `processEvent` 只处理会议/登录事件
  （`LoginStatusJoinConf` 等），**没有发消息分支**。要用得改源码重编译。
- **改本地库来「拦截发送」不可能**：本地库是事后账本，不是发送闸门。证据是撤回必须调服务端
  `POST /rx/openapi/messages/recall`。文本消息 INSERT→`isSuccess=1` 的窗口只有几十毫秒
  （库里 `isSuccess<>1` 的文本消息都是发送失败残留，`Progress=0`），只有文件类消息窗口够大
  （有 `Progress=5`/`19` 的上传中残留）。

### 可用入口：`IM_Agent` 单例 + Qt 信号槽

`RX_Agent/im_agent.h`，`class IM_Agent : public QObject`。**构造函数里 `moveToThread(AgentThreadMgr::getAgentThread())`**，
且连接是 `connect(this, SIGNAL(sig_sendTextMessage(...)), this, SLOT(slot_sendTextMessage(...)))`（默认 AutoConnection）
→ **从任意线程 emit 都会被 Qt 自动 QueuedConnection 投递到 Agent 线程执行**，跨线程安全；
`qRegisterMetaType<Agent_MsgType>("Agent_MsgType")` 已注册，QString 是内置 metatype。

源码注释明写「这些信号是提供上层业务发送请求的」，所以 **emit 信号就是官方调用方式**。

`libRX_Agent.1.dylib` 导出的关键符号（mangled / 地址）：

```
__ZN8IM_Agent8instanceEv                                            0x110c0  IM_Agent::instance()
__ZN8IM_Agent19sig_sendTextMessageE7QStringS0_13Agent_MsgTypeS0_     0xa0fd0  sig_sendTextMessage(QString,QString,Agent_MsgType,QString)
__ZN8IM_Agent21sig_sendTextMessageEXE7QStringS0_13Agent_MsgTypeS0_S0_ 0xa1040 sig_sendTextMessageEX(...,+QString jsonString)
__ZN8IM_Agent25sig_sendTextMessageOnlyEXE7QStringS0_13Agent_MsgTypeS0_S0_S0_ 0xa1130  源码里没有，6.5.8 新增
__ZN8IM_Agent20sig_onReceiveMessageE11ChatMsgData                    0xa26f0  sig_onReceiveMessage(ChatMsgData)
__ZN8IM_Agent24sig_onPreSendTextMessageEi11ChatMsgData                0xa2d10 sig_onPreSendTextMessage(int,ChatMsgData) ← 发送前拦截点
```

完整信号清单见 `im_agent.h`：发送类 `sig_sendTextMessage(EX)` / `sig_sendMediaMessageEX` /
`sig_retryMediaMessageEX` / `sig_downloadFileMessage(Ex)` / `sig_deleteMessage` /
`sig_withDrawMessage(msgId,chatId,sendId,type)` / `sig_withDrawMessageGroup` / `sig_setReadStatue` /
`sig_setTopContact` + 全套群组操作；响应类 `sig_onReceiveMessage` / `sig_onReceiveOfflineMessage` /
`sig_onReceiveFile` / `sig_onSendTextMessage(reason,msg)` / `sig_onSendMediaFile` /
`sig_onDownloadFileComplete` / `sig_onWithDrawMessage` / `sig_onOfflineMessageCount`；
拦截类 `sig_onPreSendTextMessage` / `sig_onPreSendMediaFile`。

`ChatMsgControl`（`libRX_BusinessView.1.dylib`，导出 4607 符号）也有全套：
`RX_BusinessView::instance()` → `getMsgCtrl()` → `sendTextMessage(ChatTextMsgViewData&)` /
`sendPluginMessage(QString,QString,QString)` / `sendFileMessage` / `sendPicMessage` /
`sendVoiceMessage` / `sendVideoMessage` / `sendShareUrlMessage` / `forwardMessage` /
`replyMsg` / `withDrawMessage` / `deleteMessage` / `reSendMessage`。
注意 `sendPluginMessage` 内部只是 `emit IM_Agent::instance()->sig_sendTextMessageEX(..., Agent_Msg_Type_Command, ...)`，
**发的是命令消息（type 26）不是普通文本**，别拿它当发聊天消息用。

`ChatTextMsgViewData`（`RX_DataDefine/ChatMsgData.h:134`，注释「仅供发送使用」）：
`receiver` `msgContent` `isBurn` `isAt` `userdata` `listAtAccounts`。

`Agent_MsgType`（`RX_DataDefine/AgentEnum.h:117`）：
1 文本、2 语音、3 视频、4 图片、5 位置、6 文件(压缩)、7 文件(不压缩)、8 分享链接、9 群组通知、
10 未接来电、11 群@、12 输入状态/透传、13 名片、15 大文件、17 第三方推送、20 服务器透传、
21 删除/阅后即焚通知、22 匿名开关、24 已读通知、25 撤回、26 命令控制、30 SDK透传JSON、
31 公众号、36 泛微OA、50 会议通知、60 位置共享、61 点赞。

### ABI 注意事项（下次实现必读）

- `QString(const QChar*, int)` 导出为 `__ZN7QStringC1EPK5QChari`（0xa5810，在 QtCore）；
  **没有** `QString::fromUtf8`、**没有** `QString::~QString()`（都是 inline）；
  `QArrayData::deallocate(QArrayData*, size_t, size_t)` 导出为 `__ZN10QArrayData10deallocateEPS_mm`（0x300c0）。
  → 纯 C 构造 QString 可行：UTF-8 转 UTF-16 后调 `QString(const QChar*, int)`，析构手工 deref + deallocate。
- ⚠️ **QString 有非平凡析构，按 Itanium C++ ABI 是 non-POD，参数走隐藏指针而非寄存器**。
  上次正在反汇编 `sig_sendTextMessage` 验证这一点时被中断。已拿到的反汇编开头：
  ```
  pushq %rbp / movq %rsp,%rbp / subq $0x40,%rsp
  movl %ecx, -0x34(%rbp)     ← 第 4 个参数(Agent_MsgType)在 ecx，是寄存器传递
  movq %rsi, -0x28(%rbp)     ← rsi
  movq %rdx, -0x20(%rbp)     ← rdx
  movq %r8,  -0x10(%rbp)     ← r8
  ```
  **初判：QString 是按值放在 rsi/rdx/r8 里传的（trivially relocatable 优化），不是隐藏指针**，
  但这只是函数序言，还没看到 `QMetaObject::activate` 的调用点，**结论未确认，下次必须验完再写代码**。
- macOS Qt 事件循环基于 CFRunLoop，`dispatch_async(dispatch_get_main_queue(), ...)` 可在主线程执行；
  但既然 emit 信号天然走 QueuedConnection 到 Agent 线程，**不一定需要 GCD**。
- 注入方式：客户端未签名，`DYLD_INSERT_LIBRARIES` 直接执行
  `/Applications/虹云通.app/Contents/MacOS/ChangHong` 即可（注意 `open -a` **不传递** DYLD 环境变量）；
  更干净的做法是用 `insert_dylib` 往主二进制写 `LC_LOAD_DYLIB`，之后双击图标自动加载。
  SIP 当前是 **enabled**，但 SIP 不保护未签名的第三方 app。

### 插件形态下怎么落发送

DSH 插件跑在 Node 里，不能自己注入。可行拆法：

- 插件内 `spawn` 一个外部启动器脚本，由它带 `DYLD_INSERT_LIBRARIES` 启动客户端；
- 注入的 dylib 在客户端进程内开一个本地 Unix socket 当指令入口；
- 插件通过该 socket 发「发消息」指令，收消息仍走 SQLite 轮询（不依赖注入）。
- 退路：AppleScript / 辅助功能 API 操作窗口输入框（复用 `~/agents/tools/focusdesk`），
  不碰内部符号、跨版本稳，但需要客户端在前台且脆弱于 UI 改版。

## 四、inbox 对接（未开始）

`plugins/inbox`（`dsh-inbox` 0.1.0）现状：

- **Host 半边是空的**：`index.js` 只有 `export function apply() {}`，不注册任何 service / tool / 事件。
- **Client 半边 1151 行**，`ITEMS` 是 9 条硬编码模拟数据（email 3 / todo 3 / ticket 3），
  README 明写「No real source delivers items yet: no Host service, no persistence, no read state on the Host,
  and no badge on the sidebar entry」。
- item 数据契约：`{ id, kind, unread, tone, status, title, source, time, ... }`，
  `kind ∈ {email, todo, ticket}`，字典有 `KIND_LABELS`（第 645 行）和 `GLYPHS`（第 641 行），
  状态文案在 locale 段（en 828 行起、zh 988 行起）：`status.reply` `status.confirm` `status.none`
  `status.doing` `status.todo` `status.done` `status.processing` `status.pending` `status.approval`。
- `tone` 取值见到 `warn` `active` `idle` `done`。
- 读状态是组件内 state，面板卸载或刷新就重置，**没有持久化**。

对接要做的：hyt-im 的 Host 侧注册一个可被消费的 Service（会话/未读/消息列表 + 新消息订阅），
inbox 的 Client 增加 `kind: 'im'`，把 `ITEMS` 换成从 Host 服务拉取，并补 `KIND_LABELS`/`GLYPHS`/locale。
Client 侧访问 Host 服务的机制（typert / api gateway）**还没查**，下次要先确认再动手。

## 五、DSH 插件写法速查（本仓库约定）

参照 `plugins/dbro`（结构最接近）：

- `package.json`：`dsh.bundle.patch` 指向 `cordis.patch.yml`；`exports` 要有 `.` / `./locale/*.json` / `./icon`；
  `files` 必须列全（`index.js` `src` `skills` `locale/*.json` `docs` `icon.svg` `cordis.patch.yml` `README.md`）；
  `engines.dsh` 用 `">=0.2.0 <0.3.0"`；依赖走 `peerDependencies`（`@deepseek-ai/cordis`、`dsh-tools`、
  `schemastery`、`dsh-error`、需要凭据再加 `dsh-credentials`），**不装 node_modules**，从 dsh 安装处解析。
- `cordis.patch.yml`：`- insert:\n    - id: <row-id>\n      name: '<包名>'\n      config: {}`。
- `index.js`：`export const name` / `export const inject = ['tools']` /
  `export const Config = z.object({...})`（`import z from '@deepseek-ai/schemastery'`，
  可用 `z.string().default()`、`z.natural().min().max().default()`、`z.array(z.any())`）/
  `export function apply(ctx, config)`。可选服务用 `ctx.get('skills', false)` 取，**不要用 inject 硬依赖**。
  插件根目录用 `import.meta.dirname`。
- 工具：`import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'`，
  `ctx.tools.register(defineTool({ name, description, parameters, output:{schema, render}, execute }))`。
  参数 `type` 可用 `string` `number` `integer` `boolean` `null` `array` `object` `json`，
  配 `required` `description` `enum` `items` `properties` `additionalProperties`。
  `output.render(args, value)` 返回 `[{ type:'text', text }]`。
  定义见 `packages/core/tools/src/schema.ts:555`，实例见 `packages/todo/tool-todo/src/index.ts:136`。
- 技能：`skills/<name>/SKILL.md` 带 YAML frontmatter，`skills.register({name, description, content})`。
- 安装：`plugin_manager` `action: install_bundle`，`target` 传插件目录绝对路径。**不要用 shell 复现安装步骤。**
- 其它扩展点（本次没用到，需要时查 `packages/preset/agent-preset/skills/dsh-doc/references/`）：
  `practices.md`（guard/restrict、`tools/pre-execute` 返回 `ask`、`ctx.systemPrompt.section()`、
  `agent.inject()`、`ctx.sessionProjections`、`ctx.slots`、`ctx.uiConversation.events.register()`、
  `agent.followup()`）、`host-plugin.md`、`ui-plugin.md`、`compositions.md`。

## 六、下次开工命令

```bash
# 1. 确认库还在、账号没变
sqlite3 "file:$HOME/Documents/CHFile/csT1002173/chatmsg.db?mode=ro" \
  "select count(*), max(Id) from chatmsg;"

# 2. 补 src/skill.js（否则插件加载失败）——照抄
cat /Users/ekko/Projects/deepseek-harness/plugins/dbro/src/skill.js

# 3. 语法自检
node --check /Users/ekko/Projects/deepseek-harness/plugins/hyt-im/index.js
for f in /Users/ekko/Projects/deepseek-harness/plugins/hyt-im/src/*.js; do node --check "$f"; done

# 4. 安装（用 plugin_manager，不要用 shell）
#    action: install_bundle, target: /Users/ekko/Projects/deepseek-harness/plugins/hyt-im

# 5. 新会话里验证：hyt_accounts → hyt_overview → hyt_sessions → hyt_messages
```

## 七、相关既有资产（`~/agents`）

- `tools/chatlog/chat_analyze.py`、`chat_extract.py` — 已有的本地库只读分析（Python），逻辑可参照。
- `tools/chim-msg/chim_msg.py` — 撤回，走服务端 `POST /rx/openapi/messages/recall`（**管理员接口，用户明确说不要管这套**）。
- `tools/chim-msg/chim_export.py` — 导出，走 `/rx/messages/export`。
- `skills/虹云通消息分析/SKILL.md`、`skills/运维消息撤回/SKILL.md`、`skills/虹云通聊天记录导出/SKILL.md`。
- 用户已明确：**这些技能里「不提供消息查询能力」「正文不回显」的红线，在本插件上不适用**，
  能开放的能力都开放。

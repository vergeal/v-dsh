# hyt-im 插件 · 未完成事项与勘察记录

> 更新时间：2026-11-17 23:30（Asia/Shanghai）。此文件是下次接续的入口。
> 目标：把本机虹云通消息能力做成 DSH 插件，**收消息 + 发消息**，后续对接 `plugins/inbox`。

## ⚠️ 本机是 Windows，不是 macOS

本文此前所有勘察记录都出自一台 macOS 机器（`/Users/ekko/...`、`虹云通.app`、`DYLD_INSERT_LIBRARIES`）。
**那套环境事实对当前机器不成立**，第二节已按 Windows 实测重写。具体作废项：

- macOS 客户端 6.5.8 / x86_64 / 未签名 → 本机是 **6.5.63 / 32 位（PE32）/ Inno Setup 装在 `D:\app\长虹即时通讯\`**。
- 「发消息只能走 dylib 注入」→ 本机有现成的官方 C-ABI SDK：`ECsdk.dll`，见第三节。
- 「ChatSdk 排除的理由是 mac 版不存在」→ 理由错了但结论没错：本机也**不存在** ChatSdk，见第三节。
- 第一节的「下次开工命令」原是 bash + mac 路径，已换成 PowerShell。

## 一、当前进度

### 已完成

| 文件 | 说明 |
| --- | --- |
| `package.json` | `dsh-hyt-im`，`engines.dsh` `>=0.2.0 <0.3.0`，peerDependencies 对齐 dbro |
| `cordis.patch.yml` | `- insert: [{id: hyt-im, name: 'dsh-hyt-im', config: {}}]` |
| `index.js` | `name` / `inject:['tools']` / `Config` / `apply` |
| `src/store.js` | 账号发现 + 只读连接（`readOnly` + `pragma query_only`）+ 通讯录 + `loadGroupNames` |
| `src/messages.js` | MsgType 映射、时间解析、会话/消息/搜索/统计/概况 |
| `src/render.js` | 消息行文本呈现（从 `tools.js` 拆出，因为 tools 依赖 harness，纯渲染要能单测） |
| `src/tools.js` | 7 个只读工具（含 `hyt_new` 增量消费） |
| `src/cursor.js` | `hyt_new` 的游标状态机：立基线、只朝前推进、显式设位 |
| `src/skill.js` | 随包技能注册 |
| `skills/hyt-im/SKILL.md` | 技能正文 |
| `README.md` / `docs/DETAIL.md` / `locale/{zh,en}.json` / `icon.svg` | 元数据与文档 |
| `test/logic.test.mjs` | 27 例，`node --test` 直接跑，无需 harness 依赖 |
| `test/register.mjs` | 装配检查 + 技能 `source` 回归锁 |

插件已在本 profile 启用，`source` 是 **`file:D:\dev\projects\v-dsh\plugins\hyt-im`**（直指源目录，不是安装副本）。

### 2026-11-17 修掉的缺陷

全部有回归测试锁住：

1. **随包技能加载失败**。`skills.register()` 少传 `source`，注册期不报错（`validateRuntimeSkill` 不查它），
   加载期被 `validateDefinition` 拦下：`loaded skill "hyt-im" source must be a string`。
   仓库里 44 处 `skills.register()` 调用全都传了 `source: 'runtime'`，只有本插件和 `dbro` 两个 JS 插件漏了——
   **`dbro` 同时修了**，两边都补了断言。
2. **`newestId`/`oldestId` 在默认倒序下含义颠倒**。原实现按数组首末位置取，倒序时首行是最新一条。
   调用方拿 `newestId` 当下次 `afterId` 会重复拉取已读过的消息，工具渲染里那句「最新 Id …」也是错的。
3. **`stats()` 的时间跨度起点显示成空**：`min(CreatedTime)` 把 `0` 脏值算进去了，改成 `min(case when > 0 ...)`。
4. **收到的消息被标成「发送状态:0」**。`isSuccess` 只对本人发出的消息是发送结果，本机接收侧 11342 条都是 0。
   渲染改为按 `direction === 'out'` 门控。
5. **`msgTypeName(null)` 返回 `未知(0)`**：`Number(null)` 是 0，空值要先挡。
6. **`loadContacts` 的标识符转义写错**：`JSON.stringify(name).replaceAll('"', '"')` 是自替换（原意是把 `"`
   翻倍成 SQL 转义），表名含双引号时语句直接报错，被外层 `catch` 静默吞成空通讯录。换成 `quoteIdent()`。
7. **发出的消息把本人自己的 `SenderNick` 当成对方昵称**：只在收消息时才可用 `SenderNick` 兜底。
8. `messages.js` 里一句注释与实现不符（说升序会先倒序取窗再翻正序，实现是直接 `asc limit`）。
9. `package.json` 的 `description` 宣称「向收件箱提供可消费的消息源」，而 inbox 对接根本没开始——已删掉这半句。

### 未完成（下次按此顺序做）

1. **重启 host 才能生效的运行时验证**。第 2～7 项改的是 `src/*.js`，profile 虽直指源目录，但 **ESM 模块有进程内缓存**，
   `plugin_manager` 的禁用/启用只重跑 `apply`、不会重读模块。`skill` 工具现在仍报 `source must be a string`，
   就是这个原因。**下一步先重启 DSH host，再跑：`skill hyt-im` 应成功；`hyt_messages` 的 `newestId` 应指对；
   `hyt_stats` 的「时间跨度」起点不该是 `?`；`hyt_sessions` 里被保留的群应显示群名。**
2. **`hyt_new` 已实现**（游标在插件 fiber 内存里，`peek`/`set`/`reset` 三个改位入口，`exclude` 排高噪声会话）。
   剩下的是**推送形态**：`ctx.timer` 轮询 `max(Id)` + 事件，或 `agent.followup()` 主动唤醒。用户已选择先不做，
   理由是常驻 fiber 的生命周期成本和那个 5602 条的告警号会把人刷屏。真要做，先定形态再动手。
   游标**不持久化**：host 重启后第一次调用重立基线，之前的积压不自动补；要接续得把上次的 `cursorAfter` 传给 `set`。
3. **发消息**。见第三节，卡在一个 32 位 helper 和一套登录凭据上。
4. **inbox 对接**。见第四节。
5. `test/register.mjs` 需要能解析 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools` 才跑得动。
   源码态跑不了（`dbro/test/logic.test.mjs` 同样跑不了，因为它 import 链上有 `@deepseek-ai/dsh-error`），
   这是既有环境约束。技能 `source` 的断言已同时放进 `logic.test.mjs`，那里不需要 harness 依赖，能直接跑。

### harness 侧：source 兜底已做

`packages/skill/skill/src/index.ts` 现在在 `register()` 里把 `source` 和 `provider` 一样兜底成 `'runtime'`，
`SkillRegistration` 也把 `source` 降为可选。**根因是这两个平行值不对称**：`provider` 早就兜底了，
`source` 却要调用方自己记得传，而 `validateRuntimeSkill` 不查它，于是 JS 插件漏传时注册静默通过、
加载才在 `validateDefinition` 炸掉。兜底之后这条坑对所有 JS 插件都免疫了，`hyt-im` 和 `dbro` 显式传的
`source: 'runtime'` 保持有效，不冲突。测试在 `packages/skill/skill/tests/skill.spec.ts`
（两个字段都不传时加载出的 `source` 与 `provider` 都是 `'runtime'`）。

还有一个排查陷阱留着：`register()` 遇到同名 runtime 技能会 warn 并忽略（`index.ts:451`）。
改 `skill.js` 后如果重载路径没先 dispose 旧 fiber，旧定义会留着——看到
`runtime skill "..." ignored because it is already registered` 就是这里。

## 二、本机环境事实（Windows，2026-11-17 实测）

### 客户端

- `D:\app\长虹即时通讯\ChangHong.exe`，**版本 6.5.63，32 位（machine=0x14c PE32）**，Qt 5 技术栈。
  注册表 Uninstall 键 `{1D4809AE-...}_is1`，Inno Setup 安装。进程名 `ChangHong`。
- 业务 DLL：`RX_Agent.dll`、`RX_BusinessView.dll`、`RX_MainUI.dll`、`RX_LoginUI.dll`、`RX_HttpClient.dll`、
  `RX_PluginMgr.dll` 等，全部 32 位；另有 `ECsdk.dll`（见第三节）、`Ecmedia.dll`、`wbss.dll`、`VidyoClientDll.dll`。
- 服务端：`chim.changhong.com`，`connector_port=8085`、`lvs_port=8888`、`file_port=8090`（`rxSettings_wai.ini`、
  `sdk_server_config.xml`，`Environment=wai`）。
- **进程零 LISTEN**。唯一外连是 `192.168.1.3:13556 → 221.182.19.202:8085`，另有 5 对本端双方都是自己的环回连接。
  9846 / 15800 / 15802 三个端口在本机 TCP+UDP 全无监听。

### 消息库

- 根目录 `C:\Users\Administrator\Documents\CHFile`，子目录 `Config / csT1002173 / HeadFiles / QtLogs / SdkLogs / tempImage / WbLogs`。
  **只有一个账号目录 `csT1002173`**（本人罗添胜）。macOS 上另有 `csT1000735`、`cs80000008`，本机没有。
- `csT1002173\chatmsg.db`：16,448 KB，15,318 行，`journal_mode=delete`，无 WAL/journal 侧文件。
  4 张表：`chatmsg`(15318) `keepgroup`(30) `lastmsg`(187) `sqlite_sequence`；索引 `IdIndex/MsgIdIndex/MsgTypeIndex/SessionIdIndex/TimeIndex`。
- `chatmsg` 真实 38 列：`Id, MsgType, MsgId, Msg, Sender, Receiver, CreatedTime, UserData, FileName, FileUrl,
  SessionType, LocalTime, SessionId, SenderNick, HandleResult, ReadStatus, FileSize, Progress, GroupId,
  FileFullPath, ChatType, offset, isAt, operationType, isSave, isSyncMsg, isReceiveOfflineMsg, webTitle,
  webImagePath, webDesc, webUrl, originFileSize, isSuccess, uuid, ServiceId, ReplyFlag`。
  - **`FileSize` 确实存在**（TEXT），`src/messages.js` 的 `COLUMNS` 里 19 列逐一核对全部存在。
  - `CreatedTime` 是 `VARCHAR(33)`，所以 `cast(CreatedTime as integer)` 的写法必须保留。
  - `CreatedTime = 0` 的脏行**本机 0 条**（macOS 记录里有）；防御逻辑照留。
  - `isSuccess` 分布：`-2:1155 / 0:11342 / 1:2821`。0 占大头，说明未回填是常态。
  - `GroupId` 基本为空，别依赖。
- 通讯录 `AddressBookDB.db`：344 KB，表 `Department`(0 行) 与 `Person`(1314 行)。
  `Person` 关键列 `Account VARCHAR(512) NOT NULL UNIQUE`、`Name`、`Remark`。
  **`loadContacts()` 的猜测逻辑命中 `Person` + `Account`/`Name`**（候选列表顺序先撞 `sqlite_sequence.name`，
  被「没有账号列」挡掉）。命中依赖 SQLite 标识符大小写不敏感。
  - 昵称取的是真实姓名 `Name`；`Remark` 全表为空，所以 `Name` 已是最优解。
  - **本人 `csT1002173` 不在 `Person` 里**，自己的名字解析不出来。
- 群名在 `chatmsg.db.keepgroup(GroupId, GroupName)`，30 行，群名形如「刘程、罗添胜、田杰」（`GroupType=3` 的
  成员拼接名）。`chatmsg` 里 `SessionType=1` 的 distinct 会话有 97 个，**覆盖率 30/97**；`Person` 里没有 `g8` 开头的行。
- ⚠️ `lastmsg.UnReadCount` 依然不可用，判断新消息只能靠 `Id` 游标。
- 通知号 `hyt_kfpt_16823633`（`MsgType=150`）5602 条，**OA 登录验证码在它的消息里**，不在短信。

### 性能与陷阱

- 只读连接两种都验过可用：`file:<path>?mode=ro` 与 `new DatabaseSync(path, {readOnly:true})`。
  本机**没有 sqlite3 CLI**，用 `node:sqlite`（Node v24.16.0，`node:sqlite` 已稳定）或 Python 3.13.1。
- 外部只读连接不阻塞客户端写入；`select max(Id)` 亚毫秒。
- ⚠️ macOS 上「kqueue 单次写入触发 26.8 万次 VNODE 事件」那个坑是 macOS 专属；
  Windows 上监听文件变化应该用 `ReadDirectoryChangesW`，但**结论不变：直接轮询 `max(Id)` 更简单可靠**。

## 三、发消息：Windows 上的可行入口是 ECsdk.dll

### 已排除（本机实测，别再试）

- **ChatSdk 9846 端口**：macOS 的排除理由是「只有 Windows 的 dll/lib，mac 版不存在」。**这台 Windows 上也没有**
  ChatSdk：安装目录、`C:\Program Files(x86)`、`AppData`、`ProgramData`、整个 `D:\` 全盘按文件名搜
  `ChatSdk|RX_Demo|libRX_` 命中 0；对安装目录所有 `.dll/.exe/.lib` 做内容级 ASCII 搜 `ChatSdk` 也是 0 命中。
  真实结论是「ChatSdk 是融云 Demo 侧源码产物，客户端发行包不带」。9846 也再次确认无监听。
- **`PluginConfig.ini` 的 15800/15802**：属**向日葵远程控制插件**，同目录有 `RemoteControl.exe`、`slsdk.dll`、
  `SunFlower.ini`（`AppId=68348`），且都没监听。不是消息通道。
- **任何本地 TCP/UDP 服务入口**：虹云通进程零 LISTEN，UDP 也没有。
- **改本地库拦截发送**：本地库是事后账本，不是发送闸门（撤回必须调服务端 `POST /rx/openapi/messages/recall`）。

### 可用入口：`ECsdk.dll`（5.4.2.6，C-ABI，357 个未修饰导出）

FileDescription 写 `IM、GROUP、VOIP、CONFERENCE、ALL`，**不依赖 Qt**，客户端自己就是用它登录发消息的
（`SdkLogs` 里能看到 `ECSDK_Initialize set ini cfg path` / `InitDB` / `LoginEx2 jsonContent={"comId":723,...}` /
`SetGeneralCallBackFuction`）。

按用途分组的关键导出：

```
INIT/LOGIN  ECSDK_Initialize, ECSDK_UnInitialize, Login, LoginEx, LoginEx2, Logout,
            SetServerAddress(Ex), SetServerEnvType(Ex), EnableSecureTansport
SEND        SendTextMessage, SendTextMessageEX, SendMediaMessage(EX), SendMCMMessage,
            SendMcmMediaMessage, ConferenceSendCmd, SendCmdToRest, Start/StopRecordSendVoice
CALLBACK    SetMessageCallBackFunction, SetGeneralCallBackFuction, SetVoIPCallBackFuction,
            SetConfCallBackFuction, SetChatRoomCallBackFuction, MakeCallBack
GROUP/MSG   CreateGroup(EX), JoinGroup, QueryGroupMember, WithDrawMessage(Ex),
            WithDrawMessageGroup(Ex), DeleteMessage(Ex), ReadMessageGroup, DownloadFileMessage(EX)
```

`RX_Agent.dll` 的 PE 导出表也确认 macOS 记录的那批 Qt 信号在 Windows 上同样导出（它 imports ECsdk.dll）：
`?instance@IM_Agent@@SAPAV1@XZ`、`?sig_sendTextMessage@IM_Agent@@...`、`?sig_sendTextMessageOnlyEX@...`、
`?sig_onPreSendTextMessage@...`。`RX_BusinessView.dll` 有 `?sendTextMessage@ChatMsgControl@@...`
和 `?GetInstance@ProcessLintener@@` / `?processEvent@ProcessLintener@@`。**注入这条路技术上也通，
但 ECsdk 是官方 SDK，合规性和跨版本稳定性都更好，优先它。**

### 四个前置条件（按难度排）

1. **必须 32 位进程**。全套模块 `machine=0x14c`，本机 Node 是 `x64 win32 v24.16.0`，直接 `LoadLibrary`
   必然 `ERROR_BAD_EXE_FORMAT`。OS 是 AMD64（WOW64 可用），所以需要一个 **x86 helper 进程**（原生 32 位可执行
   或 ia32 Node）承担发送，插件经 IPC 驱动它。这也是「DSH 插件（Node）不能自己直调」的硬理由。
2. **登录凭据**。`LoginEx2` 收 JSON（日志可见 `comId/connectorId/mac`），凭据来自虹云通自身登录流程
   （`ECsdk.dll` 内部不含 AppKey）。要么复用客户端已拿到的 token（候选存放处 `CHFile\login.db`、
   `Config\ecsystem.db`），要么自己走一遍登录。**两条都越出「只读本机库」的边界，动手前要用户确认。**
3. **与在跑的客户端会话冲突**。ECsdk 自己 `InitDB/SqlQuery`（本机 `Config\ecsystem.db`），同账号并发两个 SDK
   会话是否互踢取决于服务端多端策略，**必须实测，不能假设安全**。
4. **缺函数原型**。本机没有 `ECsdk.h` / `.lib`，357 个导出只能拿到名字，参数类型得靠逆向或向厂商要头文件。
   「拿到 SDK 头文件」应列为第一优先前置条件。

### 插件形态下的落法

`spawn` 一个 32 位 helper（承载 ECsdk），helper 与本插件走 IPC（stdio 或命名管道）；
收消息继续走 SQLite 只读轮询，不依赖 helper。退路是 UIA/辅助功能操作窗口输入框（不碰内部符号，
但需要客户端在前台且怕 UI 改版）。

`tools/chim-msg/chim_msg.py` 那套走服务端 `POST /rx/openapi/messages/recall` 的是**管理员接口，用户明确说不要管**。

## 四、inbox 对接（未开始）

`plugins/inbox`（`dsh-inbox` 0.1.0）现状：

- **Host 半边是空的**：`index.js` 只有 `export function apply() {}`，不注册任何 service / tool / 事件。
- **Client 半边 1151 行**，`ITEMS` 是 9 条硬编码模拟数据（email 3 / todo 3 / ticket 3），README 明写
  「No real source delivers items yet: no Host service, no persistence, no read state on the Host,
  and no badge on the sidebar entry」。
- item 契约：`{ id, kind, unread, tone, status, title, source, time, ... }`，`kind ∈ {email, todo, ticket}`，
  字典有 `KIND_LABELS`（第 645 行）和 `GLYPHS`（第 641 行），状态文案在 locale 段（en 828 起、zh 988 起）。
  `tone` 取值见到 `warn` `active` `idle` `done`。
- 读状态是组件内 state，面板卸载或刷新就重置，没有持久化。

要做：hyt-im 的 Host 侧注册一个可被消费的 Service（会话/未读/消息列表 + 新消息订阅），inbox 的 Client 加
`kind: 'im'`，把 `ITEMS` 换成从 Host 服务拉取，并补 `KIND_LABELS`/`GLYPHS`/locale。
**Client 侧访问 Host 服务的机制（typert / api gateway）还没查，动手前先确认。**

## 五、DSH 插件写法速查（本仓库约定）

参照 `plugins/dbro`（结构最接近，且这两个插件的 `src/skill.js` 是同一份模板）：

- `package.json`：`dsh.bundle.patch` 指向 `cordis.patch.yml`；`exports` 要有 `.` / `./locale/*.json` / `./icon`；
  `files` 必须列全；`engines.dsh` 用 `">=0.2.0 <0.3.0"`；依赖走 `peerDependencies`，**不装 node_modules**，
  从 dsh 安装处解析。
- `cordis.patch.yml`：`- insert:\n    - id: <row-id>\n      name: '<包名>'\n      config: {}`。
- `index.js`：`export const name` / `export const inject = ['tools']` / `export const Config = z.object({...})` /
  `export function apply(ctx, config)`。可选服务用 `ctx.get('skills', false)` 取，不要用 inject 硬依赖。
  插件根目录用 `import.meta.dirname`。
- 工具：`import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'`，
  `ctx.tools.register(defineTool({ name, description, parameters, output:{schema, render}, execute }))`。
  参数 `type` 可用 `string` `number` `integer` `boolean` `null` `array` `object` `json`。
  `output.render(args, value)` 返回 `[{ type:'text', text }]`。
  定义见 `packages/core/tools/src/schema.ts:555`，实例见 `packages/todo/tool-todo/src/index.ts:136`。
- 技能：`skills/<name>/SKILL.md` 带 YAML frontmatter，`skills.register({ name, description, content, source: 'runtime' })`。
  `source` 和 `provider` 现在都在 `register()` 里兜底成 `'runtime'`（`index.ts:457`），省略也能加载；
  本插件与 `dbro` 仍然显式传 `source`，因为注册表会把它原样透给加载路径校验
  （`runtimeCandidate`，`index.ts:699`），写出来是对该契约的自解释，不靠兜底生效。
- 安装：`plugin_manager` `action: install_bundle`，`target` 传插件目录绝对路径。不要用 shell 复现安装步骤。
  **已在本 profile 启用的插件走的是 `file:<源目录>`，改源码后必须重启 host 才会重新读模块。**
  禁用/启用（`set_bundle`）会重跑 `apply` 并重挂 fiber，但 ESM 模块缓存不变，`skill.js` 的改动不会生效。
- **`plugins/` 不在 lint 与 typecheck 覆盖范围内**：`pnpm tsx scripts/run-oxlint.ts plugins/hyt-im` 回
  「No files found to lint」，`pnpm run typecheck` 的 5 个 gate 也不检查插件 JS。插件侧的护栏只有
  `node --check`、`test/logic.test.mjs` 和运行时实测，改完必须自己跑，别指望仓库闸门兜住。
- 其它扩展点（需要时查 `packages/preset/agent-preset/skills/dsh-doc/references/`）：`practices.md`
  （guard/restrict、`tools/pre-execute` 返回 `ask`、`ctx.systemPrompt.section()`、`agent.inject()`、
  `ctx.sessionProjections`、`ctx.slots`、`ctx.uiConversation.events.register()`、`agent.followup()`）、
  `host-plugin.md`、`ui-plugin.md`、`compositions.md`。新消息监听要挑这里的形态。

## 六、下次开工命令（PowerShell，本机 Windows）

```powershell
cd D:\dev\projects\v-dsh

# 1. 回归测试（不需要 harness 依赖，源码态就能跑）
node --test plugins/hyt-im/test/logic.test.mjs

# 2. 确认库水位
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/Users/Administrator/Documents/CHFile/csT1002173/chatmsg.db',{readOnly:true});console.log(d.prepare('select count(*) n, max(Id) mx from chatmsg').get());d.close()"

# 3. 语法自检
node --check plugins/hyt-im/index.js
Get-ChildItem plugins/hyt-im/src/*.js | ForEach-Object { node --check $_.FullName }

# 4. 重启 DSH host 进程，然后在新会话里验证：
#    skill hyt-im（应当加载成功）→ hyt_accounts → hyt_overview → hyt_sessions（看群名）
#    → hyt_messages（看 newestId 水位与「发送状态」只出现在 → 开头的行）→ hyt_stats（时间跨度起点不为空）
```

## 七、相关既有资产（`~/agents`，来自 macOS 侧）

- `tools/chatlog/chat_analyze.py`、`chat_extract.py` — 本地库只读分析（Python），逻辑可参照。
- `skills/虹云通消息分析/SKILL.md`、`skills/运维消息撤回/SKILL.md`、`skills/虹云通聊天记录导出/SKILL.md`。
- 用户已明确：**这些技能里「不提供消息查询能力」「正文不回显」的红线，在本插件上不适用**，能开放的能力都开放。

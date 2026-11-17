# 虹云通消息（hyt-im）

只读检索本机虹云通消息库，把聊天记录变成模型可用的工具能力。

插件以 `readOnly` + `pragma query_only` 打开 `~/Documents/CHFile/<账号>/chatmsg.db`（普通 SQLite，未加密），
**没有任何写入口**：不登录虹云通、不调服务端接口、不发消息、不撤回，也不会与客户端争锁。

## 工具

| 工具 | 用途 |
| --- | --- |
| `hyt_accounts` | 列出发现的账号库与当前生效的账号（诊断入口） |
| `hyt_sessions` | 会话列表，按最后消息时间倒序，带收发条数与预览 |
| `hyt_messages` | 按会话/对方/时间/方向/类型/关键词查消息，支持 `afterId` 增量拉取 |
| `hyt_search` | 跨会话正文检索（子串匹配） |
| `hyt_stats` | 总量与收发比、时间跨度、按类型分布、最近 31 天按天量、最活跃会话 |
| `hyt_overview` | 库概况与 `maxId` 游标，做增量轮询的起点 |
| `hyt_new` | 取上次调用之后新到的消息，游标由插件自己持有；`peek` 只看不推进，`set`/`reset` 改位 |

`hyt_messages`、`hyt_search`、`hyt_new` 都支持 `exclude` 按会话 ID 排除：通知号 `hyt_kfpt_16823633`
一个会话就占全库三分之一，做真人对话口径时用它剔掉，不用再手动核对。
`hyt_new` 的游标存在插件 fiber 的内存里，不持久化：进程重启后第一次调用重新以当前 `maxId` 立基线，
要接续重启前的位置就传 `set`。

随包技能 `hyt-im` 给出使用顺序、字段语义与已知坑，模型按需加载。

## 配置

写在 profile 的 `cordis.patch.yml` 里该插件行的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/Documents/CHFile` | CHFile 根目录，下面是 `cs<账号>/chatmsg.db` |
| `account` | 空 | 指定账号目录名（如 `csT1002173`）；留空取最近写入的那个 |
| `maxRows` | 200 | 单次查询返回条数上限（1–5000） |
| `contentLimit` | 2000 | 单条正文字符上限，超出截断并标记；0 为不截断 |
| `busyTimeoutMs` | 3000 | 等客户端释放锁的上限 |

## 字段语义

- `SessionId`：单聊是对方账号（`cs…`），群聊是群号（`g8…`）；`sessionType` 为 `single` / `group`。
- 方向：`Sender` 等于本人账号（即 CHFile 下的目录名）就是发出。
- `CreatedTime`：毫秒时间戳字符串，库里存在 `0` 的脏值；统计的时间跨度起点会跳过它们。
- `isSuccess`：1 成功、0 未完成、-2 失败。**只对发出的消息有意义**：收到的消息里它是本地落库水位，
  本机 15318 条中 11342 条是 0，所以渲染只在 `direction=out` 时显示它。
- `MsgType`：1 文本、2 语音、3 视频、4 图片、6/7 文件、11 群@、25 撤回、26 命令、150 服务号卡片。
- 显示名：单聊取通讯录 `AddressBookDB.db` 的 `Person.Name`，群聊取消息库 `keepgroup.GroupName`，
  都没命中就回退成账号或群号。

## 已知限制

- **未读数不可用**：`lastmsg.UnReadCount` 会被客户端清零，常年为 0。判断新消息只能用 `Id` 游标。
- 通知号 `hyt_kfpt_16823633`（`MsgType=150`）占全库近一半，做「真人对话」口径时要排掉；
  **OA 登录验证码就在这个号的消息里**。
- **群名只覆盖一部分群**：`keepgroup` 存的是被保留的群（本机 30 个），而 `chatmsg` 里有 97 个不同群会话，
  其余群聊显示成群号。本人账号也不在通讯录 `Person` 表里，解析不出自己的名字。
- 依赖 Node 内置 `node:sqlite`，无外部依赖、无需编译。Node 22 下它是实验特性（`--experimental-sqlite`，
  会打 ExperimentalWarning），Node 24 起为稳定 API；本机跑在 v24.16.0。
- **发消息尚未实现**。Windows 客户端是 32 位，可行入口是随客户端发布的 `ECsdk.dll`（C-ABI，导出
  `SendTextMessage` 等），但它要求一个 32 位 helper 进程和登录凭据，已越出「只读本机库」的边界。
  路线、前置条件与已排除项见 [docs/TODO.md](docs/TODO.md) 第三节。

## 检查

```sh
node --test plugins/hyt-im/test/logic.test.mjs   # 纯逻辑 + 内存库行为，无需连客户端
node plugins/hyt-im/test/register.mjs            # 装配检查，需要依赖可解析的安装环境
```

## 布局

```
index.js               插件入口：name / inject / Config / apply
src/store.js           账号发现 + 只读连接 + 通讯录昵称 + 群名
src/messages.js        类型映射、时间解析、会话/消息/搜索/统计
src/render.js          消息行文本呈现，不依赖 harness，便于单测
src/cursor.js          hyt_new 的增量游标状态机
src/tools.js           hyt_* 工具注册
src/skill.js           随包技能注册
skills/hyt-im/SKILL.md 技能正文
test/logic.test.mjs    纯逻辑与内存库行为检查
test/register.mjs      装配检查：Config、工具与技能注册面
docs/TODO.md           未完成事项与全部勘察记录（接续入口）
docs/DETAIL.md         插件详情页文档
locale/{zh,en}.json    Plugin Manager 标题与描述
icon.svg               插件图标
```

安装：**Plugins** › **Add plugin** 选择本目录，或用 `plugin_manager` 的 `install_bundle`。

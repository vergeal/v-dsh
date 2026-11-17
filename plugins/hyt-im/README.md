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
- `CreatedTime`：毫秒时间戳字符串，库里存在 `0` 的脏值。
- `isSuccess`：1 成功、0 未完成、-2 失败。
- `MsgType`：1 文本、2 语音、3 视频、4 图片、6/7 文件、11 群@、25 撤回、26 命令、150 服务号卡片。

## 已知限制

- **未读数不可用**：`lastmsg.UnReadCount` 会被客户端清零，常年为 0。判断新消息只能用 `Id` 游标。
- 通知号 `hyt_kfpt_16823633`（`MsgType=150`）占全库近一半，做「真人对话」口径时要排掉；
  **OA 登录验证码就在这个号的消息里**。
- 依赖 Node 22 的内置 `node:sqlite`（实验性），无外部依赖、无需编译。
- **发消息尚未实现**，方案与勘察结论见 [docs/TODO.md](docs/TODO.md) 第三节。

## 布局

```
index.js               插件入口：name / inject / Config / apply
src/store.js           账号发现 + 只读连接 + 通讯录昵称
src/messages.js        类型映射、时间解析、会话/消息/搜索/统计
src/tools.js           hyt_* 工具注册
src/skill.js           随包技能注册
skills/hyt-im/SKILL.md 技能正文
docs/TODO.md           未完成事项与全部勘察记录（接续入口）
docs/DETAIL.md         插件详情页文档
locale/{zh,en}.json    Plugin Manager 标题与描述
icon.svg               插件图标
```

安装：**Plugins** › **Add plugin** 选择本目录，或用 `plugin_manager` 的 `install_bundle`。

# dsh-group-chat —— 把多个 DSH 对话拉进一个群聊

> 让不同对话里的 agent 在一个「群」里发言，由当前发言者判断谁最该接话；你在同一个面板里围观、随时插话，用 `@别名` 点名某一位，或 `@所有人` 让全员回应。

这是 DSH（DeepSeek Harness）的本地插件，包含 Host 侧引擎和 Web 客户端面板。它不修改 DSH 内核，只使用现有的 `sessionController` 与 `session/event`。

---

## 它长什么样

- 左侧栏多一个 **对话群聊** 入口，点开是一个全屏面板。
- 建群时选 2~6 个现有对话，填群名、话题、最大轮数；也可以勾选 **不限制轮数**。
- 默认由**当前发言者自己决定下一位**（按成员身份和最近发言判断），也可以切回按顺序轮流；需要全员表态时它会发 `[[all]]`，所有人依次回应。
- 每条发言都带着最近的群聊记录（最近 6 条、每行最多 260 字），所以每个对话都像真的在群里；历史只作背景，提示词会把「本轮要做的事」放在最前面。
- 你可以在底部输入框发言：
  - 直接说 → 最合适的那位（或当前轮到的成员）回应；
  - `@某位成员` → 被点名的人立刻回应；
  - `@所有人`（或点 @ 菜单里的「所有人」）→ **同时**发给每个成员，等所有人回复完就结束；
  - 正在生成时插话 → 消息先入群，等这一轮说完再处理。
- 选人列表只显示有内容的对话，左侧聊天列表里不显示的空白会话不会出现在这里。
- 顶栏有 **开始 / 暂停 / 继续 / 结束 / 删除**，以及当前轮数；已经有上限的房间可以点 **解除上限**。

## 工作原理

```text
DSH Session A ──turn/end──┐
                          ├─► GroupChatEngine ──prompt──► Session B
DSH Session B ──turn/end──┘         │
                                    └─ 群聊记录（最近 12 条）
```

- Host 插件监听 `ctx.on('session/event')`，在成员会话 `turn/end` 且本轮正常完成时，取该轮最后的 `assistant/message` 文本。
- 引擎把文本写进群聊记录，然后调用
  `ctx.sessionController.prompt({ sessionId, requestId, content })`
  叫下一位。目标会话不在线会先冷恢复；正在跑时消息进 inbox 排队。
- 每条投递都带 `requestId`，并用 `user/message` 的 `source.rpcId` 回验，避免把用户自己插话的回复误当成群聊回复。
- 数据落在 `~/.dsh/group-chat/rooms.json`，原子写入。DSH 重启后，原本运行中的群会变成「已暂停」，不会偷偷继续烧 token。

## 已验证

- 单元测试 **27/27**：自动选人、`[[next]]`/`[[all]]`/`[[end]]`、`@所有人`、按顺序轮转、插话排队、暂停/继续、停止词、不限轮数、解除上限、冷恢复顺序、runtime-context 不覆盖 requestId、同路径路由只注册一次、空白会话过滤。
- 实机双会话：会话 A 发言 → 自动转给 B → B 以 `[讨论结束]` 收口，房间 `done`。
- 侧栏「对话群聊」入口已加载（客户端 bundle 注册成功），host 的 `/sessions`、`/rooms`、`/room`、`/action` 均可用。

## 安装

### 方式一：插件管理器（推荐）

1. 打开 DSH 的 **设置 → 插件**。
2. 选择从本地目录安装，目录填本仓库的绝对路径，例如：
   `~/Documents/dsh-group-chat`
3. 安装后刷新页面；左侧栏出现「对话群聊」。

### 方式二：手动 link

把这个目录放到任意位置，然后在 `~/.dsh/profiles/desktop/package.json` 里登记：

```json
{
  "dependencies": {
    "dsh-group-chat": "link:/Users/you/Documents/dsh-group-chat"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-group-chat"
      ]
    }
  }
}
```

`link:` 后面写绝对路径（`~` 不会被展开）。然后在 profile 目录跑一次 install 并重启 DSH：

```sh
cd ~/.dsh/profiles/desktop
pnpm install
```

> 手动改 profile 前先备份 `package.json`。装坏了把备份还原、`pnpm install`、重启即可。
> 已登记在 `dsh.profile.bundles` 的 bundle **不要**再往 `cordis.patch.yml` 追加 `- insert:`，两处都写会重复注册。

## 使用

1. 左侧栏点 **对话群聊** → **新建群聊**。
2. 勾选两个以上对话（建议 2~4 个；每个对话保留自己的人设和上下文）。
3. 填话题，例如「 API 分层要不要拆」；最大轮数建议 6~12。
4. 创建后点 **开始**。第一位成员会先发言，之后由发言者决定下一位。
5. 想插话直接在底部输入；`@成员名 ` 可以点名，`@所有人` 会让每个成员都回应。成员名就是建群时选的对话标题。
6. 达到轮数、成员输出 `[讨论结束]`、或你点 **结束** 时停止。

## 安全与成本闸门

- 默认最多 12 轮，硬上限 40 轮；每轮只投递一条消息。
- 每个群最多 6 个成员；消息记录最多 400 条；单条消息最多 6000 字。
- 转述只带最近 6 条、总计 1600 字、每行 260 字，避免上下文无限膨胀；面板里可「清空历史」，清空后每轮只带新发言。
- 成员回复必须带结束标记 `[讨论结束]` / `【讨论结束】` / `/结束` 才会提前收口。
- 暂停后当前这一轮仍会跑完，但不会再叫下一位。
- 检测到成员会话被其他人直接输入时，讨论自动暂停，避免抢话。
- 所有路由走 DSH 的 `connection` 信任栅栏：只接受回环地址或已登录的同源请求。

## 已知边界

- **消息级实时，不是 token 级。** 群聊面板每 900ms 拉一次状态；成员生成时显示「正在输入…」，完整回复到达后入群。把半句话喂给另一个模型没有意义，所以不做。
- **上下文不共享。** 每个成员只看到转述的最近记录，不知道对方完整历史。需要共享背景时，把背景写进「话题」。
- **注入的是 user 消息。** 在成员自己的会话里，这条群聊转述看起来像用户发言；信封里已注明「这是跨对话群聊的转述」。
- **单进程。** 依赖 Host 进程内的 `sessionController`；DSH 退出后群聊暂停，不支持多进程协作。
- **成员会话被归档 / 写锁占用 / 模型不可用** 时，投递会失败并把群标记为「出错」或「暂停」。
- **冷恢复的顺序是 `turn/start` 先、群聊 `user/message` 后**；引擎按 `requestId` 对齐、取本轮最后一条 `assistant/message`，不会因为 seq 顺序丢掉回复。
- **成员会话的 cwd 必须存在**；不存在时模型调用会报 `working-directory: directory does not exist`，房间会暂停并给出系统消息。
- **不限轮数会一直消耗 token**：0 轮上限只取消自动停止，停止词、暂停和结束按钮仍然有效；不要让它在无人看管时整夜跑。
- **自动选人依赖发言者在结尾写路由指令**（`[[next: 别名]]` / `[[all]]` / `[[end]]`）；没写或写错会回退到下一位，不会卡死。指令会在入群前被剥掉，不会展示。
- **全员回应是并行的**：`@所有人` 和成员 `[[all]]` 会把同一条消息同时投给所有目标成员，收齐全部回复后这一轮直接结束（不再自动轮转），期间用户插话会排队但通常会被结束丢弃。
- **空白会话不出现在选人列表**：左侧聊天列表本来就不显示它们；想拉一个新对话，先在里面说一句话让它有内容。

## 开发

```sh
node --test tests/engine.test.mjs tests/host.test.mjs
```

- `lib/engine.js`：纯逻辑，注入假 `prompt` 即可测试。
- `lib/index.js`：Host 入口、HTTP 路由、持久化。
- `lib/client.js`：`window.__ModuleLoader__` 客户端模块，注册 `main` 面板与 `sidebar.panellist` 入口。

## 文件

```text
.
├─ package.json          # bundle manifest（dsh.bundle.patch + dsh.client）
├─ cordis.patch.yml      # 把插件插进 profile
├─ icon.svg
├─ locale/{zh,en}.json   # 插件管理器的标题/描述
├─ lib/
│  ├─ engine.js          # 群聊状态机
│  ├─ index.js           # Host 插件入口 + HTTP API
│  └─ client.js          # Web 面板
└─ tests/
   ├─ engine.test.mjs
   └─ host.test.mjs
```

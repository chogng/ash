# `app` 终端

> 状态：Proposed。本文是外部 AI CLI 接入、Terminal Pane、PTY 和终端协议边界的唯一说明。窗口层级见 [`LAYOUT.md`](LAYOUT.md)，终端模型实现见 [`ash-terminal`](terminal/README.md)，PTY 实现见 [`ash-utils-pty`](../ash-rs/utils/pty/README.md)。

## 快速理解

Terminal 是外部 AI CLI 和其他交互式进程的通用运行与显示容器。Ash 是产品内唯一称为 Agent 的能力；Codex、Claude Code、Gemini CLI 等外部工具作为独立 CLI 进程运行，不进入 Ash 的 Agent、Thread、Tool 或 Approval 状态。

| 用户操作 | Terminal 行为 | Terminal 不做什么 |
| --- | --- | --- |
| 打开一个 AI CLI | 使用对应启动适配生成可执行文件、参数、工作目录和环境，再创建 PTY | 不通过 shell 字符串拼接命令 |
| 与 CLI 交互 | 把键盘、IME、粘贴、鼠标和窗口尺寸转换为终端输入 | 不把输入改写成 Ash 消息 |
| CLI 输出内容 | 按终端协议更新 grid、光标、样式、标题和滚动历史 | 不解析屏幕文字来猜 ToolCall、状态或权限 |
| CLI 进入 TUI | 在同一个 Terminal Pane 中继续处理 alternate screen 和 mouse mode | 不创建另一套窗口 Surface |
| CLI 退出 | 显示真实退出状态，由产品决定关闭、保留或重新启动 Pane | 不伪造外部 CLI 的会话恢复能力 |

## 调用关系

```text
用户选择 AI CLI
└─ AI CLI adapter
   └─ executable + argv + cwd + environment
      └─ Terminal session
         └─ PTY process
            ├─ output bytes → ash-terminal → Terminal Pane
            └─ keyboard / IME / paste / mouse / resize → PTY
```

一个 `PaneInput::Terminal` 只引用一个 Terminal session。Terminal session 的身份必须独立于 Ash App Server 的 `SessionId`；一个 Ash Session 可以同时打开零个或多个 Terminal Pane，每个 Pane 可以运行不同的 AI CLI 或普通交互式进程。

## 所有权

| 能力 | 负责人 | 边界 |
| --- | --- | --- |
| Ash Agent、Thread、Tool、Approval | Ash Core / App Server | 不读取 Terminal grid 推断状态，不拥有外部 CLI 进程 |
| AI CLI 发现和启动适配 | 每个 AI CLI 的独立 adapter crate | 隔离 SDK/CLI 依赖，确定 executable、argv、cwd、environment 和恢复参数；不实现终端协议 |
| CLI 认证、配置和历史 | 外部 CLI | 产品只使用 CLI 明确提供的入口，不读取或复制私有凭据和内部历史 |
| Terminal session 与 Pane binding | Terminal host / `ash-terminal-runtime` | 管理启动、退出、活动 Pane、resize 和 runtime binding；不解释 AI 语义 |
| PTY process 与字节传输 | `ash-utils-pty` | 创建进程、读写字节和调整窗口尺寸；不拥有 Pane 或 CLI catalog |
| ANSI/VT、screen、grid 和输入编码 | `ash-terminal` | 维护终端状态和有界回滚；不识别 Codex、Claude、Gemini 或 Ash |
| Terminal Pane 绘制和输入路由 | `app` host + `zui` | 把 Terminal session 挂入当前 PaneGroup；不保存第二份终端状态 |

`app-rs/workbench/application` 只做应用接线。CLI 的 executable discovery、启动参数、环境策略、认证检查和恢复规则必须留在对应 adapter crate，不能堆进 Workbench 组合层或 `ash-terminal`。

## AI CLI 适配器

每个 adapter 只处理一个外部 CLI 的真实契约：

- 定位并验证可执行文件；
- 生成无 shell 插值的参数列表；
- 声明工作目录和允许传入的环境变量；
- 提供 CLI 明确支持的新建、继续或恢复参数；
- 把版本、缺失、启动失败和不支持的恢复方式返回为明确错误；
- 只有 CLI 提供正式 JSON、RPC 或 hook 时，才通过独立结构化通道发布事件。

结构化通道不经过 Terminal screen。Terminal 继续显示 CLI 的真实输出，adapter 也不能把外部事件写成 Ash Thread fact。

## Terminal Pane

目标 `PaneInput` 保持 `Agent` 与 `Terminal` 分离：

| `PaneInput` | 内容 |
| --- | --- |
| `Agent` | 只表示 Ash Agent 的 Session + Thread |
| `Terminal` | 一个外部 AI CLI、shell 或其他交互式进程 |

同一 PaneGroup 可以打开多个 Terminal 输入并通过组内 Tab 切换；需要同时查看时由 `PanePart` 拆分 PaneGroup。Terminal 不拥有顶层 Tab、Pane 拓扑或窗口响应式策略。

外部 AI CLI 自己拥有输入界面，因此 AI CLI Terminal 默认使用完整 grid 并直接接收输入。现有 primary screen 的 BlockList 和固定底部 CommandInputEditor 是 shell 产品模式，不作为 AI CLI 的通用外壳。

## 当前实现与差距

当前实现已经具备 PTY、Terminal Pane 分屏、ANSI/VT grid、primary/alternate screen、基础 mouse mode、selection、clipboard、IME、resize、OSC title 和有界 scrollback。当前 `PaneInput::Terminal` 仍使用 App Server `SessionId`，启动路径默认创建 shell，并包含 BlockList 和底部 Composer 语义。

完成外部 AI CLI 接入需要：

1. 建立独立 Terminal session identity，解除与 App Server `SessionId` 的一对一绑定。
2. 为每个实际接入的 AI CLI 提供独立 adapter crate 和可验证启动描述。
3. 让 AI CLI Terminal 默认进入完整 grid，输入直接交给绑定的 PTY。
4. 让标题、图标、运行状态和退出状态来自启动描述与真实进程，不从输出文字猜测。
5. 删除 Terminal-first、Agent Terminal 会话流和 Terminal 作为窗口主体的产品假设。

## 长期边界

- Agent 永远只表示 Ash；外部 AI 产品统一作为 CLI session 显示。
- Terminal 只理解终端协议、输入和进程状态，不理解 AI provider、模型、ToolCall、权限或任务完成度。
- 外部 CLI 的认证、会话和权限不能伪装成 Ash 的认证、Thread 和 Approval。
- CLI 专属判断留在 adapter crate，不能进入 `ash-terminal`、`zui` 或通用 Workbench crate。
- Terminal output 是外部进程的显示结果，不是 Ash 的 durable transcript 或结构化证据。

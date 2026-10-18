# Terminal 可选贡献

此目录拥有独立的终端用户能力，消费 [Terminal 界面](../terminal/README.md) 与 [实例服务](../terminal/README.md) 的公开契约，不创建第二份实例集合、PTY 连接或屏幕。

生产入口由 `terminal/terminal.all.ts` 统一装载，每项能力保留自己的 contribution 注册。links 按实例拥有 xterm 链接 provider、路径解析、悬停、打开操作和键盘选择器；屏幕只提供原 buffer 和 widget 承载。voice 注册开始/停止听写动作，`terminalVoice.ts` 拥有录音对应的实例和界面生命周期。语音文字进入原实例输入链，换实例、退出或隐藏面板取消录音，执行仍由用户按 Enter 触发。

文件链接支持相对路径、绝对路径、引号和空格、`file://`、家目录及编译器 / Python / 栈帧行列位置。`terminalLinkParsing.ts` 只产生候选，`TerminalLinkContribution` 使用命令所在行的 cwd、`IPathService` 和原文件服务确认文件，再通过编辑器服务打开；远端资源保留终端所属文件夹的 authority。鼠标 provider 和“打开检测到的链接”共用解析，Ctrl/Cmd+Shift+O 打开可搜索列表，Escape 返回终端，接受文件后由编辑器接收焦点。文本索引通过真实 buffer cells 换算成范围，覆盖宽字符和自动换行。状态、进程或工作区切换会撤回过期结果，关闭释放 provider、OSC 8 handler、悬停和选择器。HTTP(S) 检测和现有网页打开规则继续生效。

Find 按实例持有查询和大小写、整词、正则选项，使用该实例屏幕的 SearchAddon 搜索解析后的内容与回滚缓冲区。结果数通过 live region 读出；Enter / Shift+Enter 和 F3 / Shift+F3 导航，macOS 还支持 Command+G / Command+Shift+G。Escape 清除搜索高亮并恢复终端焦点。隐藏面板或切换实例保留查询；关闭实例释放控件、插件、监听器与上下文。Find 帮助使用已有 `accessibility.verbosity.find` 设置，Alt+F1 打开帮助，关闭后恢复原控件焦点。

links 和 voice 仍属于部分实现，不能代表上游完整 provider 或 API。目录链接、工作区搜索型链接、外部链接 provider、最近目录、Shell 历史导入、Quick Fix、Sticky Scroll、Suggest 等仍需从真实用户入口逐项接入。最近命令已由 history 贡献持久化并提供选择重跑。终端输出的帮助、Accessible View 和 verbosity 已由 accessibility 贡献装载；Find 与语音自身的帮助分别保留各自职责。

新增贡献之前必须确定下层公共能力、状态 owner 和释放边界。命令与配置由各自 `.contribution.ts` 注册；界面消费前端事件和类型，不导入 Rust DTO。命令检测中的屏幕位置归 xterm，Shell 命令完成状态归执行后端，不能让贡献自行从输出文字猜测 exit code 或重新执行命令。

各目录的文件对应与后续能力见 [Terminal 进程与屏幕契约](../../../../../docs/terminal.md)。用户已批准将 `voice/browser/terminalVoice.css` 的样式迁回 `terminal/browser/media/terminalVoice.css`；听写会话仍在本目录。

Clipboard 贡献按实例提供复制、复制并清除、粘贴命令；Linux 另提供 selection clipboard 粘贴。焦点选区键只影响终端复制快捷键，无选区 Ctrl+C 仍发送给 Shell。宿主剪贴板读取完成后再次检查实例、连接代次、活动项与屏幕可用性；切换回来也不会发送失效结果。粘贴使用 `sendText` 的换行、child paste mode 与输入确认，不复制输入队列。关闭实例释放监听和 DOM 上下文。HTML／资源粘贴、copy-on-selection、多行确认与 clipboard 配置仍未实现。

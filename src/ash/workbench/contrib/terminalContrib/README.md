# Terminal 可选贡献

此目录拥有独立的终端用户能力，消费 [Terminal 界面](../terminal/README.md) 与 [实例服务](../terminal/README.md) 的公开契约，不创建第二份实例集合、PTY 连接或屏幕。

生产入口由 `terminal/terminal.all.ts` 统一装载，每项能力保留自己的 contribution 注册。links 按实例拥有 xterm 链接 provider、路径解析、悬停、打开操作和键盘选择器；屏幕只提供原 buffer 和 widget 承载。voice 注册开始/停止听写动作，`terminalVoice.ts` 拥有录音对应的实例和界面生命周期。语音文字进入原实例输入链，换实例、退出或隐藏面板取消录音，执行仍由用户按 Enter 触发。

文件链接支持相对路径、绝对路径、引号和空格、`file://`、家目录及编译器 / Python / 栈帧行列位置。`terminalLinkParsing.ts` 只产生候选，`TerminalLinkContribution` 使用命令所在行的 cwd、`IPathService` 和原文件服务确认文件，再通过编辑器服务打开；远端资源保留终端所属文件夹的 authority。鼠标 provider 和“打开检测到的链接”共用解析，Ctrl/Cmd+Shift+O 打开可搜索列表，Escape 返回终端，接受文件后由编辑器接收焦点。文本索引通过真实 buffer cells 换算成范围，覆盖宽字符和自动换行。状态、进程或工作区切换会撤回过期结果，关闭释放 provider、OSC 8 handler、悬停和选择器。HTTP(S) 检测和现有网页打开规则继续生效。

Find 按实例持有查询和大小写、整词、正则选项，使用该实例屏幕的 SearchAddon 搜索解析后的内容与回滚缓冲区。结果数通过 live region 读出；Enter / Shift+Enter 和 F3 / Shift+F3 导航，macOS 还支持 Command+G / Command+Shift+G。Escape 清除搜索高亮并恢复终端焦点。隐藏面板或切换实例保留查询；关闭实例释放控件、插件、监听器与上下文。Find 帮助使用已有 `accessibility.verbosity.find` 设置，Alt+F1 打开帮助，关闭后恢复原控件焦点。

history 贡献持久化最近命令并提供选择重跑。终端输出的帮助、Accessible View 和 verbosity 由 accessibility 贡献装载；Find 与语音自身的帮助分别保留各自职责。

新增贡献之前必须确定下层公共能力、状态 owner 和释放边界。命令与配置由各自 `.contribution.ts` 注册；界面消费前端事件和类型，不导入 Rust DTO。命令检测中的屏幕位置归 xterm，Shell 命令完成状态归执行后端，不能让贡献自行从输出文字猜测 exit code 或重新执行命令。

跨层生命周期与各项能力的适用范围见 [Terminal 职责与运行契约](../../../../../docs/terminal.md)。听写样式归 `terminal/browser/media/terminalVoice.css`，听写会话归本目录。

Clipboard 贡献按实例提供复制、复制并清除、粘贴命令；Linux 另提供 selection clipboard 粘贴。焦点选区键只影响终端复制快捷键，无选区 Ctrl+C 仍发送给 Shell。命令与浏览器 paste 共用 `shouldPasteTerminalText` 的多行决策及 `terminal.integrated.enableMultiLinePasteWarning` 设置。宿主剪贴板读取和确认完成后再次检查实例、连接代次、活动项与屏幕可用性；切换回来也不会发送失效结果。命令标记的复制／选区由 DecorationAddon 读取原 command capability 范围；重跑请求通过 xterm 事件到达本实例贡献，在未受信文本确认前后核对输入代次及原命令成员身份。所有发送复用实例 `sendText` 与输入确认，不复制输入队列。关闭实例释放监听和 DOM 上下文。`copyOnSelection` 和 `rightClickBehavior` 沿原输入、选区与焦点 owner 工作；HTML／资源粘贴不转换为文本执行。

Sticky Scroll 仅投影原命令 markers 与屏幕，不保存命令副本。Suggest 显式读取可信历史和授权目录项，Quick Fix 识别最新失败 Git 命令的保留输出；两者接受后只填入终端，执行仍由用户按 Enter。实例、输入、命令范围和工作区变化撤回过期结果。

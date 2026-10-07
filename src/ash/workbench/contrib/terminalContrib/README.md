# Terminal 可选贡献

此目录拥有独立的终端用户能力，消费 [Terminal 界面](../terminal/README.md) 与 [实例服务](../terminal/README.md) 的公开契约，不创建第二份实例集合、PTY 连接或屏幕。

当前生产入口只有 `links/browser/terminal.links.contribution.ts` 和 `voice/browser/terminal.voice.contribution.ts`，由 `terminal/browser/terminal.contribution.ts` 加载。links 注册打开检测到的 URL 命令，当前检测与选择由活动实例 Widget 实现；voice 注册开始/停止听写动作，`terminalVoice.ts` 拥有录音对应的实例和界面生命周期。语音文字进入原实例输入链，换实例、退出或隐藏面板取消录音，执行仍由用户按 Enter 触发。

这两项属于部分实现，不能代表上游完整 links provider 或 voice API。终端专属无障碍帮助、输出 Accessible View、verbosity 设置、Find、历史、Quick Fix、Sticky Scroll、Suggest 等仍需从真实用户入口逐项接入。语音自身的听写帮助不等于终端输出的无障碍能力。

新增贡献之前必须确定下层公共能力、状态 owner 和释放边界。命令与配置由各自 `.contribution.ts` 注册；界面消费前端事件和类型，不导入 Rust DTO。命令检测中的屏幕位置归 xterm，Shell 命令完成状态归执行后端，不能让贡献自行从输出文字猜测 exit code 或重新执行命令。

各目录的文件对应、仅 Ash 的 `voice/browser/terminalVoice.css` 及待决定归属见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。本轮没有新增未被生产调用的能力 store、provider 或贡献占位文件。

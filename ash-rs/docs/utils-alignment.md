# Codex utils 与 Ash 的能力对照

Ash 按能力及依赖边界安排实现，不按 Codex 的 crate 名称复制目录。本次对照本地 `../codex/codex-rs/utils` 的 26 个目录，重点检查实际调用链、持久化边界和进程生命周期。

| Codex utils | Ash 的负责位置 | 结论 |
| --- | --- | --- |
| absolute-path | `utils/absolute-path` | 已有绝对路径、词法规范化和序列化边界；不增加未使用的别名 |
| approval-presets | `action-policy`、`execpolicy`、客户端权限选择器 | 权限由 Ash 的 action、规则和授权契约决定，不复制 Codex 预设值 |
| audio | `utils/audio`、`attachments`、`core`、`ash-api` | 新增容器校验、时长估算、普通会话附件及模型编码；详见下节 |
| cache | `utils/cache` | 修复普通线程和单线程异步运行时不能可靠复用缓存的问题；同步初始化共享互斥锁 |
| cargo-bin | `test-binary-support`、`install-context` | 测试 helper 与产品可执行文件发现各有负责位置 |
| cli | `cli`、`config` | 参数、恢复命令和权限选项由 Ash 产品解释；不引入 Codex CLI 配置协议 |
| elapsed | `utils/elapsed` | 已有时间累计能力 |
| fuzzy-match | `code/tui/src/widgets/list_selection/matcher.rs` | 当前列表搜索已有前缀、子串和模糊匹配；不新增空的公共封装 |
| git-discovery | `git/src/repository.rs`、`git/src/client.rs` | 已有工作树/元数据发现和有超时、输出限制的 Git 子进程；与上游可选元数据探测的契约不同 |
| home-dir | `utils/home-dir`、`home` | 使用 Ash home 及显式路径规则 |
| image | `utils/image`、`attachments` | 已有格式、大小、尺寸校验，持久引用及按模型限制缩放 |
| json-to-toml | `utils/json-to-toml` | 已有转换能力；不扩张接口 |
| oss | `ollama`、`models-manager`、模型提供商配置 | 已有服务探测、安装列表、下载进度、取消；其他兼容服务通过提供商配置接入 |
| output-truncation | `utils/output-truncation`、`tools/src/output.rs`、`core/src/context/input_limits.rs` | 文本预算与媒体内容分别处理；补正极大字节数的向上取整 |
| path-uri | `utils/path-uri` | 补充不透明 URI 判断、字节解码、深度、包含/重叠及安全子路径拼接；保持路径约定隔离 |
| path-utils | `utils/path-utils`、`install-context` | 补正符号链接循环、相对目标、原子写权限保留；可信程序发现仍由 install-context 负责 |
| plugins | `core-plugins`、`external-agent-migration` | Ash 清单与外部生态导入各自负责；不把另一产品的清单变成通用协议 |
| pty | `utils/pty`、`windows-sandbox` | 已补 Unix 取消/回收；补 Windows 客户端生命周期、创建句柄释放和系统 ConPTY 加载 |
| readiness | `mcp/src/session.rs` 等连接状态拥有者 | 初始化完成后才暴露可用会话；当前没有需要独立 readiness 标志的调用方 |
| redacted-string | `secrets/src/value.rs` | `SecretValue` 隐藏调试内容并在释放时清零，不提供隐式序列化 |
| rustls-provider | `http-client/src/outbound_network.rs`、`websocket-client` | TLS 配置明确选择加密实现，WebSocket 复用该配置 |
| sandbox-summary | `sandboxing`、`action-policy`、客户端展示 | 沙箱能力和授权结果使用 Ash 的类型；客户端负责文案 |
| sleep-inhibitor | `utils/sleep-inhibitor`、`core`、`app-server` | 已接入活跃 Agent 执行，按进程共享抑制资源并随执行结束释放 |
| stream-parser | `utils/stream-parser` | 已有增量解析和隐藏片段处理 |
| string | `utils/output-truncation` 及字符串所属领域 | 已有 UTF-8 截断和 token 估算；UUID 提取、指标标签和链接语法仅在实际领域需要时提供 |
| template | `utils/template` | 已有模板展开能力 |

## 普通会话音频

- `utils/audio` 校验 WAV、MP3、M4A、WebM、Ogg，最多 16 MiB、一个音轨、一小时；时长从容器包读取。
- 图片和音频使用 `ash-attachment-store` 的同一个 `AttachmentStore`。先保存字节，再把摘要、格式、大小、时长组成的音频引用写入会话。
- 上传、Turn 接收、steer、历史恢复、上下文组装及工具结果沿各自已有入口处理音频；无效内容在持久事件之前拒绝。
- 模型调用只把请求副本中的引用转换为音频 data URL，上下文按时长估算，不按 base64 字符数计费或裁剪。
- Chat Completions 接受用户消息中的 WAV/MP3；ChatGPT Responses 使用 `input_audio.audio_url`。其他端点或角色不支持时明确报错。
- 客户端能够读取并展示音频记录。TUI 队列恢复和重新提交保留附件引用；这次没有新增录音或播放器界面。
- [附件协议](../app-server-protocol/README.md#图片与音频附件)负责上传参数和结果；[附件服务](../attachments/README.md)负责媒体及引用校验；[附件存储](../attachment-store/README.md)负责文件和摘要校验。

## 实现差异与验证边界

- Codex Git discovery 为可选元数据查询共享并限制后台文件系统探测。Ash `open_repository` 是需要完整错误与取消结果的 Git 操作，并未实现同目录请求合并；两者不能仅因名字相似而互换。
- `path-uri`、`json-to-toml` 保留现有公开工具契约，当前没有为增加使用量而新增产品依赖。
- GUI 主题选择已迁入产品配置，`theme` 不再写入 Desktop 配置。符号链接和原子写的回归测试留在 `utils/path-utils`，不恢复已删除的主题配置模块。
- Windows 新增生命周期测试已加入所属包；在 macOS 上交叉编译不代表 Windows 运行验证。新系统 API 的实际 EOF、后代输入和终止行为仍需相应 Windows 主机执行。
- 独立工具库、生成类型或实时语音存在，均不能证明普通会话音频附件已经接通。音频链路的行为由上传到模型调用、文件重开、历史恢复及请求编码测试覆盖。

## 本轮验证

| 范围 | 结果 |
| --- | --- |
| 15 个后端及工具包 | 567 项测试通过，2 项按原配置忽略；主题合并后另跑主题及路径库，32 项通过 |
| 音频链路 | 上传 RPC、文件重开、历史恢复、模型编码及 TUI 音频场景通过 |
| 原有客户端行为 | 图片流程和附件上传 10 项、TUI 请求/队列/附件/回退 20 项通过 |
| Rust 构建 | 受影响包的正常构建及禁止编译警告检查通过；桌面程序构建、隔离工作区启动通过 |
| 平台条件 | Windows PTY/沙箱测试目标及警告检查、Linux PTY/路径测试目标交叉编译通过；未执行 Windows 运行测试 |
| 依赖和 Bazel | `just dependencies`、音频和缓存的 Bazel 测试通过 |
| 前端 | 生成协议、严格类型检查、音频历史 DOM 测试、Electron 构建通过 |
| Electron 与真实后端 | 隔离 Ash home 的窗口启动、后端数据库创建场景通过 |
| 浏览器及 Electron UI 冒烟 | Session Inspector 能打开和关闭；Escape 后焦点未回到按钮，场景仍失败。已补打开聊天栏的前置步骤，焦点实现未在本次修改 |

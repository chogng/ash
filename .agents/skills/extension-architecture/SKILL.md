---
name: extension-architecture
description: Design or review Ash core, Electron/Rust-V8 TS/JS extensions, and independent Rust capability extensions. Use for provider ownership, authentication, App/TUI reuse, runtime boundaries, or extracting optional backend capabilities. Not for ordinary extension usage or unrelated frontend changes.
---

# 扩展架构

权威边界与当前缺口见 [扩展架构与编辑器接入](../../../docs/editor-extensions.md#0-确定的产品方向)，目标命名、根目录 SDK 与来源边界见[共享接入与语言适配](../../../docs/editor-extensions.md#共享接入与语言适配的-crate-边界)，Plugin bundle 来源见 [Plugins](../../../docs/plugins.md)。先读受影响章节与当前代码，再决定 owner；目标设计不能当作已有运行能力。

## 决策边界

- 核心保留 Agent/Thread/Turn 权威状态、执行契约、最终权限裁决与通用存储、秘密、网络和进程机制。具体服务商认证、API 与可选产品工作流由扩展 Provider 拥有。
- 两类扩展与 Electron/Rust/V8 的目标分工见[运行时职责与兼容契约](../../../docs/editor-extensions.md#运行时职责与兼容契约)。兼容建设遵循公开契约，不按扩展增加特判；现有 Node 路径按迁移缺口记录。语言不决定业务归属，认证可以由任一种实现。
- App/TUI 按相同能力契约消费 Provider，各自拥有交互。App 预装登录扩展不让 TUI 默认加载；跨窗口存活、多客户端复用、IO 或 Rust 实现都不自动要求业务进入核心。
- App Server 拥有 typed dispatch、发现和授权路由，不链接每个 Provider 实现。核心不依赖具体扩展 crate；Rust 扩展使用版本化协议，不建立稳定进程内 Rust ABI。
- 各来源的包状态与租约保留唯一 owner，通过产品侧来源 adapter 接入；外部扩展运行体系不归 Plugin bundle 所有，具体命名与依赖方向遵循上述权威文档。安装不隐含执行授权。
- 文档与编辑器模型、dirty buffer、撤销及 UI 属于 TS 客户端；Rust Provider 只接收公开契约所需的快照/ID，不创建编辑器状态副本。

## 实施与审查

先识别真实消费者、必需机制与可选业务，明确核心、Provider、宿主和客户端各自拥有的状态。为 Provider 固定公开契约、版本/能力协商、注册冲突、结构化错误、事件、取消和资源释放。已有领域 service 继续隔离传输类型；生成 DTO 只留在 adapter。涉及 Renderer/Main 接入时再读 [app-server-api-integration](../app-server-api-integration/SKILL.md)。

业务状态只有一个有效 Provider owner。状态 scope 按 profile、Environment、workspace 或真实业务生命周期决定，交互请求另绑定发起客户端。核心存储拥有安全读写，registry 拥有注册，broker 拥有调用授权；它们不能复制会话和刷新任务。共享 Provider 的窗口关闭只清理该窗口调用，后台任务由声明的 scope owner 停止；停用/撤权取消旧实例所有任务，更新和恢复不重用旧身份或重放不确定写入。

Provider 注册绑定精确包、能力与 scope，重复实现按明确选择处理，不能靠启动顺序抢占。按能力请求激活；缺失、未授权或契约不兼容时返回不可用结果，基础核心继续运行，不偷偷启动旧内置实现。共享认证由 TS/JS 实现时，也需一个明确的共享实例与客户端交互路由；当前每窗口 Node Host 不证明 profile-scoped 认证已经实现。

两类扩展都不能取得产品内部 token、完整后端连接、通用 IPC 或核心最终授权。实际系统隔离由各自 launcher 实施，各宿主的直接 IO 权限与 broker 权限分开说明。纯 Web 需要授权后端才能运行产品 Rust/V8 宿主或 Rust 程序；已有可信 Worker 不证明生产第三方隔离。

拆出业务时保留消费者契约与错误语义，明确原有数据/凭据命名空间、迁移授权和唯一 owner 的切换点。全部消费者、注册、恢复读取和测试转移后，才移除原核心组合与打包依赖。`crates/ext/*` 的进程内 Agent 贡献不等于独立运行时。`ash-external-ext-sdk` 的公开注册、stdio、typed DataChannel 和 scoped Services 已被 GitHub 认证试点复用；后续能力沿此公开接口接入，不复制一套进程协议，也不机械迁移全部 crate。

## GitHub 认证例子

`github-authentication` 拥有 OAuth/设备码策略、issuer、scope、Enterprise 差异、令牌交换/刷新/撤销和会话有效性。核心拥有 Provider 注册、调用方账号/scope 授权与 SecretStore；App 拥有账号选择和浏览器交互。PR/Issue 业务由 GitHub API Provider 消费认证能力，本地 Git 不依赖 GitHub 登录。

可以复用 TS/JS Provider 经兼容层在选定宿主执行，也可以把现有 Rust 实现拆为独立 Provider 并用 TS 桥接编辑器 API。桥不保存第二份会话，同一 Provider 身份只允许一个有效实现。默认 Ash 契约对消费者使用不透明引用；认证 Provider 获准读取自身令牌。若实现 VS Code `AuthenticationSession.accessToken`，需对消费者明确授权，不能用引用冒充 token 兼容，也不能暴露产品内部凭据。

TUI 默认不加载 App 的 GitHub 登录；未来真实工具需要认证时启用同一能力并提供终端交互。不要把此规则扩大为 TUI 不需要模型认证或 Git 凭据。

现有 Rust 试点入口见 [`extensions/github-authentication`](../../../extensions/github-authentication/README.md)。Provider 通过公共 typed capability 注册，核心 Host 只授予其 SecretStore 命名空间和必要 HTTP 端点；App Server 保留消费者代理。共享实例由 `LocalProfileRuntime` 持有，不能按目录或窗口再创建；交互 ID 与完成结果另绑定发起方。核心不能重新导出 `GitHubOAuth` 或在生产依赖中链接该扩展实现。产品 launcher 与通用第三方安装／OS 沙箱能力分开判断。

复用 `ash-external-ext-sdk` 的 DataChannel、Client／Services 与现有 Host RPC，不为每个 Rust Provider 再造协议或启动器。交互请求的核心服务继承取消和 deadline，后台刷新由 profile 监管。登录路由须在驱动可能同步完成前注册，以目录 scope 与本地 ID 识别发起连接；断连仅取消它的在途交互，不能注销共享账号。

## 验证与交付

按改动范围运行现有检查。运行时变化需用契约测试及真实扩展包或 Rust 程序验证注册、调用、授权拒绝、取消、崩溃恢复和停用；共享能力检查 App/远程/TUI 的结果与错误一致。认证验证多窗口会话、登出/刷新竞态和资源释放；共享实例必须经产品的实际 profile／目录组合入口验证，手工给两个代理传入同一 Arc 的测试只覆盖代理行为。未启用 GitHub 的 TUI 检查没有 GitHub/Node 启动依赖。客户端 UI 按仓库规则用 Playwright 断言行为，截图不能代替会话与释放检查。

文档改动检查链接、锚点与格式；交付说明目标边界、实际完成的迁移、真实运行验证和剩余缺口。旧 SDK 示例或 schema 通过不能证明新的认证 Provider 可用。

# `ash-lsp-server-provider`

> 本 README 是语言服务器发现与 resolved definition 的 crate-level canonical contract。运行时
> lifecycle 见 [`ash-lsp-manager`](../lsp-manager/README.md)，协议 contract 见
> [`ash-lsp`](../lsp/README.md)，跨 crate 语义见 [`docs/lsp.md`](../../docs/lsp.md)。
> TUF catalog、package materialization 与安装状态见
> [`ash-core-plugins`](../core-plugins/README.md)。

`ash-lsp-server-provider` 拥有内置 server identity、用户启用意图、execution policy gate、
冻结候选的校验与 canonicalization，以及已验证 package 到 resolved definition 的 provider
绑定。`LanguageServerAcquisition` 根据可信内置扩展声明在实际需求时执行有界可用性探测，并通过 package-store 获取固定版本；它不拥有 Rust 专属策略、不读取 editor 文档、不执行 LSP，也不决定 directory capability。通用 resolver 与 installed provider 仍只生成 launch definition。

## 所有权与公共接口

| API / type                                                                  | 当前职责                                                                                                                                          | 明确不做                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `LspServerResolver`                                                         | 保存内置 server 与 preference，按 directory 生成一次冻结 resolution                                                                               | 持有 live client 或自动重启                      |
| `LanguageServerPreference` / `LanguageServerMode`                           | 表达 Disabled、Enabled 和 authoritative executable override                                                                                       | 用布尔值混合启用与发现语义                       |
| `LanguageServerExecutionPolicy`                                             | 接收产品宿主已经作出的 process allow/disallow 决策                                                                                                | 自行读取或持久化 directory capability            |
| `LanguageServerExecutableCandidates`                                        | 注入有优先级的冻结候选；`InstallContext` 是当前实现                                                                                               | 搜索时启动或 probe 进程                          |
| `LspServerResolution`                                                       | 同时返回 resolved definitions 与每个内置 server 的 availability                                                                                   | 表示 server 已经 initialize                      |
| `LanguageServerDefinition`                                                  | 冻结唯一 route、canonical executable command 和 initialize options                                                                                | 在 runtime 内重新查询 PATH                       |
| `LanguageServerProvider` / `LspServerProviders`                             | 把已验证、已安装的 server 包和运行时绑定为稳定 language route 与 definition                                                                       | 下载、验签、启动进程或监督重启                   |
| `ManagedNodeRuntime`                                                        | 冻结 canonical Node-compatible executable；Desktop 使用 Electron run-as-Node，其他 package 使用 standalone Node，并生成 clean-environment command | 回退 host `PATH` 或允许 language pack 携带 Node  |
| `NodePackageLanguageServerProvider` / `DirectPackageLanguageServerProvider` | 把 Manager-verified entrypoint 和 signed language route 绑定为 packaged provider                                                                  | 下载、安装、解析远端 catalog 或持有 live process |

resolver 保留 JSON/JSONC、Shell 和 TypeScript 的冻结 PATH 入口；Rust 路由只来自内置 Rust 扩展，核心已移除旧 Rust resolver 入口。CSS、YAML 等包统一使用通用 Node/direct provider。产品从
Config snapshot 映射持久化 preference；
Rust 扩展声明默认启用；其余 PATH built-in 未配置时使用 `Disabled`，需要显式选择 `Enabled` 才会生成 definition；
activation-backed provider 的用户安装确认已经构成启用意图，未配置时生成 packaged definition，显式
`Disabled` 才关闭。允许执行且冻结
PATH 中存在可执行文件时生成 definition；否则保持无 server。显式 override 是 authoritative，失效时不会回退 PATH。

## 执行路径、失败和扩展

```text
Product composition
├─ InstallContext::current → frozen host PATH
├─ directory process policy
└─ LspServerResolver::resolve
   ├─ Disabled / disallowed → status only
   ├─ explicit path → validate exactly that path
   └─ enabled → candidates in source order
      → canonicalize → regular file → executable permission
      → LanguageServerDefinition
      → ash-lsp-manager

verified Extensions package composition
├─ ExtensionPackageManager::local_capability_sources
├─ signed executable runtime + language route
├─ Desktop: ASH_ELECTRON_RUN_AS_NODE_PATH → exact Electron executable
├─ other packaged hosts: InstallContext::bundled_resource("node/bin/node[.exe]")
└─ NodePackageLanguageServerProvider / DirectPackageLanguageServerProvider
   ├─ packaged → selected runtime + package entrypoint + --stdio + clean environment
   │  └─ Electron source only: ELECTRON_RUN_AS_NODE=1
   └─ explicit override → authoritative host executable
      → LanguageServerDefinition
      → ash-lsp-manager
```

关键私有符号：

- `BuiltinServer` 绑定每个内置 identity、executable、language route 和启动参数；`resolve_builtin`
  统一执行 preference、policy 和 executable gate。
- `valid_executable` 是候选进入 resolved definition 前的唯一文件校验 gate。
- `has_executable_permission` 保持 Unix executable-bit 与其他平台文件语义分离。
- `canonical_regular_file` / `canonical_executable` 是 provider 输入进入 definition 前的
  canonical file gate；`ManagedNodeRuntime::command_for_script` 是 Node 启动环境的唯一 owner。
- packaged providers 的 `definition` 是 Manager-verified entrypoint/explicit override 分支的唯一绑定点；
  `LspServerProviders` 拒绝重复 identity，避免静默替换 route owner。

如果本 crate 开始持有 `LanguageServerClient`、child process、document revision 或 diagnostics，表示 runtime ownership
向 manager 漂移；如果 manager 开始读取 PATH、选择 executable 或解释用户 preference，表示
发现策略向 runtime 漂移。增加内置 server 时必须同时定义稳定 name、language IDs、启动参数、候选
来源和不可用状态测试，不能把任意 directory command 直接视为已验证 definition。

失败语义：静态 definition/name 无效会返回 `LspServerResolverError`；candidate 缺失、不是普通
文件、无法 canonicalize 或没有 Unix executable bit 都投影为 `ExecutableUnavailable`，不造成整个
产品启动失败。`ExecutionDisallowed` 在访问候选前返回。

## 测试与当前限制

```bash
just test ash-lsp-server-provider
just rust-warnings ash-lsp-server-provider
```

测试覆盖 JSON、Shell、JS/TS 的 built-in 的 Enabled PATH resolution/route/launch arguments、execution policy gate、
失效 explicit override 不回退，以及 Node package 的 standalone/Electron runtime command、clean
environment、host override 和 duplicate provider gate。

当前限制：

- ✅ 内置扩展声明的按需探测／获取、canonical executable 和 product-neutral availability；
- ✅ `ash-config` 持久化 mode/path、App Server typed mutation 与 Desktop 通用 server Settings 列表；
- ✅ JSON/JSONC、Shell server definitions 与持久化 mode/path 映射；
- ✅ 通用 `ash-core-plugins` 提供整包 digest 复核、immutable artifact、安装/update/uninstall 和 lease；
- ✅ verified Node/direct package provider、managed Node-compatible runtime 启动命令、App Server provider 组合点与 host override；
- ✅ Extensions Language target 的通用 TUF 下载/解压 adapter、Settings 安装 UI，以及从 verified
  Language/Executable capability 自动构建 `node`/`direct` provider collection；
- 尚未完成：组织策略或更细的 per-server executable grant。

## 内置扩展的服务器获取

`extensions/rust/package.json` 的版本化 `ashLanguageServers` 声明拥有 Rust 的服务器 ID、语言路由、探测参数、环境变量和六个平台的固定发布资产。它与语言和语法贡献一起经过现有不可变扩展目录装载；Rust 配置不编译进核心 crate。核心只接纳 BuiltIn 来源的获取声明，用户/市场包不能通过添加同名字段取得进程或网络授权。

语言列表无进程或网络副作用。打开匹配语言的文档、请求语义功能或显式启动服务器时，才执行通用 `LanguageServerAcquisition`；首次提交给 manager 的 definitions 只包含本次需求，后续需求保留已有路由及其运行、空闲或用户停止状态。自动目录诊断只使用 Ready 会话，不安装、启动或恢复服务器。旧 v1 声明中的 `workspaceFiles` 仍可读取和校验，但不影响激活或启动身份，当前内置声明已移除此字段。显式路径不可运行时报错，不回退；自动模式依次探测冻结 PATH，在工作区目录执行声明中的参数，保留工具链代理调用名。所有候选失败后，按扩展固定的 URL、大小和 SHA-256，通过 `ash-package-store` 安装。安装锁、原子选择、完整文件校验和运行期 lease 沿用包管理机制。

Extensions 的整包停用与 LSP 设置的 server Disabled 都阻止探测和下载；扩展移除或停用没有核心 Rust fallback。LSP manager 继续拥有协议和进程监管。已有系统服务器或已验证的托管缓存会直接复用；package-store 仅在缓存检查与跨进程锁之后确实发起 HTTP 获取时通知下载进度，等待锁、校验与复用缓存不会显示下载。Rust 工具链（cargo/rustc）由用户管理。此声明路径不建立另一套可执行扩展 RPC；需要任意运行逻辑的扩展继续使用已有 Host RPC/SDK。

通用显式服务器由 `resolve_executable` 复用 canonical executable 校验，并绑定配置中的语言映射。
`LanguageServerDefinition` 可携带标准化的启动参数、settings 和运行期资源 lease；配置覆盖保留
Node 脚本前缀、环境策略及 lease。包来源 adapter 在解析 definition 时取得精确 package lease，
provider 目录自身不持有活跃租约；manager 保留 definition 到进程监管结束。

## Provider 身份与失效

App Server 的 Extensions adapter 按 `LocalCapabilitySource` 缓存 provider，其比较包含精确 package
版本／digest、capability、入口、runtime 与语言路由。无关主题或 Skill 的变化复用同一个共享 provider；
停用、移除或损坏包会撤下缓存，重新启用创建新实例。同 ID 更新必须退休旧 source，不能按 ID 复用。
`same_provider` 比较这一精确共享身份及 activation 状态；`same_launch` 仅用于 manager 保留未改变的
启动契约，不能替代 source 撤权检查。

# `ash-install-context`

> 本 README 是 Ash 进程安装布局与随包资源位置的实现契约。Tool execution 与参数约束由
> [`ash-shell-command`](../shell-command/README.md) 维护；平台 sandbox 选择和 enforcement
> 由 [`docs/sandboxing.md`](../../docs/sandboxing.md) 维护。

`ash-install-context` 在进程启动边界捕获 current executable、package layout、
`ASH_RG_PATH`、`ASH_BWRAP_PATH` 与 host `PATH`，
并为消费方提供稳定、有序的资源候选。`SystemExecutables` 另负责系统安装目录内的可执行文件定位。
它不执行程序，不拥有 Workspace、Tool policy、
approval、sandbox capability probe、下载、更新或安装 mutation。

## 系统程序定位

- `SystemExecutables::current` 捕获系统与常规包管理器的安装目录；不使用 `PATH`、`PATHEXT` 或当前工作目录查找程序。
- `find` 只接受 `HostExecutableName`，返回规范化后的绝对路径；目录、越出安装根的链接与不可执行的 Unix 文件返回错误。
- `search_path` 生成后台自动操作使用的子进程 PATH。Windows 安装根来自启动环境中的 Program Files、LocalAppData/Programs 和 SystemRoot；这些安装根与其内容属于宿主的信任前提。
- `ash-git` 的系统入口使用此定位方式，查询还使用对应的子进程 PATH。用户指定的 Git 使用绝对路径入口，由调用方决定其可信来源。
- 随包资源名称通过 `path-utils::join_descendant` 检查词法范围；资源内容、符号链接和执行权限仍由消费方验证。

## 布局与优先级

当前识别的 package layout：

```text
<package>/
├── ash-package.json
├── bin/
│   └── ash
├── ash-path/
│   └── rg[.exe]
└── ash-resources/
    ├── bwrap              # Linux
    ├── node/bin/node[.exe] # packaged-node variant only
    ├── skills/            # built-in Agent Skills
    └── product-services/  # product Marketplace config + pinned public TUF root
```

只有 executable 位于 `bin/`，且 package root 同时存在普通文件 `ash-package.json`、
`ash-path/` 与 `ash-resources/` 时，才识别为 `InstallMethod::Package`；其他启动方式统一为
`Other`。metadata 的生成和 package 内容校验由
[`build/ash_rs`](../../build/ash_rs/README.md) 拥有，本 crate 只以其存在作为
layout marker，不解析或信任其中的字段。

`InstallContext::executable_candidates(ManagedExecutable::Ripgrep)` 返回互斥分支：

- 配置 `ASH_RG_PATH` 时只返回 authoritative `ExplicitOverride`；
- 否则返回 `SearchPaths`，顺序为 `<package>/ash-path/rg`、Ash executable 同目录的 legacy
  candidate、启动时 host `PATH` candidates。

类型不会在 override 分支暴露 fallback paths，因此 override 无效时消费方必须直接失败。普通候选
可以逐个验证；第一个有效 candidate 必须 canonicalize 并冻结后才能进入 Tool binding。

`ManagedExecutable::Bubblewrap` 使用相同的 mutually-exclusive contract：配置
`ASH_BWRAP_PATH` 时只返回 override；否则顺序为 package `ash-resources/bwrap`、启动时 host
`PATH` candidates。它不会采用 executable sibling legacy path。

MXC SDK 直接提供受限进程句柄，Ash 不再分发或发现 Windows command runner、配置服务或 Linux namespace helper。
Bubblewrap 候选交由适配器固定路径，再由 SDK 对同一路径验证和执行。

## 公共契约

| Symbol | 职责 | 不承担 |
| --- | --- | --- |
| `SystemExecutables` | 系统程序定位与受限子进程 PATH | 进程执行、用户工具配置或授权 |
| `InstallContext::current` | 捕获当前安装与环境 snapshot | 持续观察环境变化 |
| `PackageLayout` | 描述 metadata 与 package/bin/path/resources 路径 | 创建、解析或修改 package |
| `executable_candidates` | 生成有来源和优先级的候选 | executable 验证或 capability probe |
| `host_path_candidates` | 为 consumer-owned basename 查询冻结的 host PATH | 决定领域 identity、trust 或执行 |
| `bundled_resource` | 返回现有普通 resource file | digest 验证或 materialization |
| `bundled_resource_directory` | 返回现有 resource directory | tree validation、Skill discovery |

调用关系：

```text
host composition
└─ InstallContext::current
   ├─ executable_candidates(Ripgrep)
   │  └─ RipgrepExecutable validation + canonical identity freeze
   ├─ executable_candidates(Bubblewrap)
   │  └─ MxcSandbox Linux validation + capability probe + canonical identity freeze
   ├─ bundled_resource_directory("skills")
      └─ ash-skills controlled BuiltIn source validation
   ├─ Desktop host declaration or bundled_resource("node/bin/node[.exe]")
      └─ ash-lsp-server-provider::ManagedNodeRuntime validation and selection
   └─ bundled_resource("product-services/product-services.json")
      └─ ash-cli → LocalProductServicesConfig trust validation
```

如果该 crate 开始启动进程、解释 sandbox policy、下载资源或管理更新状态，说明 ownership 已经
漂移。具有平台生命周期的 helper 选择、复制和验证应留在对应 sandbox backend。

## 验证

```bash
just test ash-install-context
cargo clippy --manifest-path Cargo.toml \
  -p ash-install-context --all-targets --no-deps -- -D warnings
bazel test //ash-rs/install-context:install-context-unit-tests
```

## 共享进程路径

- 用户数据根由 [`ash-utils-home-dir`](../utils/home-dir/README.md) 统一解析；本 crate 只定位安装资源。
- `discovered_product_services_path` 解析 `ASH_PRODUCT_SERVICES_PATH` 或随包产品服务文件；内容验证由 App Server 负责。
- 控制程序与后台服务复用这些轻量路径契约，无需相互依赖实现。

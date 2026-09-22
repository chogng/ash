# `ash-extensions`

> 本 README 是静态扩展目录发现、不可变 package snapshot 与资源读取的实现权威文档。跨 App
> Server、Workbench 和 Editor 的用户语义、信任边界与长期演进由
> [`docs/editor-extensions.md`](../../docs/editor-extensions.md) 维护；内置 package set 的来源和分发
> 规则见 [`extensions/README.md`](../../extensions/README.md)。

`ash-extensions` 接收产品 host 选择的可信根以及 authority provider 选择的 exact immutable package
目录，把有效 package 冻结成 generation-bound 内存快照，并返回 manifest descriptor、诊断和有界
资源 bytes。它不拥有 JSON-RPC、connection resource、Workbench、TextMate、安装 authority 或扩展代码执行。

## 1. 边界与公共契约

| Symbol | 当前职责 | 不承担 |
| --- | --- | --- |
| `ExtensionRoot` / `ExtensionRootKind` | 表达 host 已选择的 built-in/user root | 从 Renderer 接收路径、directory capability |
| `DynamicExtensionSourceProvider` / `DynamicExtensionSourceSnapshot` | 按 authority generation 提供 exact immutable package 目录 | Marketplace/Plugin install、enable/grant、下载或签名验证 |
| `DynamicExtensionPackageSource::marketplace_with_manifest` | 为 product-independent portable family 提供 host-normalized 声明式 manifest，同时保留 exact package bytes/digest | 添加虚拟资源、绕过 package snapshot/path validation |
| `ExtensionCatalog::list` | cached query 或 refresh scan，并发布单调 generation | 解析 editor `contributes` |
| `ExtensionCatalogSnapshot` | 固定一代 descriptor、diagnostic 和完整 package identity | 保留历史 generation |
| `ExtensionDescriptor` | `publisher.name`、版本、manifest JSON/摘要和 package 摘要 | enablement、grant、signature |
| `ExtensionCatalog::open_resource` | 校验 generation、ID 和包内相对路径后读取当前 frozen bytes | 从 live filesystem 回退 |
| `ExtensionCatalogError` | generation conflict、缺失 ID/resource、非法路径、limit/IO failure | transport error code |

固定 precedence 为 built-in roots → dynamic authority-selected exact packages → user roots；每个阶段中
第一个有效 extension ID 获胜，后续重复项只产生 `DuplicateExtension` diagnostic。由此可变用户包不能
静默覆盖产品或已验证 dynamic 资源，Marketplace/Plugin 来源也不能覆盖产品内置资源。

## 2. 内部接口地图

| Private symbol | 精确职责 | 不能承担 | 修改时同步检查 |
| --- | --- | --- | --- |
| `scan_root` | 稳定排序 root 的 direct children 并应用 first-wins precedence | 递归 marketplace discovery | duplicate/root-order tests、系统文档 |
| `scan_dynamic_packages` | 稳定扫描 authority 给出的 exact package set | 读取 Marketplace registry、决定 enable/grant | generation/precedence tests、App Server provider tests |
| `discover_package` | 校验 package/manifest identity 并建立 frozen snapshot | 解释 `contributes` | manifest、digest、file-type/limit tests |
| `ExtensionPackageSnapshot::load` / `read_bounded_file` | 枚举 regular files、绑定 file identity、拒绝 link/special file、累计 limits 和 package digest | 暴露 canonical host path | symlink/hard-link/special/TOCTOU/digest tests |
| `CatalogBudget` | 约束跨 root 的候选数、frozen bytes、manifest response 与 diagnostics | 改变 root precedence | 边界值、截断标记和原子 claim tests |
| `validate_relative_path` | 校验 portable package-relative request path | canonicalize Workspace path | traversal/device/path-limit tests |
| `is_within` | 检查已解析路径 containment | 定义 extension precedence | platform containment tests |
| `mime_type` | 对少量静态资源后缀给出 transport hint | 内容嗅探或 Editor 解析 | resource tests |

真实调用路径为：

```text
ExtensionCatalog::list(Refresh)
  -> ExtensionCatalog::scan
  -> scan_root / scan_dynamic_packages
  -> discover_package
  -> frozen package files + ExtensionDescriptor
  -> ExtensionCatalogSnapshot(generation)

ExtensionCatalog::open_resource(generation, id, path)
  -> exact current-generation check
  -> validate_relative_path
  -> current frozen package snapshot lookup
  -> ExtensionResource { mime_type, bytes }
```

如果本 crate 开始解释 grammar/snippet/theme、启动进程、拥有安装状态，或在资源读取时重新打开 live
package path，说明 ownership 已经漂移。

## 3. 包、摘要与限制

每个可信根的直接子目录是一个 package，必须包含 UTF-8 JSON `package.json`。默认 manifest 的必填
身份字段为 `name`、`publisher` 和 `version`，canonical ID 为 `publisher.name`。受信任 dynamic provider
可以为 portable package family 提供 normalized declarative manifest；原始目录仍完整 snapshot/hash，
App Server 为 Marketplace language 包从已验证 package identity 补齐 name、publisher、version；语言资源清单无需重复这些字段。
normalized manifest 不能添加资源或改变 path containment。Descriptor 以 `manifest_sha256`
校验暴露给客户端的 canonical `manifest_json` bytes，同时用确定性 `package_sha256` 绑定 package 内
规范相对路径与全部原始 regular file bytes；digest 与 host absolute root 无关。

当前 ingestion limits：

| Limit | Value |
| --- | ---: |
| manifest bytes | 4 MiB |
| single regular file | 16 MiB |
| total package bytes | 64 MiB |
| regular files per package | 4,096 |
| total filesystem entries per package | 8,192 |
| resource request path | 1,024 bytes |
| package candidates per catalog | 4,096 |
| frozen regular-file bytes per catalog | 256 MiB |
| canonical manifest JSON per catalog response | 64 MiB |
| diagnostics per catalog | 4,096 |
| diagnostic text per catalog | 1 MiB |

Symlink、hard link、special file、越界路径、非法身份或超限 package 整体失败，不发布部分 package。
Catalog 达到总量上限后以 `ResourceTooLarge` diagnostic 跳过候选或停止继续枚举；diagnostic 自身达到
上限时保留一个截断标记。Crate 只校验 envelope 并返回完整 manifest JSON；语言、TextMate、snippet、
theme 和 debugger 字段由产品 host 解释。

## 4. Generation、失败与集成义务

首次 `Cached` query 在没有 snapshot 时执行扫描；已有 snapshot 且 dynamic authority generation 未变时
直接 clone 当前结果。dynamic generation 改变时，即使请求 `Cached` 也会重新扫描。每次
`Refresh` 都产生新的单调 generation，并原子替换当前 discovered map。资源读取必须携带当前
generation；旧代返回 `GenerationConflict`。Catalog 不保留多代 bytes，也不把旧 descriptor 隐式绑定
到新磁盘内容。

缺失可选 root 等价于空来源；存在但不可读的 root 产生 `SourceUnavailable`。单个无效 package 产生
结构化 diagnostic 并跳过，其他有效 package 仍可发布。资源 ID/path 不存在、路径非法、资源超限或
其他 IO failure 使用 typed `ExtensionCatalogError`；不会回退到工作区文件系统。

Host 必须：

- 只从 composition root 构造 `ExtensionRoot`，并保持 built-in-first precedence；
- dynamic provider 只发布上游 authority 已选择的 exact immutable package 目录与单调 generation；
- 把 snapshot generation 原样带到资源读取 API；
- 把资源 bytes 放入自己的 connection/lifetime boundary，不暴露 package root；
- 让产品领域解析 `contributes`，不能向本 crate 增加 editor-specific schema；
- generation conflict 后重新 list 并重新准备整批贡献，不能只重试同一路径。

## 5. 测试与修改影响

运行：

```text
cargo test --manifest-path Cargo.toml -p ash-extensions
cargo clippy --manifest-path Cargo.toml -p ash-extensions --all-targets --no-deps -- -D warnings
```

`catalog_tests.rs` 应覆盖 discovery、cached/refresh generation、built-in precedence、duplicate
diagnostic、package digest、完整 frozen-resource consistency、resource MIME、manifest/package/file
limits（包括 file/entry counts）、UTF-8、traversal、symlink/special file、缺失资源和
stale-generation rejection。修改 wire DTO
时还需运行 App Server protocol tests 和 Desktop unit tests；修改内置 package set 时还需运行 Python
及 Node packaging tests。

## 6. 当前限制与扩展点

Current：静态 root discovery、Marketplace/Plugin-authorized exact package projection、portable manifest
normalization seam、built-in → dynamic → user
precedence、不可变单代 snapshot、完整 package digest、typed diagnostic/error 与有代次约束的 bounded
resource read 已实现。当前不持久化 catalog，不保留旧 generation，也不自行提供远端 registry、下载、
enable/disable、signature/revocation、permission grant 或任意代码执行；这些 lifecycle decisions 由
provider 上游的 `ash-core-plugins` authority 完成。Executable Editor Extension 由独立的
[`ash-editor-extension-host`](../editor-extension-host/README.md) 监管；静态 catalog 不会隐式进入该
执行边界。

未来若 App 需要同一静态 package 语义，应直接依赖本 crate；这只是明确的 extension point，当前
仓库没有 App consumer。安装与信任控制面若需要演进，应与 Manager/legacy Plugin authority 明确对接，
不得把 mutable download 或 runtime process 塞入 `ExtensionCatalog`。

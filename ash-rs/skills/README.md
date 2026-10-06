# `ash-skills`

> 本 README 是 Skill S0 catalog、S1 exact activation 与 bounded package resource read 的当前实现契约。
> 跨 crate 的选择语义、context、Plugin/MCP 组合与后续阶段由
> [`docs/skills.md`](../../docs/skills.md) 维护。

`ash-skills` 验证 built-in/user/Directory/Plugin/Marketplace source root，流式读取并严格校验 Agent Skills
`SKILL.md` frontmatter，计算完整文件 SHA-256 digest，并发布 deterministic、immutable catalog
snapshot。显式选择后，`SkillCatalog::activate` 还会通过同一个受控 root 完整读取 exact
`SKILL.md`，重新绑定 file identity 与 digest，并返回 `ActivatedSkill`。`SkillCatalog::read_resource`
还可以在 pinned Skill digest 下读取任意有界 package-relative regular file。返回值保留原始
bytes，因此 reference、script、asset 共用一个定位与校验接口；本 crate 仍不执行命令、解释 MIME、
把二进制注入模型，也不拥有 config、watcher、App Server 或 Core
integration。共享 runtime、watcher、enablement overlay、activation contributor 与
model-safe-point reload 属于 [`ash-skills-extension`](../ext/skills/README.md)；App Server 只装配
扩展并投影协议 DTO。

Repository-owned built-in content 位于 [`assets/`](assets)，打包后位于
`ash-resources/skills/`。package host 通过
`InstallContext::bundled_resource_directory("skills")` 取得 candidate，再用
`SkillSourceRoot::built_in` 重新验证；打包 provenance 不替代本 crate 的内容校验。
当前正式内置内容只有 `skill-creator`；通用 code review/debugging 工作流没有因测试便利而成为
产品 built-in。

Catalog scanner 通过 [`ash-file-identity`](../file-identity/README.md) 从已打开文件句柄取得
稳定 identity 与 hard-link count。`scan_skill_file` 在读取前绑定句柄 identity，读取后重新打开
受控 path 并比较 identity；因此 Windows 不依赖不稳定的标准库 `MetadataExt` API，也不会为了
跨平台编译而跳过 hard-link 或换文件检测。symlink、root containment、大小限制和 diagnostic
语义仍由本 crate 拥有。

## 公共契约

| Symbol                                   | 当前职责                                                                                      | 不承担                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ash_protocol::SkillName`                | Agent Skills 的 lowercase ASCII、数字、单连字符、1–64 字符 identity                           | display alias、Unicode normalization           |
| `ash_protocol::{SkillSourceId, SkillId}` | 跨 config/catalog/App Server 的 source-qualified stable identity                              | raw host path、版本选择                        |
| `SkillSourceRoot`                        | host 注入并验证的 built-in/user/Directory collection 或 exact Plugin/Marketplace Skill handle | config resolution、安装、immutability          |
| `SkillCatalog::discover`                 | 对受控 roots 做首次 bounded metadata scan                                                     | arbitrary path search、recursive source search |
| `SkillCatalog::refresh`                  | 重扫并仅在 visible projection 改变时 bump generation                                          | filesystem watching、safe-point scheduling     |
| `SkillCatalogSnapshot::list/read`        | deterministic metadata-only read API                                                          | `SKILL.md` body/content API                    |
| `SkillCatalog::activate`                 | 解析 `SkillRef`、校验 pinned digest 并从受控 root 读取 exact body                             | enablement、compatibility、Turn 持久化         |
| `ActivatedSkill`                         | 将完整 body 与 `FrozenSkillActivation` provenance 绑定                                        | Core instruction precedence、工具授权          |
| `SkillResourcePath`                      | 校验 Skill package root 下非空、无 traversal 的相对路径                                       | absolute path、authority、执行权限             |
| `SkillResourceKind`                      | 按首层目录标识 instruction/reference/script/asset/agent metadata/other 用途                   | 改变 resolver、授予执行或发布权限              |
| `SkillCatalog::read_resource`            | 在 pinned Skill digest 下读取单个有界 regular file                                            | 递归展开、脚本执行、MIME 或外部 URL            |
| `SkillResource`                          | 返回 relative path、用途、内容摘要与原始 bytes                                                | 模型文本编码、host private root                |
| `SkillDiagnostic`                        | 隔离单 entry/source discovery failure                                                         | secret/body/private root 回传                  |

`SkillSourceRoot` 的 canonical host path 是 private implementation state，其 `Debug` 输出也会隐藏
路径。调用方必须从已解析的 config/内建 release authority 构造 handle，不能把客户端提交的 path
直接转成 source。

## 文件、限制与真实调用路径

```text
SkillCatalog::discover / refresh
  → catalog::scanner::scan_sources
    → scan_source                     # direct children、1024-entry cap
      → scan_skill                    # containment/type/link checks
        → scan_skill_file             # stream hash；只 capture bounded frontmatter
        → format::parse_frontmatter   # YAML shape + Agent Skills field validation
  → SkillCatalogSnapshot::new

SkillCatalog::activate
  → snapshot.read(exact SkillId)
  → resolve validated SkillSourceRoot
  → activation::load_exact_body
    → reject directory/manifest symlink、hard link、special/oversized file
    → compare opened file identity before/after read
    → compare complete SHA-256 with selected/catalog digest
  → ActivatedSkill { FrozenSkillActivation, body }

SkillCatalog::read_resource
  → snapshot.read(exact SkillId) + verify pinned SKILL.md digest
  → resolve validated SkillSourceRoot / Skill directory
  → reject traversal、symlink、hard link、special/oversized file
  → compare opened file identity before/after read
  → SkillResource { relative path, kind, content digest, bytes }
```

关键 limits：

| 项目                   |  当前值 |
| ---------------------- | ------: |
| source direct entries  |   1,024 |
| frontmatter            |  16 KiB |
| frontmatter lines      |     256 |
| one frontmatter line   |   2 KiB |
| complete `SKILL.md`    |   1 MiB |
| one package resource   | 256 KiB |
| resource relative path |   1 KiB |
| metadata entries       |      64 |

`scan_skill_file` 对完整 `SKILL.md` bytes 流式 SHA-256，但最多只保留 16 KiB frontmatter；
Markdown body 不进入 catalog entry、diagnostic 或 snapshot debug projection。只有
`SkillCatalog::activate` 会在请求时把不超过 1 MiB 的 exact body 返回给调用方。扫描和激活都在
读取前后检查
file identity、length、regular/single-link type；directory、manifest symlink 和 hard-linked
manifest 被拒绝。Resource reader 只在明确请求时读取一个 package-relative file，不递归展开
引用；读取 scripts 和 assets 也只返回 inert bytes，不会执行或产生副作用。

`format::validate_yaml_resource_shape` 在 `serde_yaml` 前限制 bytes/lines/line length/indent/flow
depth，并拒绝 YAML anchor、alias 与 tag control token。frontmatter 只接受规范字段，name 必须和
parent directory 一致；description、compatibility 和 metadata 另有 catalog memory bounds。
`allowed-tools` 只通过 `SkillMetadata::allowed_tools_hint` 暴露作者意图，绝不代表 approval。

## 失败、generation 与集成

一个坏 Skill 产生排序、去重后的 `SkillDiagnostic`，不会丢弃同 source 的有效 entry。source 在
handle 创建后消失会让下一次 refresh 发布 `SourceUnavailable` diagnostic。重复
`SkillSourceId` 是 host composition error，`SkillCatalog::discover` 返回 `DuplicateSource`。

entries 按 exact `SkillId` 排序，同名不同 source 同时保留。refresh 重新扫描事实；若 entries、
digest、compatibility、availability 与 diagnostics 完全不变，会复用同一个 `Arc` snapshot 和
generation。任何 consumer-visible 变化才发布下一 generation。

当前 `ash-skills-extension` 组合 built-in/user/active Directory 以及 Plugin/Marketplace 动态 roots、订阅 watcher，并叠加
per-Skill enablement；App Server 以 `skills/list`/`skills/changed` 投影其 snapshot。共享 identity
位于 `ash-protocol`，本 crate 只 re-export，不能重新定义一套。

本 crate 已有显式 exact activation 与 rooted package resource reader，但没有 automatic selector、
MIME/artifact adapter、script executor 或 safe-point scheduler。enablement/compatibility gate、显式选择汇合和 safe-point reload 由
`ash-skills-extension` 拥有；它通过通用 extension API 返回带 provenance 的 prompt fragment，
Core 不解释 catalog 或选择入口。后续能力应继续扩展该 runtime；如果
scanner 开始执行 script、预加载 optional resource、解释 Plugin grant，或 catalog 反向依赖
Core/App Server，表示 crate ownership 已经漂移。

## 验证

```bash
cargo test --manifest-path Cargo.toml -p ash-skills
cargo clippy --manifest-path Cargo.toml \
  -p ash-skills --all-targets --no-deps -- -D warnings
bazel test //ash-rs/skills:skills-unit-tests
```

tests 覆盖 identity/frontmatter contract、alias/depth/size bounds、metadata-only body exclusion、
source-qualified ordering/read、坏 entry 隔离、symlink/hardlink、digest refresh、no-op generation、
follow-latest freeze、pinned digest mismatch、resource kind/bytes/binary、资源路径
traversal/symlink/hard-link/size、文件替换 race 与 private root diagnostic boundary。

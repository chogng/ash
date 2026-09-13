# `ash-instructions`

> 本 README 拥有 Ash 原生 Instruction artifact 的当前实现契约。跨系统对象划分、`.ash`
> 命名空间与外部导入边界由
> [`docs/agent-customizations.md`](../../docs/agent-customizations.md) 维护。

`ash-instructions` 读取目录或选定 Ash home 下的 `AGENTS.md`、`ASH.md`，也对目录的
`.ash/instructions/*.md` 或用户 home 的 `instructions/*.md` 执行有界、非递归发现，校验
YAML frontmatter、三态加载策略和 UTF-8 Markdown 正文，并发布不可变 catalog snapshot。它不解析
Codex/Claude 格式，不组装模型请求，也不拥有 watcher、目录授权或 UI。

## 快速理解

| 文件状态 | 结果 |
| --- | --- |
| Instruction 目录不存在 | 空 catalog，无错误 |
| `AGENTS.md` / `ASH.md` | 作为纯 Markdown always-on 规则，按此顺序进入上下文 |
| 合法 `.md` | 进入确定性 catalog |
| 单文件格式错误 | 产生隔离 diagnostic，其他文件继续 |
| `load: global` | 注入后续模型调用 |
| `load: contextual` | 本 Turn 成功读取的目录内文件命中 `patterns` 时注入 |
| `load: on-demand` | 由 Agent definition 显式引用时加载 |

## 边界与公共契约

`InstructionCatalog::discover` 固定目录相对路径，`discover_user` 固定用户 home 相对路径；
`refresh` 只在 entries 或 diagnostics
变化时推进 generation。`InstructionCatalogSnapshot::automatic_content` 渲染 Global 与命中文件的
Contextual 条目；`global_content` 只渲染 Global。两者均带
artifact name 与相对路径 provenance。
同级正文按 `AGENTS.md`、`ASH.md`、细分文件顺序拼接；App Server 再区分用户级和授权工作区级。
工作区子目录的 `AGENTS.md` 与 `ASH.md` 只在本 Turn 成功读取其下文件后，按浅到深顺序加入；
用户 home 不做子目录继承。嵌套最多检查 64 个目录、每条路径最多 16 层。

frontmatter 必须显式声明：

```yaml
---
name: rust-style
load: contextual
patterns:
  - "**/*.rs"
---
```

`load` 只接受 `global`、`contextual`、`on-demand`。只有 contextual 可以且必须声明非空
`patterns`，每项须为有效的相对 glob。它对应 VS Code 的 `applyTo` 概念，但 Ash 的原生字段仍叫
`patterns`，不扫描 VS Code 的目录。每文件最多 32 条 pattern、每条最多 256 字节。文件名使用小写字母、数字和连字符；可选 `name` 存在时必须与文件名一致。

实现限制为 128 个直接条目、每个文件 32 KiB。source/entry symlink、目录、非 Markdown、非法
UTF-8、空正文和未知 frontmatter 字段均不会进入 catalog。

## 内部所有权与调用路径

| 文件 / symbol | 职责 |
| --- | --- |
| `catalog.rs::scan` | 固定路径、entry limit、排序与隔离诊断 |
| `catalog.rs::load_entry` | metadata、类型、大小、UTF-8、frontmatter 和正文校验 |
| `catalog.rs::load_policy` | 三态加载策略的不变量 |
| `model.rs::InstructionCatalogSnapshot` | immutable entries/diagnostics 与自动匹配渲染 |

```text
InstructionCatalog::discover / refresh
  → scan
  → load_entry
  → load_policy
  → InstructionCatalogSnapshot
```

若本 crate 开始扫描 `.codex`、`.claude` 或其他专有格式，自行取得当前 editor 状态，
或直接修改 `ModelRequest`，表示原生 authority 与 compatibility/runtime 边界已经漂移。

## 验证与当前限制

```bash
just test ash-instructions
just check ash-instructions
just rust-warnings ash-instructions
```

当前已实现目录和用户 home 的共享 `AGENTS.md`、Ash 专属 `ASH.md` 与多文件 Instruction 发现、格式校验、不可变 snapshot 与 Global 内容渲染；App Server 的
`DirContributions` 在目录加入 Env 时发现 catalog，由 filesystem invalidation refresh，并在
下一次 model invocation 通过 `HarnessContextProvider` 提供 Global 与匹配的 Contextual 内容。Core
仅从本 Turn 成功的 `read_file` 调用提取路径；App Server 校验路径仍落在对应目录内，再交给 catalog
匹配。`ash-home` 在每次模型调用前刷新用户 home catalog，并把其内容放在目录级内容之前。
Agent definition 可按名称显式引用 OnDemand 条目。按当前用户消息或编辑器活动文件自动匹配、用户
手动附加 OnDemand、Plugin source composition 及 catalog/diagnostic list API 尚未实现。

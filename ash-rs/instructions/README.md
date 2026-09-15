# `ash-instructions`

> 本 README 拥有 Ash 原生 Instruction artifact 的当前实现契约。跨系统对象划分、`.ash`
> 命名空间与外部导入边界由
> [`docs/agent-customizations.md`](../../docs/agent-customizations.md) 维护。

`ash-instructions` 读取目录或选定 Ash home 下的 `AGENTS.md`、`ASH.md`，也对目录的
`.ash/instructions/*.md` 或用户 home 的 `instructions/*.md` 执行有界、非递归发现，校验
YAML frontmatter、三态加载策略和 UTF-8 Markdown 正文，并发布不可变 catalog snapshot。

- 隔离指令发现、格式校验、匹配和读取前置条件。
- 提供逐文件选择结果、按需正文、未加载规则的 metadata 与解析诊断。
- 不拥有模型请求、目录授权、工具执行或界面。

它不解析
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
| `load: on-demand` | Agent 读取准确文件、用户显式附加，或 Agent definition 引用时加载 |

## 边界与公共契约

`InstructionCatalog::discover` 固定目录相对路径，`discover_user` 固定用户 home 相对路径；
`refresh` 只在 entries 或 diagnostics
变化时推进 generation。`InstructionCatalogSnapshot::automatic_content` 渲染 Global 与命中文件的
Contextual 条目；`global_content` 只渲染 Global。两者均带
artifact name 与相对路径 provenance。
同级规则按 `AGENTS.md`、`ASH.md`、细分文件顺序展示；此顺序不是冲突覆盖规则。
`selected_files` 返回逐文件正文与选择原因，`reference_content` 只返回未加载规则索引和诊断。
App Server 将用户级、授权工作区级及嵌套规则作为独立贡献交给 Core，不提前合并成 scope 级正文。
工作区子目录的 `AGENTS.md` 与 `ASH.md` 只在本 Turn 成功读取其下文件后，按浅到深顺序加入；
用户 home 不做子目录继承。嵌套最多检查 64 个目录、每条路径最多 16 层。

frontmatter 必须显式声明：

```yaml
---
name: rust-style
description: Rust coding conventions.
load: contextual
patterns:
  - "**/*.rs"
---
```

`load` 只接受 `global`、`contextual`、`on-demand`。只有 contextual 可以且必须声明非空
`patterns`，每项须为有效的相对 glob。它对应 VS Code 的 `applyTo` 概念，但 Ash 的原生字段仍叫
`patterns`，不扫描 VS Code 的目录。每文件最多 32 条 pattern、每条最多 256 字节。可选 `description` 为 1–1024 字节的非空描述，用于 Agent 判断任务相关性，不自动注入正文。
文件名使用小写字母、数字和连字符；可选 `name` 存在时必须与文件名一致。

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

- 每次模型调用重新取得授权目录与用户目录的规则；修改和删除在下一次调用生效。
- `context_content` 同时提供适用正文、未加载规则的描述和准确路径、解析诊断；没有把未选择正文全部加入模型请求。
- Agent 通过 `read_instruction` 成功读取某条指令后，该规则进入本 Turn 后续调用；下一 Turn 不继承自动选择状态。历史消息中的旧文本仍属于对话历史。
- `write_file`、`edit`、`apply_patch` 在执行前检查目标文件的 contextual 与子目录规则，包括尚不存在的文件。缺少规则时返回待读路径，不写入、不请求额外权限；模型通过 `read_instruction` 读取并重新提交后继续。该工具只读取当前授权 catalog 中的规则正文，不开放用户 home 的其他文件，也不满足修改源文件前的完整读取要求。
- 同一批工具调用或同一个 Code Mode cell 中临时读到的规则，不能直接满足本批写入前置条件；必须先返回模型。Shell 等任意程序的写入目标不在这项检查的覆盖范围内。
- 用户可通过 `instructions/list` 获取当前会话授权范围内的 metadata 与 diagnostics，并在 Turn input 使用 `{ "type": "instruction", "path": "列表返回的绝对路径" }` 显式附加。服务器重新匹配当前 catalog，拒绝已删除、格式错误或范围外的文件；正文作为本轮上下文附件保存。
- 列表响应不包含正文，也不等同于“本轮已使用”。当前没有独立的 Desktop/TUI 指令管理面板、逐轮使用记录、启停配置或 Plugin 指令来源。

指令权威、请求位置与预算保留的独立契约见 [指令优先级](../../docs/core-context.md#62-指令优先级)。
目录匹配及来源测试不等同于真实模型遵守率评测。

## 创建入口

`$create-instructions` 是内置 Skill，复用通用技能选择和文件工具。`/init` 仍负责初始化 `ASH.md`。
创建 Skill 不负责指令匹配、授权或执行检查。

## 外部指令发布

`validate_instruction` 用 catalog 相同的正文、frontmatter、命名、大小和模式校验规则检查待发布内容。
只接受项目 `ASH.md` 或直接 `.ash/instructions/*.md` 目标，不允许导入流程改写共享 `AGENTS.md`。
外部格式解析属于 `external-agent-migration`；App Server 转换选中片段，并通过有授权的文件服务发布。
发布后的文件进入现有 catalog refresh，主 Agent 与子 Agent 使用同一加载路径。

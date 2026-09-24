# ash-slash-commands

> 本文拥有无渲染 Slash Commands 核心的实现契约。跨客户端产品语义见
> [`docs/slash-commands.md`](../../docs/slash-commands.md)；wire snapshot 见
> [`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。TUI、native 与 Desktop
> 分别拥有自己的渲染适配器。通用斜杠启动面板的多列表组合由
> [`ash-slash-launcher`](../slash-launcher/README.md) 拥有。

`ash-slash-commands` 为 App Server、TUI 和 ash-ui/native 提供同一套 catalog 校验、输入语法、
匹配、选择、补全与提交解析。它不渲染 UI、不执行命令，也不拥有 App Server composition。
这里的选择状态只针对真实 Slash Command catalog；它不负责把 Skills、命令和其他产品列表组合成
通用斜杠面板。

## 1. 边界与依赖

| 拥有 | 不拥有 |
| --- | --- |
| canonical `SlashCommandDefinition` 的名称、描述、冲突校验与稳定顺序 | 命令实际执行与授权 |
| `SlashCommandInput` 的 `/` 查询、补全范围和参数解析 | composer 文本存储、键盘或鼠标事件 |
| `SlashCommandsState` 的匹配、选择与 dismiss 状态 | Ratatui、WGPU、DOM 或各宿主 renderer 的绘制与滚动几何 |
| 与 model 分离的 server/local contribution kind | Skill selector、App Server 初始化、IPC 或 Renderer lifecycle |

本 crate 依赖 `ash-app-server-protocol` 以直接复用 canonical wire definition。App Server、TUI 和
native 可以依赖本 crate；本 crate 禁止反向依赖这些消费者。

## 2. 公共契约

- `SlashCommandCatalog::new` 构造 server-only snapshot；
- `SlashCommandCatalog::default` 构造包含 `/advisor`、`/compact`、`/init`、`/team` 与 `/develop` 的服务端快照；`/advisor` 无参数打开配置，`/advisor <provider/model|off|clear>` 调整配置，其他参数作为直接咨询的问题；
  前者由产品 adapter 绑定到 typed context-compaction request，后两者分别冻结细分 Instruction 与 `ASH.md` 的创建提示；
- `SlashCommandCatalog::with_local_and_server` 按 local、server 顺序合并并拒绝任何重名；
- `SlashCommandInput` 对同一 catalog 提供 query、completion、invocation、argument hint 与 command element range；
  - `argument_hint(self)`：当输入命令有效、紧随空格、参数文本为空且光标停留在空格末尾时返回 `Some(&'c str)`；开始输入参数或光标离开末尾时返回 `None`；
- `SlashCommandsState` 保存当前输入对应的匹配、选择与 dismiss 状态；暴露 `argument_hint(&self)` 供输入组件呈现行内提示；viewport、可见范围与滚动由各 renderer 保存；
- `SlashCommandsView` 是 renderer 只读 projection，不允许渲染过程改变状态。

输入校验按 Rust UTF-8 byte range 工作。名称只允许 lowercase ASCII letters、digits 与 interior
hyphen；空描述、非法名称和跨来源冲突都使整份 catalog 构造失败。

## 3. 内部接口地图

| Symbol | 可见性 | 职责 | 漂移信号 |
| --- | --- | --- | --- |
| `catalog::append_commands` | private | 校验并按 origin 追加完整 snapshot | caller 绕过它直接修改 command vector |
| `catalog::validate_command` | private | 固定 canonical name 与 description 规则 | 客户端重新实现另一套校验 |
| `input::command_name_range` | private | 找出首个 `/name` token 的 byte range | popup 和 submission 使用不同 grammar |
| `input::trimmed_range` | private | 保留参数在原输入中的 exact range | adapter 自行切割参数文本 |
| `SlashCommandsState::refresh` | private | 从 input、cursor 与 catalog 原子重建 view | renderer 保存第二份匹配或 query authority |

调用关系：

```text
SlashCommandCatalog::{new,with_local_and_server}
  → append_commands → validate_command

SlashCommandsState::sync_input
  → refresh → SlashCommandInput::{query,matching_commands}
  → SlashCommandsView

renderer action
  → SlashCommandsState::{select_next,select_previous,select,dismiss}
  → selected_completion / invocation
```

## 4. 失败语义与接入义务

Catalog validation 是全有或全无；失败时不发布部分 snapshot。`SlashCommandInput` 对不完整、未知、
越界 cursor 或不允许参数的输入返回 `None`，不猜测命令。dismiss 绑定 exact input；文本变化后匹配
可以重新显示。

Adapter 必须把完整 catalog 一次性交给 `set_catalog`，不能逐项修改内部列表；提交时必须使用同一
state/catalog 解析，避免展示了一个命令却由另一套 parser 拒绝。
Server origin 只表示命令由 server 声明，不决定统一的提交方式；adapter 必须按 command name 的
产品契约执行。内置 `/compact` 必须调用 `CompactContext`，不得进入普通 `StartTurn`；其他 server
prompt command 可以继续提交 unchanged invocation text。

输入组件呈现行内虚提示时，必须以弱化样式（如置灰）将 `argument_hint` 绘制在物理光标后方，
不得改变输入文本真实存储内容，也不得推移光标在草稿中的字符下标。

## 5. 测试与修改影响

运行：

```bash
cargo test -p ash-slash-commands
cargo clippy -p ash-slash-commands --all-targets -- -D warnings
```

修改名称语法、匹配顺序、completion range、selection 或 dismiss 规则时，必须同步更新本 crate tests、
App Server initialization tests、TUI/native adapter tests 和 Desktop 的跨语言 fixture tests。

## 6. 当前限制与扩展点

- **Current**：Rust App Server、TUI 与 native 可直接复用同一实现。
- **Current**：Desktop 直接消费 protocol-generated `SlashCommandDefinition`；它与 Rust surfaces
  使用同一个 model，TypeScript adapter 只绑定 Workbench action 和 Stanza renderer。
- **Conformance**：Rust core 与 Desktop adapter 共同执行同一 fixtures，保证不同语言宿主不会改变
  model validation、matching 或 input semantics。

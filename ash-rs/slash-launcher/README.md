# ash-slash-launcher

> 本文拥有通用斜杠启动面板核心的实现契约。Slash Launcher 与真正 Slash Command 的跨产品边界见
> [`docs/slash-commands.md`](../../docs/slash-commands.md)。命令 catalog、补全和提交解析继续由
> [`ash-slash-commands`](../slash-commands/README.md) 拥有。

`ash-slash-launcher` 把产品选择的若干列表组合成一个可搜索、可选择的无渲染快照。它不认识
Slash Command、Skill 或产品动作，也不决定选择后的执行行为。

## 1. 边界与依赖

| 拥有                                     | 不拥有                                        |
| ---------------------------------------- | --------------------------------------------- |
| 多列表的稳定顺序、ID 校验与全量快照      | Slash Command 定义、参数语法或执行            |
| 首个 `/query` token 的识别与替换范围     | Skill 发现、启用状态、正文或激活              |
| 跨列表前缀匹配、选择、循环移动与 dismiss | TUI、WGPU、DOM、键鼠事件或 popup 几何         |
| 选中项的 `list_id + item_id` 和展示快照  | target registry、handler、IPC、异步刷新或授权 |

本 crate 没有运行时依赖。产品宿主和领域 adapter 可以依赖它；它不得反向依赖
`ash-slash-commands`、`ash-skills`、App Server protocol 或 renderer。

## 2. 公共契约

- `SlashLauncherItem` 保存来源内稳定 ID、展示字段和可选搜索别名。`item_id` 必须能让产品解析到
  同一份不可变业务绑定，不能只是会被刷新后重用的临时序号。
- `SlashLauncherList` 是一个产品选择的列表。列表可以来自命令、Skills 或其他领域；同一列表内
  item ID 必须唯一，展示名称允许重复。
- `SlashLauncherSnapshot::compose` 按调用方顺序组合列表并拒绝重复 list ID。不同列表可以包含同名
  项，因为选中键由 `(list_id, item_id)` 唯一确定。
- `SlashLauncherInput` 只把输入开头、光标所在的首个 `/query` token 解释为启动面板查询；它不解析
  Slash Command 参数。`SlashLauncherQuery::range` 覆盖完整首 token，便于产品替换已输入内容。
- `SlashLauncherState` 原子地从快照、输入和光标生成 `SlashLauncherView`，并拥有选择与 dismiss。
  `SlashLauncherSelection` 是 owned value，列表刷新后已取得的选择不会改变。

本 crate 有意不提供 provider trait。发现、异步刷新、缓存和生命周期由产品决定；调用方在准备好
完整列表后一次性构造新快照并调用 `set_snapshot`。

## 3. 内部接口地图

| Symbol                        | 可见性        | 职责                                           | 漂移信号                                     |
| ----------------------------- | ------------- | ---------------------------------------------- | -------------------------------------------- |
| `model::validate_id`          | private       | 固定 list/item dispatch key 的最小稳定性规则   | 领域名称语法或业务授权进入通用校验           |
| `SlashLauncherItem::matches`  | crate-private | 对 label 和 keywords 做大小写无关前缀匹配      | renderer 建立第二套匹配 authority            |
| `input::launcher_token_range` | private       | 定位输入开头的完整斜杠 token                   | 把命令参数 grammar 搬入 Launcher             |
| `SlashLauncherState::refresh` | private       | 从输入与快照一次重建 query、items 和 selection | adapter 逐项修改内部结果或保存另一份选择状态 |

调用关系：

```text
product adapters
  → SlashLauncherItem → SlashLauncherList
  → SlashLauncherSnapshot::compose
  → SlashLauncherState::{new,set_snapshot,sync_input}
      → SlashLauncherInput::query
      → SlashLauncherSnapshot::matching
      → SlashLauncherView

renderer activation
  → SlashLauncherSelection::{list_id,item_id}
  → product-owned typed binding and handler
```

## 4. 失败语义与接入义务

构造失败是全有或全无：空白 label/title、不稳定 ID、重复 list ID 或同一列表内重复 item ID 都不会
产生部分快照；description 允许为空。跨列表同名不报错，由 renderer 用列表标题说明来源。无前导
`/`、光标越界、光标不在首 token 或 UTF-8 byte 边界非法时，`SlashLauncherInput::query` 返回
`None` 并关闭 view。

产品 adapter 必须拥有 `item_id` 到 typed target 的绑定，并保证选中后按同一不可变身份解析。Launcher
不会调用 handler，也不会在刷新后按 label 猜测 target。

## 5. 测试与修改影响

```bash
cargo test -p ash-slash-launcher
cargo clippy -p ash-slash-launcher --all-targets -- -D warnings
```

修改 ID、匹配、token range、顺序、选择或 dismiss 规则时，必须同步更新本 crate 的 sibling tests。
接入具体产品后，还要更新该产品的列表 adapter、无窗口交互测试和 target binding 测试。

## 6. 当前状态与扩展点

- **Current**：通用数据模型、列表组合、输入查询和交互状态已实现并由 crate 单测覆盖。
- **Current limitation**：TUI、Desktop 和 app 尚未切换到本 crate；现有交互继续按各产品当前路径
  工作。
- **Current limitation**：当前匹配是稳定的大小写无关前缀匹配，没有 fuzzy ranking、分页或协议模型。
- **Extension point**：出现真实跨语言消费者后，再为同一 value contract 增加 protocol/TypeScript
  投影；不要提前把产品 handler 或领域 target 下沉到本 crate。

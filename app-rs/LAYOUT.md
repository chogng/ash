# `app` 布局

> 状态：Workbench 层级和生命周期边界已实现；内容挂载仍按“当前差距”继续收口。本文是 `app` 窗口结构、Sidebar/Pane 层级和响应式布局的唯一说明。Workbench 状态、布局、外壳 UI 和生命周期边界见 [`ash-workbench`](workbench/README.md)，Ash Agent 行为见 [`Agent 工作区`](docs/native-agent-console.md)，外部 AI CLI 与终端边界见 [`TERMINAL.md`](TERMINAL.md)。

## 快速理解

用户在 Sidebar 的 Sessions 页面选择一个 Session 或 Settings 后，窗口显示该项拥有的 `PaneContainer`；容器中的 `PanePart` 管理所有可见 PaneGroup，具体内容全部由 `PaneInput` 表达。Sidebar header 的 Cowork / Code 只切换产品模式，Session 分组根负责展开或收起子项。

| 用户操作 | 布局行为 | 作用范围 |
| --- | --- | --- |
| 切换 Cowork / Code | 更新 Sidebar mode switch 的选中模式 | Sidebar header |
| 切换 Session 或 Settings | 整体切换对应的 `PaneContainer` | Sidebar content |
| 点击 Session 分组根 | 展开或收起该组子项，不改变活动内容 | Session 分组 |
| 打开 Files、Changes 或外部 AI CLI | 在当前 PaneGroup 打开对应视图，或拆出新的 PaneGroup | 当前 `PanePart` |
| 在 Pane 内切换内容 | 改变该 PaneGroup 的活动 `PaneInput` | 当前 PaneGroup |
| 窄窗口打开另一个 Pane | 活动 PaneGroup 接管可用区域，并保留返回关系 | 当前 `PanePart` 的可见几何 |

## 布局模型

```text
Window
├─ Titlebar
├─ SidebarPart
│  ├─ Header → Cowork / Code
│  └─ Content → Sessions → group root → Session list items
└─ active Sidebar item → PaneContainer
   └─ PanePart
      └─ split tree
         ├─ PaneGroup → PaneInput tabs → active PaneInput
         └─ Split(direction, ratio)
            ├─ PaneGroup → active PaneInput
            └─ PaneGroup → active PaneInput
```

| 层 | 数量关系 | 职责 |
| --- | --- | --- |
| `SidebarPart` | 一个 Workbench 一个 | 保存 Cowork / Code 模式、Session 分组/展开状态、顺序和全局活动项 |
| `TabInput` | 一个 Sidebar 项一个 | 表示 Session 或 Settings，并一对一拥有 `PaneContainer`；它是内容挂载身份，不是列表行组件 |
| `PaneContainer` | 一个 `TabInput` 一个 | 保存该 Sidebar 项的完整 Pane 布局和恢复边界 |
| `PanePart` | 一个 `PaneContainer` 一个 | 保存拆分树、比例和活动 PaneGroup |
| `PaneGroup` | 一个拆分叶子一个 | 对应一个可见矩形区域，保存多个 `PaneInput` 和其中一个活动输入 |
| `PaneInput` | 一个 PaneGroup 零到多个 | 描述挂载到 Pane 的视图，不保存几何、绘制节点或功能运行状态 |
| `Pane` | 按需产生 | 组合 PaneGroup、活动输入身份和 `PaneInput`，不是新的容器层 |

## Sidebar 内容项

Sidebar 内容项当前只有两种。增加 Pane 内容类型不增加 Sidebar 项类型。

| `TabInput` | 身份 | 默认内容 |
| --- | --- | --- |
| Session | `SessionId` | 该 Session 的 Ash Agent、Terminal、Files 或 Changes Pane |
| Settings | 全局单例 | Settings Pane |

切换 Sidebar 内容项必须整体保存和恢复 PanePart 拆分、活动 PaneGroup、各组活动输入和可丢弃的视图状态。Settings 不创建 Session、Thread 或 Terminal。

## PaneInput

目标模型使用以下五种视图输入：

| `PaneInput` | 视图身份 | 负责 |
| --- | --- | --- |
| `Agent` | Session + Thread | 只表示 Ash Agent 的对话、时间线和 Composer |
| `Terminal` | Terminal session | 外部 AI CLI、shell 或其他交互式进程 |
| `Files` | 工作区根目录 | 文件浏览、搜索、选择和文件内容 |
| `Changes` | 工作区根目录 | 变更集合、状态、选择和 Diff 内容 |
| `Settings` | 全局单例 | 设置页面和当前分区 |

`PaneInput` 的边界止于完整视图。`Files` 拥有文件身份、编辑器和文件内容的组合；`Changes` 拥有变更身份、单文件 Diff 和多文件 Diff 的组合。

Codex、Claude Code、Gemini CLI 等外部 AI 不增加新的 Agent 类型，也不进入 Ash Thread。它们由独立 CLI adapter 启动，并统一通过 `Terminal` Pane 显示；Terminal 不解析屏幕文字来推断外部 AI 的结构化状态。

## 布局规则

- Sidebar mode switch 和 Sessions 列表位于 PanePart 外，不作为 PaneInput。
- `Agent`、`Terminal`、`Files`、`Changes` 和 `Settings` 视图都进入 PaneGroup。
- 同一 PanePart 可以同时显示多个 PaneGroup；每个 PaneGroup 同时只显示一个活动 PaneInput。
- 在同一 PaneGroup 打开多个输入时使用组内 Tab；需要同时查看时拆分 PaneGroup。
- `Files` 和 `Changes` 各自组合内部导航、选择和内容。
- 浮层、菜单、补全、上下文视图和临时选择器不是 PaneInput，也不进入拆分树。

## 响应式行为

| 可用空间 | 行为 |
| --- | --- |
| 可以同时保证两个 Pane 可用 | 按 PanePart 拆分树显示多个 PaneGroup |
| 无法保证所有 Pane 可用 | 只显示活动 PaneGroup，其他 PaneGroup 保留在原 PanePart 中 |
| 活动内容需要完整终端协议或专注编辑 | 活动 PaneGroup 接管内容区域，Sidebar 保留活动项身份和返回入口 |

响应式变化只能改变几何和可见 PaneGroup，不能更换 `PaneInput` 身份、停止 Terminal、丢弃编辑草稿、释放未保存文件或重建 PaneContainer。

## 当前差距

完成布局模型需要满足：

1. 让 `Changes` 视图完整拥有变更导航、选择和 Diff 内容。
2. 让所有内容通过当前 PanePart 的 PaneGroup 和活动 PaneInput 挂载、绘制和路由输入。
3. 由同一 PanePart 拆分树负责宽屏多 Pane 和窄屏活动 Pane 接管，并保存返回关系。
4. 让 Terminal session identity 脱离 App Server `SessionId`，通过独立 adapter 启动外部 AI CLI。

## 长期边界

- PanePart 只拥有布局拓扑和选择，不拥有文件、Git、Thread、Terminal 或 Settings 的权威状态。
- 功能 crate 拥有视图内部内容、状态和行为；产品宿主只把 `PaneInput` 连接到对应视图。
- 布局状态可以丢弃和重建，Session、文件修改、Diff、Terminal 生命周期和执行结果不能由布局拥有。
- Ash Agent 与外部 AI CLI 不共享 Thread、Tool、Approval 或持久状态；Terminal 只承载外部进程。

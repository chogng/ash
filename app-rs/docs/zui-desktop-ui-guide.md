# 使用 ZUI 构建桌面界面

> 状态：Proposed（ZUI 公共开发规范）
>
> 读者：使用 Rust 和 ZUI 构建多窗口、多区域桌面应用的开发者。
>
> 边界：本文规定应用开发者面对的 ZUI 写法。样式角色、字段、解析和错误语义见 [ZUI 样式系统设计](zui-ui-system-design.md)。

本文不描述任何产品仓库，也不围绕某套已有接口组织内容。文中的 `Application`、`Component`、`View`、`styles!`、`ui!` 和测试接口共同构成 ZUI 最终公共模型；ZUI 的实现应向这个模型靠拢。

类 VS Code 工作台只是贯穿示例。换成设计工具、数据库客户端、邮件应用或媒体编辑器时，应用仍使用相同的窗口、组件、状态、布局、样式和交互模型。

## 快速理解

ZUI 应用只有一条主要数据路径：

```text
系统事件
  ↓
类型化 Message
  ↓
Component::update
  ↓
组件状态
  ↓
Component::view
  ↓
类型化 View 树
  ↓
测量 → 布局 → 裁剪 → 命中 → 绘制 → 语义输出
```

开发者主要编写八种东西：

| 内容 | 作用 |
| --- | --- |
| `Component` | 拥有一块界面的状态、消息和视图 |
| `Message` | 描述用户操作或异步结果，不直接修改界面 |
| `Output` | 只把父组件需要知道的结果送出组件边界 |
| `View` | 用 Rust 控制流声明这一帧的组件和节点树 |
| `styles!` | 声明组件内部的命名角色和类型化属性 |
| 领域状态 | 文件、文档、会话等产品事实 |
| 服务接口 | 文件系统、网络、进程等副作用边界 |
| 测试 | 从组件输入验证视图、交互、语义和绘制结果 |

ZUI 负责窗口循环、组件身份、消息投递、焦点、输入法、文本测量、布局、滚动、命中、绘制、语义树和确定性测试运行时。

## 1. 公共编程模型

### 1.1 组件

每个有独立状态、交互、生命周期或重复身份的界面单元实现 `Component`：

```rust
pub trait Component: 'static {
    type Message: 'static;
    type Output: 'static;

    fn update(
        &mut self,
        message: Self::Message,
        cx: &mut UpdateContext<'_, Self>,
    );

    fn view(
        &self,
        cx: &mut ViewContext<'_>,
    ) -> impl View<Self::Message>;
}
```

这两个方法的责任固定：

- `update` 修改组件状态、发起受管理任务或用 `cx.output(...)` 送出公开结果。
- `view` 只读取状态并声明界面，不执行文件、网络或进程操作。

`impl View<M>` 保留具体 Rust 类型，不要求每个节点做动态分发。只有插件、运行时注册页面等真正开放的边界才使用 `AnyComponent<M, O>`。

### 1.2 消息

消息用 enum 表达，新增状态后由 Rust 检查遗漏分支：

```rust
pub enum WorkbenchMessage {
    ActivatePart(PartId),
    OpenResource(ResourceId),
    Resize(ResizeMessage),
    TogglePanel,
    ShowSettings,
    CloseOverlay,
    LoadFinished(Result<WorkspaceData, WorkspaceError>),
    TitleBar(TitleBarOutput),
    ActivityBar(ActivityBarOutput),
    Sidebar(SidebarOutput),
    Editor(EditorOutput),
    Panel(PanelOutput),
    StatusBar(StatusBarOutput),
    Overlay(OverlayOutput),
}
```

消息描述“发生了什么”，不携带任意回调。子组件的内部 `Message` 由 ZUI 送回子组件自己的 `update`；只有公开 `Output` 会映射成父组件消息：

```rust
component(style.child, &self.child)
    .on_output(ParentMessage::Child)
```

没有公开输出的组件使用 `Never`。这样父组件不会知道子组件如何处理悬停、编辑和键盘导航，只会收到跨组件边界确实需要的结果。

### 1.3 视图

`ui!` 只简化 Rust 语法。条件、循环、枚举分支和数据转换仍是普通 Rust：

```rust
zui::ui! {
    column(style.root) {
        text(style.title, self.title.as_str())

        if self.items.is_empty() {
            text(style.empty_message, "No items")
        } else {
            for item in &self.items {
                component(
                    style.item.key(item.id),
                    ItemRow::new(item),
                )
                .map(Message::Item)
            }
        }
    }
}
```

宏展开后必须是类型化 `View`，不能生成需要运行时解释的字符串节点或选择器。

### 1.4 样式

样式按组件声明，节点种类、角色名、字段名和带单位的值共同说明含义：

```rust
zui::styles! {
    pub WorkbenchStyles {
        stack root {
            width: Length::Fill;
            height: Length::Fill;

            grid workbench_layout {
                width: Length::Fill;
                height: Length::Fill;
                rows: tracks![auto(), fr(1), auto()];
                columns: tracks![auto(), auto(), fr(1), auto()];

                slot title_bar: TitleBar {
                    grid_row: line(1);
                    grid_column: span(4);
                }

                slot activity_bar: ActivityBar {
                    grid_row: line(2);
                    grid_column: line(1);
                }

                slot primary_sidebar: PrimarySidebar {
                    grid_row: line(2);
                    grid_column: line(2);
                    min_width: px(180);
                }

                slot editor_area: EditorArea {
                    grid_row: line(2);
                    grid_column: line(3);
                    min_width: px(0);
                    min_height: px(0);
                }

                optional slot panel: BottomPanel {
                    grid_row: line(2);
                    grid_column: line(4);
                }

                slot status_bar: StatusBar {
                    grid_row: line(3);
                    grid_column: span(4);
                }
            }

            slot overlay: OverlayHost {
                position: Position::Absolute;
                inset: Insets::uniform(px(0));
            }
        }
    }
}
```

应用代码不写尺寸 `as f32`。`px(24)`、`percent(50)`、`fr(1)`、`ms(120)` 等构造函数产生受检查的领域类型；数值只有进入 ZUI 内部计算后才转换为底层表示。

## 2. 如何划分工程

crate 只用于能力和依赖隔离，不按每个组件拆分。一个大型桌面应用通常分为四层：

| 层 | 拥有什么 | 不拥有什么 |
| --- | --- | --- |
| ZUI | 窗口、组件、布局、文本、输入、绘制、语义和测试能力 | 任何产品领域概念 |
| 通用控件 | Button、Input、Tree、Menu、Dialog、Split 等 | 产品命令和产品状态 |
| 领域功能 | Files、Search、Editor、Terminal 等组件及领域模型 | 应用启动和窗口装配 |
| 应用 | 服务实例、窗口、根组件和跨功能消息路由 | 子组件内部布局 |

依赖保持单向：

```text
ZUI ← 通用控件 ← 领域功能 ← 应用
```

中型项目可以这样组织：

```text
src/
├── main.rs
├── application.rs
├── workbench.rs
├── workbench/
│   ├── state.rs
│   ├── style.rs
│   ├── title_bar.rs
│   ├── sidebar.rs
│   ├── editor_area.rs
│   ├── panel.rs
│   ├── status_bar.rs
│   └── overlay_host.rs
├── files.rs
├── files/
│   ├── state.rs
│   ├── style.rs
│   └── tree.rs
└── editor.rs
```

组件较小时，行为、消息和样式放在同一文件相邻位置。只有样式或状态已经明显妨碍阅读时才拆出 `style.rs` 或 `state.rs`，不要再按颜色、间距和事件类型细拆。

## 3. 启动应用和窗口

一个窗口接收一个根组件。应用负责服务装配和多窗口关系，不参与子组件绘制：

```rust
use zui::{Application, Window};

fn main() -> Result<(), zui::Error> {
    Application::builder()
        .service(WorkspaceService::new())
        .window(
            Window::builder()
                .title("Code Workbench")
                .size(size(1440, 900))
                .minimum_size(size(800, 560))
                .root(CodeWorkbench::new()),
        )
        .run()
}
```

每个窗口独立拥有：

- 根组件实例与组件身份树。
- 焦点、悬停、捕获、输入法和拖动状态。
- 视口、缩放比例、语义树和一帧绘制结果。
- 窗口级命令路由和覆盖层宿主。

跨窗口共享的文档模型可以放进服务；焦点、滚动位置、面板尺寸等窗口状态不能放进进程全局变量。

打开第二个窗口由消息触发，再由应用上下文执行：

```rust
cx.application().open_window(
    Window::builder()
        .title(document.title())
        .root(DocumentWindow::new(document.id())),
)?;
```

## 4. 设计工作台组件树

先画组件归属树，再写布局。类 VS Code 工作台可以使用以下层级：

```text
CodeWorkbench
├── TitleBar
├── ActivityBar
├── PrimarySidebar
│   └── ActiveSidebarView
├── EditorArea
│   └── EditorGroup × N
│       ├── EditorTabs
│       │   └── EditorTab × N
│       └── ActiveEditor
├── AuxiliarySidebar
├── BottomPanel
├── StatusBar
└── OverlayHost
    ├── QuickInput
    ├── ContextMenu
    ├── Dialog
    └── SettingsPage
```

创建组件边界时依次判断：

- 是否有独立状态，例如选择、展开、滚动或拖动。
- 是否有独立交互，例如焦点、键盘导航或语义角色。
- 是否有生命周期资源，例如订阅、任务或缓存。
- 是否重复出现并需要稳定身份。
- 是否确实被多个调用方复用。

背景、分隔线、图标、文字和局部排列通常只是组件内部节点，不单独成为组件。

工作台根组件只组合区域：

```rust
impl Component for CodeWorkbench {
    type Message = WorkbenchMessage;
    type Output = Never;

    fn update(&mut self, message: Self::Message, cx: &mut UpdateContext<'_, Self>) {
        match message {
            WorkbenchMessage::ActivatePart(part) => self.active_part = part,
            WorkbenchMessage::Resize(message) => self.layout.resize(message),
            WorkbenchMessage::ShowSettings => {
                self.overlay = Overlay::Settings(SettingsState::new())
            }
            WorkbenchMessage::CloseOverlay => self.overlay = Overlay::None,
            WorkbenchMessage::LoadFinished(result) => self.workspace.apply(result),
            WorkbenchMessage::OpenResource(id) => self.editor_area.open(id, cx.services()),
            WorkbenchMessage::TogglePanel => self.layout.toggle_panel(),
            WorkbenchMessage::TitleBar(output) => self.handle_title_bar(output, cx),
            WorkbenchMessage::ActivityBar(output) => self.handle_activity_bar(output),
            WorkbenchMessage::Sidebar(output) => self.handle_sidebar(output),
            WorkbenchMessage::Editor(output) => self.handle_editor(output),
            WorkbenchMessage::Panel(output) => self.handle_panel(output),
            WorkbenchMessage::StatusBar(output) => self.handle_status_bar(output),
            WorkbenchMessage::Overlay(output) => self.handle_overlay(output),
        }
    }

    fn view(&self, _cx: &mut ViewContext<'_>) -> impl View<Self::Message> {
        let style = WorkbenchStyles::new(&self.layout);

        zui::ui! {
            stack(style.root) {
                grid(style.workbench_layout) {
                    component(style.title_bar, &self.title_bar)
                        .on_output(WorkbenchMessage::TitleBar)

                    component(style.activity_bar, &self.activity_bar)
                        .on_output(WorkbenchMessage::ActivityBar)

                    component(style.primary_sidebar, &self.sidebar)
                        .on_output(WorkbenchMessage::Sidebar)

                    component(style.editor_area, &self.editor_area)
                        .on_output(WorkbenchMessage::Editor)

                    if self.layout.panel_visible() {
                        component(style.panel, &self.panel)
                            .on_output(WorkbenchMessage::Panel)
                    }

                    component(style.status_bar, &self.status_bar)
                        .on_output(WorkbenchMessage::StatusBar)
                }

                component(style.overlay, &self.overlay_host)
                    .on_output(WorkbenchMessage::Overlay)
            }
        }
    }
}
```

这里的父组件只控制子组件插槽的几何。`CodeWorkbench` 不能访问 `EditorTab` 的文字节点或 `FilesRow` 的图标角色。

## 5. 状态、任务和服务

状态按所有权分层，不按“方便访问”集中到一个大对象：

| 状态 | 所有者 | 示例 |
| --- | --- | --- |
| 应用状态 | 应用 | 窗口集合、共享服务连接 |
| 窗口状态 | 根组件 | 活跃区域、覆盖层、区域尺寸 |
| 领域状态 | 领域模型 | 文件树、文档、诊断、终端会话 |
| 组件状态 | 具体组件 | 展开项、输入文本、局部选择 |
| 瞬时交互状态 | ZUI | 悬停、按压、捕获、输入法组合 |

耗时操作由 `UpdateContext` 管理，结果重新变成消息：

```rust
fn update(&mut self, message: Message, cx: &mut UpdateContext<'_, Self>) {
    match message {
        Message::OpenWorkspace(path) => {
            cx.task(async move {
                WorkspaceService::load(path).await
            })
            .then(Message::WorkspaceLoaded);
        }
        Message::WorkspaceLoaded(result) => self.workspace.apply(result),
    }
}
```

组件销毁时，属于该组件的订阅和任务由上下文取消。需要继续运行的任务必须显式提升到应用或服务所有者，不能靠泄漏句柄延长生命周期。

## 6. 布局和可调整区域

普通排列使用 `row`、`column`、`grid`、`stack` 和 `scroll`。用户可拖动的区域使用 `Split` 控件，不在业务组件里重复实现指针捕获和最小尺寸算法。

```rust
component(
    style.body,
    Split::horizontal()
        .pane(
            Pane::new(self.sidebar.view())
                .key(PartId::Sidebar)
                .size(self.layout.sidebar)
                .minimum(px(180))
                .maximum(px(640)),
        )
        .pane(
            Pane::new(self.editor.view())
                .key(PartId::Editor)
                .minimum(px(320))
                .grow(fr(1)),
        )
        .on_resize(Message::Resize),
)
```

`Split` 必须处理：

- 指针和键盘调整。
- 最小、首选、最大尺寸约束。
- 缩放比例和逻辑像素转换。
- 零尺寸、窗口过小和面板隐藏。
- 分隔条的命中区域、视觉区域、焦点和语义值。

组件保存用户的首选尺寸；每一帧的最终尺寸由布局器根据可用空间计算。不能把某次窄窗口下的压缩结果反写成用户首选尺寸。

所有可收缩的文本或滚动区域都要显式允许收缩：

```rust
text file_name {
    flex_grow: flex(1);
    flex_shrink: flex(1);
    min_width: px(0);
    white_space: WhiteSpace::NoWrap;
    text_overflow: TextOverflow::Ellipsis;
}
```

## 7. 通用控件与领域组件

通用控件只拥有可复用的交互语义：

```rust
Button::new("Open")
    .icon(Icon::FolderOpen)
    .on_press(Message::Open)
```

业务含义由调用方消息表达。`Button` 不知道“打开工作区”，`Tree` 不知道“文件资源管理器”，`Dialog` 不知道“删除确认”。

控件公开的定制边界应是：

- 类型化内容插槽。
- 有穷枚举变体，例如 `ButtonKind::Primary`。
- 明确的尺寸或行为参数。
- 控件自己定义的完整样式输入。

控件不公开内部角色句柄，也不接受任意字段表让调用方穿透修改。

## 8. 文件树

文件功能可以继续分成：

```text
Files
├── FilesToolbar
└── FilesTree
    └── FilesRow × 可见项
        └── RowActions
```

虚拟树必须使用领域稳定键：

```rust
VirtualTree::new(&self.visible_rows)
    .key(|row| row.resource_id)
    .depth(|row| row.depth)
    .expanded(|row| row.expanded)
    .row(|row| FilesRow::new(row))
    .on_message(Message::Row)
```

数组位置不能作为身份。插入、排序、折叠或虚拟化之后，组件状态和焦点必须仍跟随同一个 `ResourceId`。

行组件的内部层级保持小而明确：

```text
FilesRow::root
├── indentation
├── expand_icon
├── resource_icon
├── file_name
└── trailing_actions
```

`FilesTree` 只控制行插槽宽度和列表关系；文件名截断、图标间距和操作按钮显隐由 `FilesRow` 自己拥有。

## 9. 编辑器区域

编辑器区域管理分组和标签页，不把所有编辑器压成一个巨大组件：

```text
EditorArea
└── EditorGroup × N
    ├── EditorTabs
    │   └── EditorTab × N
    └── EditorView
        ├── TextEditor
        ├── ImageViewer
        ├── SettingsEditor
        └── ExtensionEditor
```

封闭的编辑器集合使用 enum，保证分支穷尽：

```rust
pub enum EditorView {
    Text(TextEditor),
    Image(ImageViewer),
    Settings(SettingsEditor),
    Extension(ExtensionEditor),
}
```

只有允许第三方在运行时注册编辑器时，注册边界才保存 `AnyComponent<EditorMessage, EditorOutput>`。动态分发停留在注册边界，具体编辑器内部仍返回静态 `impl View`。

文本编辑器、终端、图表等复杂区域可以提供专用绘制节点：

```rust
canvas(style.viewport)
    .semantics(self.accessible_document())
    .paint(|geometry, painter| {
        self.renderer.paint(geometry, painter)
    })
```

`geometry` 来自同一布局结果。专用绘制不能自己维护另一套坐标用于命中或语义输出。

## 10. 面板、状态栏和覆盖层

底部面板是工作台布局的一部分；菜单、对话框和快速输入属于覆盖层。两者不能混在同一容器里。

`OverlayHost` 负责：

- 遮罩、层级和窗口边界避让。
- 焦点进入、焦点恢复和模态限制。
- Escape、点击外部和关闭消息。
- 锚点定位及窗口缩放后的重新布局。

覆盖层状态使用 enum，保证同一宿主的互斥关系清楚：

```rust
pub enum Overlay {
    None,
    QuickInput(QuickInputState),
    ContextMenu(ContextMenuState),
    Dialog(DialogState),
    Settings(SettingsState),
}
```

确实允许并存的提示、通知和浮层使用独立集合与稳定键，不把所有内容塞进这个互斥 enum。

## 11. Settings 页面层级示例

Settings 用来验证 ZUI 的组件边界、固定区域和滚动边界。它不是 ZUI 内置页面。

```text
SettingsPage
├── SettingsSidebar
│   ├── SearchBox
│   └── SettingsNavigation
│       └── SettingsNavigationItem × N
├── SettingsContentViewport
│   └── SettingsSection
│       ├── SettingsSectionHeader
│       └── SettingsGroup × N
│           └── SettingsRow × N
└── IconButton (close)
```

页面壳只决定三个插槽：

```rust
zui::styles! {
    pub SettingsPageStyles {
        stack root {
            width: Length::Fill;
            height: Length::Fill;

            row body {
                width: Length::Fill;
                height: Length::Fill;

                slot sidebar: SettingsSidebar {
                    width: px(280);
                    flex_shrink: flex(0);
                }

                slot content: SettingsContentViewport {
                    flex_grow: flex(1);
                    flex_shrink: flex(1);
                    min_width: px(0);
                    min_height: px(0);
                }
            }

            slot close_button: IconButton {
                position: Position::Absolute;
                top: px(12);
                right: px(12);
            }
        }
    }
}
```

由此得到三个明确行为：

- 搜索框属于侧栏，内容滚动时保持固定。
- 主内容只在 `SettingsContentViewport` 内滚动。
- 关闭按钮属于页面壳，不随侧栏或内容滚动。

分区类型使用 enum，不使用字符串查找组件：

```rust
pub enum SettingsSection {
    General(GeneralSettings),
    Appearance(AppearanceSettings),
    Keybindings(KeybindingSettings),
    Remote(RemoteSettings),
}
```

窄窗口使用显式布局状态：

```rust
pub enum SettingsLayout {
    TwoPane,
    Navigation,
    Content,
}
```

组件根据宿主约束选择状态，样式对 enum 做穷尽匹配。不能通过全局查询去修改另一个组件内部节点。

## 12. 输入、焦点和命令

输入先由 ZUI 命中并转换成控件消息，再进入组件 `update`。业务组件不直接读取窗口事件流。

```rust
button(style.open_button, "Open")
    .on_press(Message::Open)
    .shortcut(Command::OpenResource)
```

命令描述用户意图，快捷键只是命令的一种触发方式。菜单、按钮、命令面板和快捷键应发出同一个命令。

焦点规则由组件层级和控件语义决定：

- Tab 在可聚焦控件间移动。
- 方向键在树、列表、标签页和菜单内部移动。
- 打开模态覆盖层时焦点进入覆盖层，关闭后回到触发控件。
- 指针捕获在拖动结束、窗口失焦或组件销毁时可靠释放。
- 不可见、禁用或被裁剪的节点不能保留可操作命中区域。

## 13. 无障碍

语义信息和视觉节点来自同一 `View` 树：

```rust
tree_item(style.row, row.title())
    .expanded(row.expanded())
    .selected(row.selected())
    .level(row.depth() + 1)
    .position(row.index() + 1, row.sibling_count())
    .on_activate(Message::Open(row.id))
```

每个复用控件必须同时具备：

- 正确角色、名称、状态和值。
- 不依赖指针的键盘操作。
- 可见焦点指示。
- 禁用、错误和进度状态的语义输出。
- 缩放、高对比度和减少动画条件下的可用结果。

编辑器、终端和画布不能只暴露一个无含义矩形。它们需要提供结构化语义或专门的可访问内容视图。

## 14. 样式值、颜色和字体

组件只消费语义输入，不在业务节点里散落颜色字面量和字体名称：

```rust
pub struct NavigationAppearance {
    pub row_height: Positive<LogicalPx>,
    pub text: Color,
    pub text_selected: Color,
    pub background_selected: Color,
    pub focus_border: Color,
    pub body_font: FontSpec,
}
```

这个结构可以由应用、系统或其他来源创建；ZUI 样式系统不规定它从哪里加载。组件只要求输入完整、类型正确并满足约束。

字体使用明确字重：

```rust
text section_title {
    font: appearance.body_font.clone();
    font_weight: FontWeight::Semibold;
    font_size: px(20);
    line_height: LineHeight::Absolute(px(28));
}
```

如果请求的字重不可用，字体解析器必须返回可检查的实际字形选择，不能悄悄把所有字重映射到同一细字形。

## 15. 测试

组件测试不需要真实桌面窗口。测试运行时从根组件生成确定性帧：

```rust
#[test]
fn settings_content_scrolls_without_moving_sidebar() {
    let mut app = TestApplication::new(SettingsPage::fixture());
    let before = app.render(size(1000, 720));

    app.pointer().scroll(point(760, 500), vector(0, 320));
    let after = app.render(size(1000, 720));

    assert_eq!(
        before.inspect().bounds("SettingsSidebar::root"),
        after.inspect().bounds("SettingsSidebar::root"),
    );
    assert_ne!(
        before.inspect().bounds("SettingsSection::root"),
        after.inspect().bounds("SettingsSection::root"),
    );
}
```

至少覆盖五类测试：

| 类型 | 验证内容 |
| --- | --- |
| 状态测试 | Message 是否得到正确状态 |
| 结构测试 | 组件、角色、稳定键和插槽是否正确 |
| 布局测试 | 关键尺寸、滚动边界、截断和极窄窗口 |
| 交互测试 | 指针、键盘、焦点、拖动和输入法 |
| 语义测试 | 角色、名称、状态、顺序和可访问操作 |

复杂绘制组件再增加像素或场景快照，但不能用截图代替状态、结构和语义断言。

边界用例至少包含：零宽高、极大缩放、长中文、长英文、emoji、组合字符、双向文本、重复键、非有限动态值、窗口失焦、组件在拖动中销毁和异步结果晚到。

## 16. 从空项目到完整工作台

建议按依赖顺序完成，而不是按屏幕从左到右堆节点：

1. 定义领域状态、服务接口和根消息。
2. 建立应用、窗口与根组件。
3. 画出组件归属树并固定每个所有者。
4. 建立工作台网格、可调整区域和覆盖层宿主。
5. 完成 Button、Input、Tree、Tabs、Split、Scroll、Menu、Dialog 等通用控件。
6. 接入 Files、Search、Editor、Terminal 等领域组件。
7. 为每个组件声明局部样式角色和语义输入。
8. 补齐键盘、焦点、输入法和无障碍行为。
9. 用确定性测试覆盖状态、结构、布局、交互和语义。
10. 最后做绘制性能、虚拟化和缓存优化。

## 17. 完成标准

一个桌面应用符合这套 ZUI 写法，应同时满足：

- 产品状态只能通过类型化消息改变。
- 组件树能看出状态、交互和生命周期的所有者。
- 父组件只控制子组件插槽，不穿透子组件内部样式。
- 重复组件使用稳定领域键，不使用数组位置。
- 宏和 builder 使用同一类型、校验与错误语义。
- 尺寸、比例、时间和颜色使用明确类型，业务代码不转换裸浮点。
- 布局、裁剪、命中、绘制、语义和检查信息共享同一几何。
- 可调整区域、滚动区域和覆盖层各有明确边界。
- 所有控件支持键盘、可见焦点和正确语义。
- 静态组件路径保持静态分发；开放注册边界才使用动态分发。
- 实现缺口被视为 ZUI 的符合性问题，不反过来修改应用规范。

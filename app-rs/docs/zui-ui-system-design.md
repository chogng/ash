# ZUI 样式系统设计

> 状态：Proposed（ZUI 公共样式规范）
>
> 所有权：本文只定义 ZUI 样式的声明、作用域、扩展、解析、校验和失效语义。颜色、字体、尺寸等输入值由谁提供，不属于本文范围。

本文定义 ZUI 样式系统最终对应用开发者公开的模型、语义和写法。ZUI 的实现必须符合本文，本文不根据某个产品、仓库结构或已有接口降低约束。使用这套公共模型搭建完整桌面界面见 [ZUI 桌面界面开发手册](zui-desktop-ui-guide.md)。

文中的宏、trait、类型和错误行为共同构成公共规范。内部实现可以自由组织，但不能改变字段含义、组件边界、校验结果和失效语义。Settings、工作台、编辑器等名称只用于验证通用性，不成为 ZUI 的架构依赖。

## 快速理解

ZUI 不实现完整 CSS，也不把所有组件字段塞进一个巨大结构。它提供一套通用样式核心，由基础节点和组件专有样式共同使用；开发者仍按“节点 → 属性 → Rust 表达式”书写，并由 Rust 检查组件边界、字段类型、单位和动态值。

| 问题 | 设计结论 |
| --- | --- |
| 是否能用于不同界面 | 可以。作用域、角色、值、解析、校验和失效是通用核心 |
| 新组件有专有字段怎么办 | 定义类型化节点样式结构，接入同一解析流程，不修改巨大公共结构 |
| 看到字段能否理解含义 | 节点种类、业务角色、完整属性名和类型化值共同表达含义 |
| 条件和重复节点怎么办 | 使用 `optional`、`many` 和稳定键，不生成运行时选择器 |
| 父组件如何控制子组件 | 只能设置子组件插槽的几何并传入公开样式，不能访问子组件内部角色 |
| 宏是不是另一套能力 | 不是。宏和 builder 生成同一类型并经过同一校验路径 |
| Settings 页面如何分层 | 页面壳、侧栏、导航、滚动内容和具体分区各自拥有组件边界与局部样式树 |

## 1. 范围与长期不变量

### 1.1 本文负责

- 组件样式如何声明和绑定。
- 基础节点与组件专有字段如何接入同一系统。
- 静态、可选、重复和子组件插槽如何表达。
- 数字、单位、范围和动态值如何校验。
- 组件状态如何显式映射成最终属性。
- 样式变化如何触发测量、布局、裁剪或绘制。
- 错误如何携带完整组件和角色路径。

### 1.2 本文不负责

- 样式输入值的存储和加载方式。
- 具体产品的视觉规范。
- 业务状态、命令和数据模型如何产生。
- 焦点顺序、键盘行为和具体交互流程。

### 1.3 长期不变量

- 正常渲染路径不解析字符串选择器。
- 父组件不能穿透子组件样式作用域。
- 同一属性只有一个明确结果，不依赖源码顺序覆盖。
- 所有进入布局和绘制的数值都带单位并经过有限值检查。
- 宏、builder 和组件专有样式使用同一解析器。
- 布局、裁剪、绘制、命中和检查信息使用同一份最终几何。

## 2. 三层架构

样式系统分为通用样式核心、节点样式结构和组件样式树。三层解决不同问题，不能合并成一个结构。

| 层 | 负责什么 | 不知道什么 |
| --- | --- | --- |
| 通用样式核心 | 作用域、角色、值类型、解析、校验、诊断、失效 | Settings、编辑器、终端等产品概念 |
| 节点样式结构 | 一个节点种类允许哪些属性以及属性影响范围 | 节点属于哪个具体组件 |
| 组件样式树 | 组件内部有哪些命名角色、如何嵌套、使用哪种节点样式结构 | 输入值从哪里获得 |

### 2.1 通用样式核心

核心模型可以概括为：

```text
Role<Scope, Parent, Schema, Cardinality>
```

| 参数 | 含义 |
| --- | --- |
| `Scope` | 角色属于哪个组件类型 |
| `Parent` | 角色位于哪个命名角色子树 |
| `Schema` | 角色允许使用哪组属性 |
| `Cardinality` | 角色是单个、可选、重复还是子组件插槽 |

这些信息全部存在于 Rust 类型中。运行时可以生成可读路径用于诊断，但不能通过路径字符串获得样式修改能力。

核心还拥有：

- `StyleValue<T>`：静态值或已类型化动态值。
- `ResolvedStyle<S>`：某种节点样式结构的只读解析结果。
- `StyleError`：动态值、约束和角色实例错误。
- `StyleEffect`：属性变化影响测量、布局、裁剪还是绘制。

### 2.2 节点样式结构

节点样式结构定义允许的字段及其类型。公共接口是：

```rust
pub trait NodeStyleSchema: Sized {
    type Resolved;

    fn resolve(self) -> Result<Self::Resolved, StyleError>;
}
```

内置结构覆盖通用界面原语：

| 结构 | 主要用途 |
| --- | --- |
| `RowStyle` | 横向排列子节点 |
| `ColumnStyle` | 纵向排列子节点 |
| `GridStyle` | 二维轨道布局 |
| `StackStyle` | 覆盖与定位 |
| `ScrollStyle` | 滚动视口和滚动内容约束 |
| `TextStyle` | 文本测量、换行、截断和绘制 |
| `ImageStyle` | 图片适配、采样和绘制 |
| `IconStyle` | 图标尺寸、对齐和绘制 |
| `BoxStyle` | 不拥有子布局的普通矩形节点 |
| `SlotStyle<C>` | 子组件在父组件中的几何位置 |

`row` 和 `column` 是不同结构，不用一个随时可改的方向字段表示。文本截断字段只存在于 `TextStyle`，滚动字段只存在于 `ScrollStyle`。

### 2.3 组件专有样式结构

基础结构不可能提前包含编辑器、终端、图表和其他复杂绘制的全部字段。组件可以声明专有结构，但必须通过同一接口解析：

```rust
#[derive(NodeStyleSchema)]
pub struct EditorPaintStyle {
    #[style(affects = "measure")]
    pub line_height: Positive<LogicalPx>,

    #[style(affects = "paint")]
    pub caret_width: NonNegative<LogicalPx>,

    #[style(affects = "paint")]
    pub caret_color: Color,
}
```

扩展规则：

- 字段必须是公开可理解的领域类型，不能是无类型属性映射。
- 每个字段必须声明约束和最小失效范围。
- 派生代码必须生成与内置结构相同的解析、诊断和检查信息。
- 组件专有结构不能向父组件公开内部角色。
- 新增专有结构不要求修改 ZUI 通用核心。

这才是泛化：新能力加入同一受约束流程，而不是让公共结构无限增大。

### 2.4 Rust GUI 执行模型

`styles!` 是编译期代码生成工具，不是运行期样式解释器。宏输入中的值是普通 Rust 表达式，宏展开后直接构造角色类型和节点样式结构，因此 rust-analyzer、编译器和普通单元测试都能理解它。

组件构建 ZUI 的保留组件树和元素树；样式解析得到 `ResolvedStyle`，布局读取它完成测量和约束分配，绘制再读取最终几何与绘制字段生成 WGPU 场景。绘制阶段不重新查询选择器，也不根据字符串寻找祖先。

Rust GUI 约束如下：

- 节点样式结构是 Rust struct 和 trait，不是属性字典。
- 值是 `LogicalPx`、`Length`、`Color` 等 Rust 类型，不是字符串。
- 状态组合使用 Rust enum 和穷尽 `match`，不使用运行时伪状态权重。
- 条件节点和重复节点使用普通 Rust 控制流，样式角色只检查数量和身份。
- 宏不能引入 builder 无法表达的语义。
- 样式解析完成后，布局和绘制只消费只读结果。

## 3. 组件树与局部样式树

大型界面同时存在两棵树。

### 3.1 组件归属树

组件树表达行为、状态、生命周期和公开组合边界：

```text
Workbench
└── PanePart
    └── Files
        ├── FilesToolbar
        └── FilesTree
            └── FilesRow
                └── RowActions
```

父组件可以决定子组件插槽的位置和尺寸，可以传入子组件公开接受的完整样式，也可以选择子组件公开的变体。父组件不能查找或改写 `FilesRow::file_name` 之类的内部角色。

### 3.2 局部样式树

单个组件内部使用命名角色表达结构：

```rust
zui::styles! {
    pub(crate) FilesRowStyles {
        row root {
            height: px(24);
            column_gap: px(8);
            align_items: AlignItems::Center;

            text file_name {
                flex_grow: flex(1);
                flex_shrink: flex(1);
                min_width: px(0);
                text_overflow: TextOverflow::Ellipsis;
                white_space: WhiteSpace::NoWrap;
            }

            slot trailing_actions: RowActions {
                flex_shrink: flex(0);
            }
        }
    }
}
```

节点嵌套表示局部归属，不要求两个命名角色是直接父子。中间允许增加无名实现节点；把 `file_name` 移到另一个命名分支时则必须显式调整样式树。

### 3.3 样式路径只用于诊断

开发工具可以显示：

```text
Workbench/PanePart/Files/FilesTree/FilesRow::root/file_name
```

路径由已经建立的组件实例和角色关系生成，只用于检查、日志和错误定位。ZUI 不在运行时解析它，也不使用它匹配节点。

## 4. 角色数量与动态结构

固定树、条件内容、列表和子组件需要不同的角色数量规则。

| 声明 | 含义 | 身份规则 |
| --- | --- | --- |
| 普通角色 | 一个组件实例中恰好一个 | 角色类型 |
| `optional` | 当前构建中零个或一个 | 角色类型 |
| `many` | 当前构建中零个或多个 | 角色类型与稳定键 |
| `slot` | 一个子组件实例 | 父组件只拥有插槽几何 |
| `optional slot` | 条件子组件 | 存在时开启子组件作用域 |
| `many slot` | 重复子组件 | 角色类型、稳定键与子组件实例 |

示意语法：

```rust
column navigation_list {
    optional text empty_message {
        text_overflow: TextOverflow::Ellipsis;
    }

    many slot navigation_item: SettingsNavigationItem
        keyed_by SettingsSectionId
    {
        width: Length::Fill;
    }
}
```

### 4.1 条件角色

`optional` 只表达角色是否存在，不承担业务判断。组件使用普通 Rust 条件决定是否构建节点；构建器检查同一分支最多绑定一次。

### 4.2 重复角色

`many` 必须提供稳定键。数组位置不能作为默认身份，因为插入、排序或虚拟化会改变位置。重复角色的一份样式规则可供所有实例使用，实例状态通过键和类型化状态单独解析。

### 4.3 虚拟列表

虚拟列表不会把全部数据项扩展成样式节点。样式树只保存一份重复角色规则；可见项按稳定键生成角色实例。移出视口的实例可以释放，不影响其余实例身份。

### 4.4 子组件插槽

`slot` 是组件边界，不是后代选择器。父组件只设置插槽的宽高、伸缩、边距、定位和可见性；子组件根节点以内的属性由子组件自己的样式树拥有。

## 5. 字段必须能直接读懂

一个声明由四部分共同说明含义：

```text
节点种类 + 业务角色 + 完整属性名 + 类型化 Rust 值
text       file_name   text_overflow   TextOverflow::Ellipsis
row        root        column_gap      px(8)
```

### 5.1 命名规则

- 根节点统一使用 `root`，不使用含义不确定的 `surface`。
- 业务角色描述内容或职责，例如 `file_name`、`trailing_actions`，不使用泛化的 `label`、`item`。
- 有多种语义的字段写完整限定，例如 `text_overflow` 和 `content_overflow`。
- 只在语义本身属于弹性布局时使用 `flex_grow`、`flex_shrink`、`flex_basis`。
- 横向与纵向间距分别使用 `column_gap` 和 `row_gap`；只有二维都相同时才允许 `gap`。
- 不提供同义字段和缩写别名。

### 5.2 数字与单位

宏中的值是普通 Rust 表达式。尺寸通过简短构造函数获得单位，不引入 `24px` 之类脱离 Rust 语法和工具链的自定义字面量：

```rust
row root {
    height: px(24);
    column_gap: px(8);
    opacity: UnitRatio::try_new(0.92)?;
    padding: Insets::xy(px(8), px(4));
}
```

builder 使用等价的类型化构造函数：

```rust
RowStyle::builder()
    .height(px(24))
    .column_gap(px(8))
    .opacity(UnitRatio::try_new(0.92)?)
    .build()?;
```

动态变量必须已经是目标字段接受的类型：

```rust
height: metrics.row_height;
column_gap: metrics.item_gap;
```

业务代码不写 `as f32`。只有 ZUI 内部在完成单位、有限值和范围检查后才能取得底层浮点值。

### 5.3 基础值类型

| 类型 | 约束 |
| --- | --- |
| `LogicalPx` | 有限值；具体字段决定是否允许负数 |
| `DevicePx` | 只用于设备像素边界，不进入组件声明 |
| `Length` | `auto`、逻辑像素、百分比或受支持的布局长度 |
| `Insets<T>` | 一、二或四边值，元素单位一致 |
| `Flex` | 有限且非负 |
| `UnitRatio` | 闭区间 `[0, 1]` |
| `Angle` | 单位明确并完成规范化 |
| `Duration` | 有限且非负 |
| `Color` | 已解析颜色值 |
| `FontSpec` | 字体族、字重和字形等明确字段 |

同一角色的同一属性写两次是错误，不采用“最后一个生效”。未声明属性使用对应节点样式结构的文档化初始值，不从祖先猜测。

## 6. 样式组合与状态

### 6.1 复用完整类型

样式复用使用普通 Rust 函数和完整类型，不使用任意属性映射拼接：

```rust
fn standard_navigation_row(metrics: NavigationMetrics) -> RowStyle {
    RowStyle::builder()
        .height(metrics.row_height)
        .column_gap(metrics.icon_gap)
        .align_items(AlignItems::Center)
        .build()
}
```

共享函数返回明确节点种类的完整样式或明确命名的值组。组件仍拥有最终角色。ZUI 不提供依赖调用顺序的 patch 链。

### 6.2 状态显式决定属性

状态是组件的类型化输入，样式只负责把状态映射成属性值：

```rust
background: match state.selection {
    Selection::Unselected => colors.navigation_row,
    Selection::Selected => colors.navigation_row_selected,
};

border_color: match (state.focus, state.validation) {
    (Focus::Visible, Validation::Invalid) => colors.invalid_focus,
    (Focus::Visible, Validation::Valid) => colors.focus,
    (Focus::Hidden, Validation::Invalid) => colors.invalid,
    (Focus::Hidden, Validation::Valid) => colors.transparent,
};
```

ZUI 不定义类似伪状态权重的隐式优先级。两个状态同时影响一个属性时，组件必须显式处理组合；Rust 的穷尽检查负责暴露新增状态。

### 6.3 宏与 builder 等价

宏只简化书写。两种写法必须生成相同角色类型、属性值和错误结果：

- 未知属性无法表达。
- 节点样式结构不支持的属性无法表达。
- 重复属性被拒绝，不静默覆盖。
- 动态值经过同一范围检查。
- 自定义节点样式结构与内置结构经过同一解析入口。

## 7. 解析、失效和错误

### 7.1 单一解析路径

```text
类型化输入
   ↓
组件样式函数
   ↓
组件局部角色树
   ↓
角色绑定与节点样式结构校验
   ↓
ResolvedStyle
   ↓
测量、布局、裁剪、绘制与检查信息
```

样式只解析一次，不存在第二套运行时选择器结果。

### 7.2 属性失效范围

| 属性影响 | 变化后至少失效 |
| --- | --- |
| 测量 | 文本测量、节点测量、布局、裁剪、绘制 |
| 布局 | 布局、裁剪、绘制 |
| 裁剪 | 裁剪、命中几何、绘制 |
| 绘制 | 绘制 |

内置字段在定义处固定影响范围，组件专有字段通过节点样式结构声明。组件调用者不手写失效分类。

### 7.3 编译期错误

- 未知节点样式结构或属性名。
- 属性不属于对应节点样式结构。
- 同一作用域重复角色名或重复静态属性。
- 跨组件、跨角色分支绑定。
- 角色与真实节点种类不一致。
- 静态数字超出字段允许范围。
- 普通角色重复绑定。

### 7.4 运行期错误

动态输入或运算结果可能只在运行期确定。以下问题返回结构化 `StyleError`：

- 非有限数字。
- 动态值超出字段范围。
- 最小值大于最大值。
- 受检查运算溢出。
- `many` 角色出现重复稳定键。

错误至少包含：

```text
组件实例路径 + 局部角色路径 + 属性 + 输入位置 + 原因
```

一个组件实例的样式解析是原子的。任何角色解析失败时，不提交该组件本帧的部分新样式。

## 8. Settings 页面如何设计层级

本节只用 Settings 页面验证样式架构是否能覆盖真实界面，不讨论页面数据从哪里获得。图中红框对应一个 `SettingsPage` 组件实例。

### 8.1 组件归属树

```text
Workbench
└── OverlayHost
    └── SettingsPage
        ├── SettingsSidebar
        │   ├── SearchBox
        │   └── SettingsNavigation
        │       └── SettingsNavigationItem × N
        ├── SettingsContentViewport
        │   └── AppearanceSettingsSection
        │       ├── SettingsSectionHeader
        │       └── SettingsValueCard
        └── IconButton (close)
```

组件边界依据行为和生命周期划分，不依据每个矩形划分：

| 组件 | 为什么独立 |
| --- | --- |
| `SettingsPage` | 拥有页面整体布局、当前分区插槽和关闭入口 |
| `SettingsSidebar` | 拥有搜索与导航的组合边界 |
| `SearchBox` | 是可聚焦、可编辑的复用控件 |
| `SettingsNavigation` | 拥有导航集合和重复项 |
| `SettingsNavigationItem` | 每项有独立选择、悬停、按压和聚焦状态 |
| `SettingsContentViewport` | 拥有主内容滚动状态和可用内容宽度 |
| `AppearanceSettingsSection` | 拥有当前分区内容结构 |
| `SettingsSectionHeader` | 提供统一标题、说明和语义边界 |
| `SettingsValueCard` | 拥有键值行集合及其重复布局 |
| `IconButton` | 是可聚焦、可触发的复用控件 |

调色块区域没有独立状态或生命周期，因此先保留为 `AppearanceSettingsSection` 的局部角色，不为了视觉矩形单独创建组件。

### 8.2 `SettingsPage` 的局部样式树

`SettingsPage` 只设置三个子组件插槽，不访问它们的内部角色：

```rust
zui::styles! {
    SettingsPageStyles {
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

关闭按钮属于页面壳，位于滚动视口之外，因此主内容滚动时它保持固定。左右两栏的分隔线属于 `sidebar` 插槽或侧栏根节点的边界，不属于具体导航项。

### 8.3 `SettingsSidebar` 的局部样式树

```rust
zui::styles! {
    SettingsSidebarStyles {
        column root {
            width: Length::Fill;
            height: Length::Fill;
            min_height: px(0);
            padding: Insets::xy(px(12), px(20));
            row_gap: px(16);

            slot search_box: SearchBox {
                width: Length::Fill;
                flex_shrink: flex(0);
            }

            text navigation_heading {
                flex_shrink: flex(0);
                text_overflow: TextOverflow::Ellipsis;
                white_space: WhiteSpace::NoWrap;
            }

            slot navigation: SettingsNavigation {
                flex_grow: flex(1);
                min_height: px(0);
            }
        }
    }
}
```

搜索框固定在侧栏顶部。导航获得剩余空间；当未来导航项变多时，由 `SettingsNavigation` 自己决定滚动，不能让整个页面连同搜索框一起滚动。

### 8.4 导航列表和导航项

`SettingsNavigation` 使用带稳定键的重复插槽：

```rust
zui::styles! {
    SettingsNavigationStyles {
        scroll root {
            scroll_x: ScrollbarVisibility::Hidden;
            scroll_y: ScrollbarVisibility::Auto;

            column item_list {
                width: Length::Fill;
                row_gap: px(4);

                many slot navigation_item: SettingsNavigationItem
                    keyed_by SettingsSectionId
                {
                    width: Length::Fill;
                }
            }
        }
    }
}
```

每个导航项拥有自己的内部角色：

```rust
zui::styles! {
    SettingsNavigationItemStyles {
        row root {
            width: Length::Fill;
            height: px(36);
            padding: Insets::xy(px(12), px(0));
            column_gap: px(10);
            align_items: AlignItems::Center;
            corner_radius: CornerRadius::uniform(px(6));
            background: match state.selection {
                Selection::Unselected => colors.transparent,
                Selection::Selected => colors.navigation_selected,
            };

            icon leading_icon {
                width: px(16);
                height: px(16);
                flex_shrink: flex(0);
            }

            text title {
                flex_grow: flex(1);
                flex_shrink: flex(1);
                min_width: px(0);
                text_overflow: TextOverflow::Ellipsis;
                white_space: WhiteSpace::NoWrap;
            }
        }
    }
}
```

导航文字可收缩，图标不能收缩。`min_width: px(0)`、`WhiteSpace::NoWrap` 和 `TextOverflow::Ellipsis` 必须作为同一文本约束通过校验，避免只裁掉文字却不显示省略号。

### 8.5 主内容滚动边界

```rust
zui::styles! {
    SettingsContentViewportStyles {
        scroll root {
            width: Length::Fill;
            height: Length::Fill;
            min_width: px(0);
            min_height: px(0);
            scroll_x: ScrollbarVisibility::Hidden;
            scroll_y: ScrollbarVisibility::Auto;

            column content_width {
                width: Length::Fill;
                max_width: px(1080);
                min_width: px(0);
                margin_inline: Length::Auto;
                padding: Insets::trbl(px(88), px(60), px(48), px(60));

                slot active_section: SettingsSection {
                    width: Length::Fill;
                }
            }
        }
    }
}
```

滚动条属于右侧内容视口，侧栏和关闭按钮不随它移动。`content_width` 控制阅读宽度和内边距；具体分区只接收已经计算好的可用宽度，不自行读取窗口尺寸。

### 8.6 `AppearanceSettingsSection` 的局部样式树

```rust
zui::styles! {
    AppearanceSettingsSectionStyles {
        column root {
            width: Length::Fill;
            row_gap: px(24);

            slot header: SettingsSectionHeader {
                width: Length::Fill;
            }

            slot summary_card: SettingsValueCard {
                width: Length::Fill;
            }

            column palette_card {
                width: Length::Fill;
                padding: Insets::uniform(px(16));
                row_gap: px(12);
                corner_radius: CornerRadius::uniform(px(8));

                text palette_heading {
                    text_overflow: TextOverflow::Ellipsis;
                    white_space: WhiteSpace::NoWrap;
                }

                row palette_entries {
                    column_gap: px(8);

                    many box color_swatch keyed_by PaletteEntryId {
                        width: px(32);
                        height: px(24);
                        corner_radius: CornerRadius::uniform(px(4));
                    }
                }
            }
        }
    }
}
```

`SettingsValueCard` 内部使用一个带稳定键的 `many row value_row`，每行再包含 `text key` 和 `text value`。由于这些行没有独立行为，不必把每一行拆成组件。

### 8.7 窄窗口行为

Settings 页面不依赖全局查询规则。`SettingsPage` 根据宿主给出的尺寸约束选择明确布局变体：

```rust
pub enum SettingsPageLayout {
    TwoPane,
    Compact,
}
```

`TwoPane` 保留固定侧栏和可收缩内容；`Compact` 改为一次显示导航或内容。布局变体由组件决定，样式函数只对枚举做穷尽匹配。无论使用哪个变体，子组件样式作用域保持不变。

### 8.8 动态分区与样式传递

当前分区使用 Rust enum 表达，不通过字符串名称加载组件：

```rust
pub enum SettingsSectionView<'a> {
    General(GeneralSettingsSection<'a>),
    Appearance(AppearanceSettingsSection<'a>),
    Keybindings(KeybindingsSettingsSection<'a>),
    Remote(RemoteSettingsSection<'a>),
}
```

`SettingsSectionView` 实现统一组件契约，并在 `match` 中把具体分区挂入 `active_section` 插槽。每个 enum variant 仍然开启自己具体组件的样式作用域。

Settings 功能可以使用一个普通 Rust struct 打包需要传给各组件的样式：

```rust
pub struct SettingsStyles {
    pub page: SettingsPageStyles,
    pub sidebar: SettingsSidebarStyles,
    pub search_box: SearchBoxStyle,
    pub navigation: SettingsNavigationStyles,
    pub navigation_item: SettingsNavigationItemStyles,
    pub content: SettingsContentViewportStyles,
    pub section_header: SettingsSectionHeaderStyles,
    pub value_card: SettingsValueCardStyles,
    pub appearance: AppearanceSettingsSectionStyles,
    pub close_button: IconButtonStyle,
}
```

这个 struct 只是显式传递数据，不是全局样式表，也不产生父组件访问子组件内部角色的权限。Settings 组合入口把每个字段交给对应组件；组件内部生成的角色字段保持私有。

## 9. 泛化边界验证

| 场景 | 样式系统如何覆盖 |
| --- | --- |
| 普通固定组件 | 普通角色 |
| 条件提示或空状态 | `optional` 角色 |
| 菜单、列表和表格行 | 带稳定键的 `many` 角色 |
| 重复交互控件 | 带稳定键的 `many slot` |
| 虚拟文件树 | 一份重复规则与可见角色实例 |
| 页面嵌套子组件 | `slot` 开启新的组件作用域 |
| 编辑器或终端专有绘制 | 自定义 `NodeStyleSchema` |
| 多状态组合 | 普通 Rust `match` |
| 可调整窗口 | 组件尺寸约束与类型化布局变体 |
| 长文本和多语言文本 | 真实文本测量、收缩、换行或省略约束 |

通用性不包括复制浏览器的全部选择器和层叠行为。ZUI 的目标是让不同组件共享同一套类型、错误和解析机制，而不是让任意远处代码都能修改任意节点。

## 10. 边界情况

| 场景 | 必须保证的结果 |
| --- | --- |
| 不同组件都有 `title` | 类型和作用域互不影响 |
| 同一组件重复普通角色 | 编译失败 |
| 父组件绑定子组件内部角色 | 编译失败 |
| 文本节点写容器字段 | 编译失败 |
| `many` 出现重复稳定键 | 返回 `StyleError` |
| 动态值是 `NaN` 或无限值 | 返回 `StyleError` |
| 有限值运算溢出 | 受检查运算失败 |
| 容器宽高为零 | 产生零面积确定布局，不崩溃 |
| 固定尺寸总和超过可用空间 | 按伸缩和溢出规则处理并给出诊断 |
| 超长英文、中文、emoji、组合字符或双向文本 | 使用同一文本测量与截断路径 |
| 插入无名实现容器 | 不改变局部角色路径 |
| 命名角色移到另一命名分支 | 绑定失败，要求显式调整 |
| 子组件内部调整 | 父组件样式不受影响 |
| 动态输入频繁改变 | 只使受影响的解析、布局或绘制失效 |

## 11. 不采用的方案

| 方案 | 不采用原因 |
| --- | --- |
| 完整实现 CSS | 引入全局匹配、权重、继承和大量运行时复杂度 |
| 全局类型化选择器 | 即使没有字符串，仍允许远处代码穿透组件边界 |
| 祖先路径选择器 | 组件内部调整会破坏外部样式 |
| 巨大 `ElementStyle` | 无关字段持续增长，非法组合只能拖到运行期发现 |
| 任意属性映射 | 失去字段发现、类型检查和失效信息 |
| 任意 patch 和最后写入生效 | 属性结果依赖调用顺序 |
| 只支持固定角色 | 无法正确表达条件、列表和虚拟化 |
| 用数组位置标识重复角色 | 插入和排序会改变身份 |
| 业务层到处写 `as f32` | 单位、范围和非有限值无法统一检查 |
| 宏和 builder 两套规则 | 同一组件换种写法会得到不同结果 |

## 12. 实现符合性

ZUI 实现是否符合本规范，由公共行为和测试结果判断，不由内部类型名称或文件结构判断。

### 12.1 必须符合

- 应用开发者可以使用本文定义的角色、节点样式结构、数量规则和类型化值完成声明。
- 宏与 builder 必须表达同一能力，并产生相同解析结果和错误。
- 编译期能够确定的问题必须在编译期拒绝；依赖动态输入的问题必须返回结构化错误。
- 样式解析、布局、裁剪、命中、绘制和检查信息必须共享同一份最终几何。
- 组件作用域、重复项身份和子组件插槽语义不能由具体产品重新解释。
- 公开检查接口必须能输出组件实例路径、局部角色路径、最终属性和失效原因。

### 12.2 不影响规范的实现选择

- 宏展开后的私有辅助类型名称。
- 缓存、并行计算和内存布局。
- 绘制后端如何组织命令和资源。
- 源码如何按文件拆分。

如果实现缺少某项规范能力，应记录为实现缺口；不能通过缩小公共语义或引入产品专用例外来改变规范。

## 13. 验收标准

- 新组件可以定义专有节点样式结构而无需修改通用核心。
- 内置和专有节点样式经过同一解析、校验、失效和诊断路径。
- 可以从任意命名节点追溯完整组件实例路径和局部角色路径。
- 父组件无法读取或绑定子组件内部角色。
- 普通、可选、重复和插槽角色都有明确数量与身份规则。
- 宏与 builder 对同一输入产生相同的已解析结果和错误。
- 字段名称不依赖隐藏上下文，尺寸值通过构造函数显示单位。
- 业务代码不需要写 `as f32`。
- 多状态组合没有隐藏优先级。
- 非有限值、范围错误、重复键和约束冲突有稳定诊断。
- Settings 主内容独立滚动，侧栏搜索和关闭按钮保持固定。
- Settings 导航标题在窄宽度下正确收缩并显示省略号。
- 正常构建和绘制路径不执行字符串选择器匹配。

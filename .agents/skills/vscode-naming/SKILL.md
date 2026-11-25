---
name: vscode-naming
description: 按本地 VS Code 源码的职责和调用链为 Ash 的 TypeScript 文件、目录、类和配套 CSS 命名。用于新建、重命名或审查注册入口、Service、编辑器、工作台 Part、内容控件、布局和动作的命名。
---

# VS Code 职责命名

## 判定职责

1. 从 Ash 的真实入口追到创建者和释放者。核对谁注册功能、谁拥有 DOM 和状态、谁决定容器位置、谁渲染内容。把当前文件的主要职责写成一句话。
2. 在仓库根目录旁的 `../vscode/src/vs` 查找相同职责。先找同层、同运行环境的模块，再读它的生产调用方。核对实际路径、文件名、公开类名和配套 CSS。多个候选都能解释名称时，用创建和调用关系决定。
3. 同一职责沿用对应的命名和文件层次。Ash 专属功能借鉴最接近的分工，用本功能的术语命名。目录已提供上下文时，按相邻实现判断文件是否还需要功能前缀。对照不到同职责的上游模块时，明确这是本地命名决定。

## 用名称表达边界

- `Part` 表达真实的 Part 宿主。用户要求复用现有 Part 时，沿调用链确认创建的是原类。左右位置由宿主传入，业务内容挂进各自的内容区。
- `Pane`、`Control`、`Viewer`、`Widget` 从相邻实现和实际契约选用。单独的内容文件应当有独立的输入、行为或生命周期。局部辅助类留在拥有它的模块里。
- 基类名和分工示例用于定位职责。具体编辑器即使继承 `EditorPane`，也应核对 `ChatEditor`、`NotebookEditor` 这类实际注册名。借鉴 Chat 的宿主与内容分工时，各内容模块分别按自己的职责命名。专门承载虚拟行、选中和滚动的组件可参照 `TerminalTabList` 或 `MultiDiffEditorFileList`。
- `layout.ts`、`actions.ts` 等职责文件从实际内容判断。布局模块负责尺寸、位置或布局状态。动作模块负责命令、菜单或动作定义。工具栏文件负责组装和渲染操作控件。
- 同时检查目录、文件、公开符号和 CSS owner。移动文件时更新静态和动态 import、注册入口、fixture 和相关测试引用。用 `rg` 查旧路径和旧符号，再运行类型检查与从真实入口触发的定向测试。

## 注册入口与 Service

- **注册入口**。从生产启动文件追到注册模块，列出该模块直接注册和导入的功能，再判断名称覆盖整个功能还是某个子功能。对照本地 VS Code 中同一注册范围的 `.contribution.ts`。例如，PDF 的入口同时注册编辑器、配置和工作副本恢复，命名为 `pdf.contribution.ts`。配置定义由 `pdfConfiguration.ts` 承载。
- **Service**。从接口标识追到 DI 注册和各生产调用方，核对调用方使用哪些方法，以及服务创建、持有和释放的是编辑器实例、文档模型、工作副本还是其他资源。用实际管理的对象和生命周期选择本地 VS Code 的参照。例如，编辑器通过 PDF 服务取得工作副本，项目文件操作也通过它查找和丢弃备份，因此命名为 `PdfWorkingCopyService`。
- 源码命名迁移与公开标识迁移分别判断。文件名和类名调整时，继续使用原有命令 ID、编辑器注册 ID、配置键及持久化键，除非任务本身要求迁移这些契约。

## 本地源码示例

以下路径相对于 `../vscode/src/vs`。

| 路径 | 核对的职责 |
| --- | --- |
| `workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts` | Chat 宿主创建并布局 Sessions 控件，决定显隐和左右位置。 |
| `workbench/contrib/chat/browser/widgetHosts/editor/chatEditor.ts` | Chat 的编辑器入口，注册名为 `ChatEditor`。 |
| `workbench/contrib/chat/browser/agentSessions/agentSessionsControl.ts` | Sessions 内容控件管理列表、交互和生命周期。 |
| `workbench/contrib/chat/browser/agentSessions/agentSessionsViewer.ts` | Sessions 的树列表渲染器、数据源和列表契约。 |
| `workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts` | 工作台辅助栏容器。目录为 `auxiliarybar`，文件为 `auxiliaryBarPart.ts`。 |
| `sessions/browser/parts/desktopAuxiliaryBarPart.ts` | 桌面编辑器旁的辅助栏沿用现有 Part，文件名表达宿主和职责。 |
| `workbench/browser/layout.ts` | 工作台布局和布局状态。 |
| `workbench/contrib/mediaPreview/browser/mediaPreview.contribution.ts` | 媒体预览功能的注册入口，同时注册配置和编辑器。 |
| `workbench/contrib/notebook/browser/services/notebookEditorService.ts` | 借用 Notebook 编辑器组件并跟踪编辑器实例。 |
| `workbench/services/workingCopy/common/workingCopyService.ts` | 注册和按资源查找工作副本，跟踪其脏状态和保存。 |
| `workbench/contrib/multiDiffEditor/browser/actions.ts` | Multi Diff 的命令定义，与编辑器和列表渲染分属不同文件。 |
| `workbench/contrib/multiDiffEditor/browser/multiDiffEditorFileList.ts` | 编辑器内的文件列表，名称指向内容和列表职责。 |

例如，审查一个编辑器里的两栏时，先确认两边是否真的实例化同一个 Part，再用 Chat 的宿主与 Sessions 内容分工判断导航、批注和布局的归属。

# Stanza 编辑器设计与演进

本文维护 Stanza 通用文本机制的职责与演进依赖。未完成动作与平台验收见[根 TODO](../../TODO.md)，当前实现见 [Editor](../../src/ash/editor/README.md)。

## 目标边界与依赖方向

Stanza 拥有同步文本、坐标、原子事务、版本、历史、选区、输入与视图机制。客户端 Code 由 `editor.code.all.ts` 直接装配；语言分析与其他可选能力通过公开契约注册，由调用宿主拥有其授权、作用域与生命周期。

源码依赖遵守 **Sessions → Workbench → Editor → Platform → Base**。宿主可复用已有模型、Widget 和服务，也可构造符合契约的实现并注入；不把服务容器、传输协议或具体扩展业务带入 Stanza。每个文档仍只有一个有效模型与编辑历史 owner。

扩展的 Schema、结构命令、分页、引用、codec 与包生命周期由扩展及共享宿主拥有。其设计和验收分别见 [Academy](../../extensions/academy/design.md) 与[扩展架构](../editor-extensions.md)，不作为 Stanza 的完成条件。

## 演进依赖

从实际用户行为选择切片，先确定内容、状态、DOM 和生命周期的 owner，再调整公开契约、调用方与测试：

1. 闭合同步模型、事务、输入、几何与资源生命周期。
2. 验证客户端 Code 和 Standalone 的直接装配，以及共享文件宿主的保存、关闭重开与备份恢复。
3. 验证异步语言结果的版本失效、取消和能力撤回；基础编辑保持独立可用。
4. 在对应平台验证真实输入法与辅助技术，环境缺口只记录到所属 TODO。

VS Code 用于核对公开契约与可观察行为，Ash 独立实现内部机制；对齐流程见 [API 对齐 skill](../../.agents/skills/vscode-api-alignment/SKILL.md)。[边界审计](editor-boundary-audit.md)保留迁移前静态调查，不作为当前实施队列或完成证据。

## Code 与共享文本功能

`editor.all.ts` 提供基础文本命令，`editor.code.all.ts` 注册完整客户端编辑功能，Standalone 从 `editor.main.ts` 进入。Workbench 直接注册 Code Pane 并创建 `CodeEditorWidget`。

补全、悬停、导航、重命名和格式化消费共享语言 registry，并拥有取消、版本失效、结果应用和控件释放。具体语言算法或资源可由 Provider 提供。Diff／MultiDiff 的算法与 Widget 归编辑器，资源、审阅工作流与 Pane 接线归 Workbench。

基础命令、输入和渲染约束见[文本内核](../../src/ash/editor/text-engine.md)与[浏览器实现](../../src/ash/editor/browser/README.md)；不按上游成员数量或文件数量决定下一项工作。

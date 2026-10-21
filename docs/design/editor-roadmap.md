# Stanza 编辑器设计与演进

本文保留编辑器的职责边界和演进依赖。当前未完成动作、平台验收与未排期候选统一见[根 TODO](../../TODO.md#stanza-编辑器--todo)；实现范围见 [Editor](../../src/ash/editor/README.md)、[Academy](../../extensions/academic/README.md) 和 [Reference Manager](../../extensions/reference-manager/README.md)。本文不维护批次记录、测试数量或完成表。

## 目标边界与依赖方向

Code 编辑器由客户端 `src/ash/editor` 内置装配；Academy 富文档编辑器由独立扩展包提供。语言扩展可以向 Code 提供配置、grammar、snippet 和语言 Provider，通用 Code 控件与交互继续由客户端拥有。

| 所有者              | 职责与接入                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Stanza 文本内核     | 唯一文本、坐标、原子事务、版本与历史；机制契约见[文本内核](../../src/ash/editor/text-engine.md)。                      |
| 客户端 Code         | 通用编辑控件、命令、模型分析、语言编辑策略与视图贡献；`editor.code.all.ts` 直接装配，无需扩展激活。                    |
| Academy 扩展        | 富文档 Schema、结构事务、样式、视图、分页、审阅与 codec；独立 Rust 程序经公共 SDK／Host RPC 注册版本绑定的客户端资源。 |
| Workbench／Sessions | Pane、资源引用、dirty、保存、备份、恢复与产品布局；共享服务留在原领域，Sessions 消费注册结果。                         |
| 文献管理与 PDF 扩展 | 跨文档文献库、元数据与 PDF 查看；Academy 拥有文档内的引用、文献表及其编辑事务。                                        |

源码依赖遵守 **Sessions → Workbench → Editor → Platform → Base**。Academy 接入方向为 **独立扩展 → 公共 SDK／Host RPC → 共享扩展宿主与编辑器桥 → 客户端机制**。Rust Provider 与扩展客户端的运行、授权和状态边界由[扩展架构](../editor-extensions.md)维护。

## 演进依赖

从实际用户行为选一个切片，先确定内容、状态、DOM 和生命周期的 owner，再调整对应公开契约、调用方与测试。遵循以下顺序：

1. 先闭合通用模型、事务、输入与资源生命周期；扩展使用已有机制，不建立第二份可写正文或历史。
2. 分别验证客户端 Code 的直接装配与 Academy 的真实包接入，避免把语言 Provider 或扩展激活变成基础代码编辑的前提。
3. 在相应 owner 内完成命令、编辑策略、视图、codec 与保存重开的完整行为；共享功能按真实消费者提取。
4. 新行为稳定后，再扩大到复杂文档、跨窗口、远端与目标应用互通。具体待验收范围以根 TODO 为准。

VS Code 用于核对公开契约与可观察行为，Ash 独立实现内部机制；具体对齐流程见 [API 对齐 skill](../../.agents/skills/vscode-api-alignment/SKILL.md)。[边界审计](editor-boundary-audit.md)是迁移前的静态调查快照，不作为当前实施队列或完成证据。

## Code 与共享文本功能

`editor.all.ts` 提供基础文本命令，`editor.code.all.ts` 注册完整客户端编辑功能，Standalone 从 `editor.main.ts` 进入。Workbench 直接注册 Code Pane 并创建 `CodeEditorWidget`；它不通过可执行扩展提供编辑器实现。

补全、悬停、导航、重命名、格式化等 contrib 消费共享语言 registry，并拥有请求取消、版本失效、结果应用和控件释放。具体语言的算法或资源可由扩展 Provider 提供。Diff／MultiDiff 的算法与 Widget 归编辑器，资源、审阅工作流和 Pane 接线归 Workbench。

基础命令、输入、ViewModel、ViewPart 与渲染链的约束见[文本内核](../../src/ash/editor/text-engine.md)与[浏览器实现](../../src/ash/editor/browser/README.md)；不按上游成员数量或文件数量决定下一项工作。

## Academy 富文档演进

普通文章与 Academic 论文配置复用 Academy 的结构、样式、布局与输出。既有实现和支持限制由[包说明](../../extensions/academic/README.md)维护；下列顺序表示功能依赖，不表示已承诺全部实现。

### 6.1 写作、样式与文档语义

结构、字符／段落样式、列表、对象和查找替换先形成同一文档事务中的编辑闭环，再扩展排版。Schema、命令、投影和 codec 同步演进，保留旧文档的默认外观、位置映射与撤销语义。

### 6.2 可编辑分页的最小闭环

分页以可编辑正文为前提。页面布局、命中、选区和 IME 使用一致的位置映射；页界和几何是派生状态，纸张与用户分页意图才进入持久事务。重排不能制造内容版本或每页内容模型。

关键行为链为：多页正文 → 页界输入与跨页选择 → 删除 → 撤销／重做 → 保存重开。自动化组合事件与物理 IME 的验收分别记录在根 TODO 的实际范围内。

### 6.3 页面结构与复杂排版

分节、运行文字、段落保留规则和表格分页建立在稳定的正文分页之上。脚注、目录、交叉引用、浮动对象与多栏等后续方向须先确定其持久语义、布局依赖、位置映射和互通范围；未排期项见根 TODO 的发展候选。

### 6.4 打印与 PDF

输出从固定文档版本捕获布局，等待字体与图片就绪；切换、关闭或停用时取消并释放资源。页面图像 PDF、可检索文本 PDF 与系统打印分别定义支持范围，不能由一种输出推导另一种已经具备。当前页面图像 PDF 的语义和限额见 [Academy 输出说明](../../extensions/academic/README.md)。

### 6.5 DOCX 导入、导出与往返

DOCX codec 由 Academy 拥有，宿主只传递格式描述、目标资源、字节和取消。导入校验 ZIP／XML 边界及支持的结构，保留源文件；外部修改后的标准 OOXML 优先于旧的内嵌快照。

原生往返、外部 DOCX 解析和目标 Word 打开／编辑／再次保存是不同验证范围。页面一致性与不支持结构的处理须随具体功能定义，目标应用互通见根 TODO。

### 6.6 审阅与 Academic 论文工作流

批注与修订使用同一文档的位置映射和历史。块级修订、逐字作者归属以及 Word 修订的粒度分别定义，不能互相替代。

Academy 管理文档内引用与文献表；独立文献管理扩展管理库、跨文档检索、元数据和生成策略，通过带文档身份与版本的编辑提案进入 Academy 的原子事务。PDF 阅读复用[独立查看器](../../extensions/pdf-viewer/README.md)。文献检索与 Agent 结构化文档写入各按根 TODO 中对应的 owner 推进，不为尚无消费者的能力预建接口。

### 6.7 贡献装配与市场扩展

Academy 的原生 executable、客户端模块和样式按精确包版本与摘要绑定。共享宿主完成发现、授权、注册及资源装载，客户端只获得版本化的有限机制；Schema、codec、同步策略和视图语义由包拥有。构建和独立开发入口见 [Academy 包说明](../../extensions/academic/README.md)与[SDK 开发指南](../../sdk/docs/development.md)。

产品信任来源、执行许可、客户端准入、升级与撤权契约由[扩展架构](../editor-extensions.md)维护。安装不隐含执行授权；可信第一方 Renderer 代码的准入不证明任意第三方客户端具备隔离。包缺失、停用或不兼容时保留文档和未保存内容，不秘密回退内置实现或热切换正在编辑的 Schema。

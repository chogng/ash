# Figma Dev Mode 与 Sites 和 Make 的区别与重叠

Dev Mode、Sites 和 Make 确实有重叠：它们都能帮助把界面设计变成实际界面。区别主要在于用户在哪里编辑、持续维护什么，以及谁完成代码实现。Dev Mode 服务设计与开发交接，Sites 以网页设计和网站维护为中心，Make 以对话、代码和运行预览为中心。不能仅凭“能生成代码”或“能发布网页”区分它们。

功能范围以 2026-10-06 的官方说明为准；本文比较的是 Figma 产品，Ash 的使用建议单独列在后文。

## 各自编辑和交付什么

| 对比 | Dev Mode | Figma Sites | Figma Make |
| --- | --- | --- | --- |
| 所在位置 | Figma Design 文件中的开发查看模式 | 网站创作文件与编辑器 | 由代码实现的原型与应用工作区 |
| 日常操作 | 检查尺寸、样式、组件、素材、设计变更和开发标注 | 编辑网页、断点布局、交互与内容 | 对话生成和修改，选中预览元素调整，也可编辑代码 |
| 持续维护的内容 | 设计文件；应用代码在开发项目中维护 | 网站页面、布局、CMS 内容与发布版本 | 应用代码与运行结果 |
| 交付 | 设计参数、素材、代码片段及开发上下文 | 可发布并持续更新的网站 | 可运行原型或 Web 应用，也可导出代码与发布 |
| 主要用途 | 在已有项目中准确实现设计 | 官网、作品集、活动页和内容网站 | 快速验证想法，生成并迭代交互界面和应用 |

官方依据：[Dev Mode 指南](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode)、[Sites 概览](https://help.figma.com/hc/en-us/articles/35895608840599-Figma-Sites-collection-Figma-Sites-collection-overview)、[Make 常见问题](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs)。

Dev Mode 右侧的 CSS 等代码通常对应选中的图层及其布局、样式。Code Connect 还能展示已关联的组件库代码。开发仍需在项目中完成组件组合和业务行为；这些片段不能视为完整应用。[代码片段说明](https://help.figma.com/hc/en-us/articles/15023202277399-Use-code-snippets-in-Dev-Mode)

## 重叠在哪里

| 重叠 | 为什么看起来相似 | 实际区别 |
| --- | --- | --- |
| Sites 与 Make 都能发布网页 | 做同一张宣传页时，最终效果可以很接近 | Sites 主要围绕页面、响应式布局和内容维护；Make 主要围绕对话修改与应用代码 |
| Sites 与 Make 都能使用 AI 和代码 | Sites 的代码层也能加入自定义功能 | Sites 在网站中加入代码功能；Make 将应用代码作为主要创作内容 |
| Dev Mode 配合编码 Agent，与 Make 都能实现设计 | 两条路径都可以从已有设计得到可运行界面 | 前者把设计信息交给项目中的编码 Agent；后者在 Make 工作区内生成和迭代 |

Sites 的代码层与 AI 能力见 [Sites AI 工具](https://help.figma.com/hc/en-us/articles/31433998164375-Use-AI-tools-in-Figma-Sites)。CMS 则把文章、案例等内容组织为集合、列表和详情页，方便持续更新。[Sites CMS](https://help.figma.com/hc/en-us/articles/35995403973783-Guide-to-Figma-Sites-CMS)

因此，“Sites 做网站、Make 只做原型”划分得太死。Make 也能做网站和 Web 应用；Sites 也有交互和代码功能。选择时更有用的问题是：后续主要要改页面和内容，还是要通过对话和代码改应用行为？

三者也不是必须依次经过的流程。网站可以直接在 Sites 中制作，应用可以直接从 Make 的描述开始，已有软件可以采用 Design 与 Dev Mode 的设计交接方式。

## 转换内容不等于自动同步

Design 的画板可以复制到 Sites，之后仍需检查网页布局。[Design 转到 Sites](https://help.figma.com/hc/en-us/articles/35895740494231-Figma-Sites-collection-Move-designs-from-Figma-Design-to-Figma-Sites)

Make 可以把已有设计作为生成输入；付费用户还可以把运行预览复制为 Design 图层。复制后的 Design 修改不会自动回写到 Make，图层也不会自动关联设计系统。两种编辑方式之间的内容转换，不能当作同一份内容的双向同步。[Make 内容转换说明](https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs)

## Design 的开发检查与交接

Dev Mode 与 Design Mode 使用同一份设计文件。它集中提供设计检查、组件与变量信息、代码关联、素材及开发交接记录；MCP 则让编码 Agent 读取设计上下文。开发或 Agent 在项目中完成实际代码和行为验证。

详细的界面操作、默认代码与 Code Connect 的区别、交接状态、版本比较、MCP、方案权限和 Ash Design 的长期产品建议，统一见 [Figma Design 的 Dev Mode 与开发交接](figma-dev-mode.md)。

## 对 Ash 的使用建议

以下是依据上述差异给出的使用建议，Ash Creator 的目标与当前实现分别见 [Creator 设计方案](../src/ash/sessions/contrib/creator/DESIGN.md)和 [Creator 当前能力](../src/ash/sessions/contrib/creator/README.md)。

| 任务 | 更合适的方式 | 原因 |
| --- | --- | --- |
| 实现 Ash 正式界面 | Design 提供设计，Dev Mode 或 MCP 提供上下文，在 Ash 仓库实现 | 需要接入现有组件、状态、服务、主题、无障碍与测试 |
| 快速试验一套交互 | Make 生成可运行版本并继续修改 | 可以较快验证操作流程和应用行为 |
| 制作 Ash 宣传官网 | Sites 编辑页面、内容并发布 | 主要工作是网页排版、响应式适配和内容维护 |

如果从长期产品设计看 Ash 的入口，值得借鉴的是这些工作方式的区别，而非按输出格式复制菜单：Design 负责设计内容，开发查看能力帮助实现设计；Sites 围绕网站编辑和维护组织工具；Make 围绕代码、对话和运行结果组织工具。它们可以共享素材、组件信息、预览和发布设施，具体功能归属仍由 Ash 的现有设计契约确定。

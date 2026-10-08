# Ash Execution Trace UI 改进方案

当前实现采用共享执行树与检查器，已扩展保存证据驱动的模型/工具消费、子任务返回与汇合导航。最新运行结果见文末检查点；下方保留原调研交接正文。

调研日期：2026-10-08。只读对照基线：chogng/ash@dd086508b8c0eabe5931793302e8f7dc3d7a47b3。

以下调研交接正文记录当时状态；该阶段尚未修改 UI 或操作用户电脑。后续实现和验收单独列在文末。已有 1a6d89fa8、cac4c2f8c 修复来自任务报告；落地时以这些修复后的实际代码为起点，不覆盖 P1 精确定位、导出快照一致性、最后导入文件生效等行为。

## 结论

采用“左侧紧凑执行树 + 右侧选中节点检查器”作为默认布局。复用 Ash 的 ObjectTree、SplitView、ToolBar、InputBox、TabList、IconLabel、ScrollableElement 和只读 CodeEditorWidget。改变信息层级与控件组合，不另造卡片系统、颜色体系、树键盘交互或 UI 框架。

基线是七个等权重按钮、宽度各半的 CSS grid、换行的完整 ID / ISO 时间事件按钮，以及默认原始 JSON pre。主要问题是信息没有主次、定位成本高、长记录挤占阅读空间。第一批不要增加全局运行列表或大关系画布。

另外已核实一处当前具体错位：Trace CSS 用 .ash-inputbox 选搜索框，InputBox 的实际 root 是 .ash-input-box，因此该 flex 尺寸规则不生效。迁移时只适配直接 root，不能继续错误 selector 或穿透共享输入框。基线代码：[AgentTraceEditor](https://github.com/chogng/ash/blob/dd086508b8c0eabe5931793302e8f7dc3d7a47b3/src/ash/workbench/contrib/trace/browser/agentTraceEditor.ts)，[CSS](https://github.com/chogng/ash/blob/dd086508b8c0eabe5931793302e8f7dc3d7a47b3/src/ash/workbench/contrib/trace/browser/agentTraceEditor.css)。

## 已核实的官方参考

1. [Langfuse 当前 Trace 概览](https://langfuse.com/docs/observability/overview)，[官方截图](https://langfuse.com/images/docs/tracing-overview.png)。已在 dot 云浏览器查看真实图片像素。
   - 借鉴：紧凑可折叠层级、明确选中状态、独立检查器标题与输入/输出分区、搜索靠近结构导航。
   - 不搬入成本、评分、总耗时或彩色分类标签，除非 Ash 当前记录能支撑。
   - [官方改版说明](https://langfuse.com/changelog/2025-03-19-new-trace-view) 也确认层级/时间视图与搜索的职责。
2. [Phoenix 官方 Agent Spec 示例](https://arize.com/blog/add-observability-to-your-open-agent-spec-agents-with-arize-phoenix/)，[2026-02 官方详情截图](https://arize.com/wp-content/uploads/2026/02/phoenix-trace-detail-view.jpg)。已在 dot 云浏览器查看真实图片像素。
   - 借鉴：窄执行树与宽检查器、模型/工具图标区分、节点标题、详情 tabs、输入按消息角色分段。
   - 不搬入 Playground、注释或数据集操作；只呈现既有记录的身份与关系。
3. [LangSmith 官方 LangGraph Trace 文档](https://docs.langchain.com/langsmith/trace-with-langgraph)。文档确认执行详情与会话轨迹分工，可辅助“先读摘要，再查原始记录”的设计。链接的两个公开示例本次均显示 Trace not found，不能宣称核实了其详情截图。

## 默认画面

- 顶部一条轻量标题行：会话标题 / Execution trace，安静显示 Live、Paused 或 Imported；右侧 Refresh 和 More。More 收纳 Import、Export、Help。正常状态与记录缺失提示分开，不占两段长说明。
- 左侧初始约 35%，右侧约 65%；SplitView 可拖动分隔。尺寸是布局策略，不是新 token。边界使用已有 border，通过 styles.separatorBorder 传入。
- 左侧“执行结构”标题和短计数；下方 InputBox 搜索与 Errors only 切换。不要让搜索和一串全局按钮盖过内容。
- 树结构为 Thread → Turn → 真实事件。Thread 用 title，Turn 用当前会话内展示序号；完整 ID 留在 hover 与概览。事件短名称展示模型、工具、执行决定等已有语义；未知类型仍可查。
- 事件主行只有“图标 + 短名称 + 简短状态”，不重复 UUID 和 ISO 时间。精确记录时间、sequence、eventId 留在检查器。长名称用 IconLabel ellipsis 与完整 hover。
- 默认展开选中路径，其余旧 Turn 折叠。搜索保留祖先上下文。展开、左右方向键、选择、焦点与可见性由 Tree 基座负责。
- 右侧稳定节点标题、类型 / 状态、所属 Thread / Turn；下方 TabList：概览、输入、输出、关系、原始记录。失败首先在概览中显示错误原因与已有上下文。
- 概览用短定义列表呈现已知字段。Thread / Turn 显示自身可验证摘要；事件显示类型、身份、时间、状态。Raw tab 只作兜底。
- 输入/输出按消息角色或工具参数/结果分区。有真实结构就使用结构，没有明确 schema 时保留只读原文。全正文不堆进概览。
- 关系 tab 是“入向 / 出向已记录关系”的紧凑 List，点击跳转目标事件；采用既有图读取，显示 graph warnings / 缺失证据。不增加常驻第三列画布。

## 基座与 owner 映射

| UI 职责            | 现有实现 / API                                                                                              | Owner 与约束                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编辑器生命周期     | workbench/contrib/trace/browser/agentTraceEditor.ts，EditorPane                                             | Trace 保留输入 revision、abort、隐藏/显示、订阅释放                                                                                                |
| 两列尺寸与拖动     | base/browser/ui/splitview/splitview.ts，new SplitView(host, 'horizontal', options)，ISplitViewView          | SplitView / Sash 拥有分隔与交互；Trace 提供 pane root、约束和 layout                                                                               |
| 执行树             | base/browser/ui/tree/objectTree.ts，ObjectTree                                                              | modelOptions.identityProvider.getId 用稳定身份；scrolling: 'managed' + 固定 getHeight 启用现有虚拟化；Tree 自绘选中、focus、twistie、indent guides |
| 精确定位与关系跳转 | Tree.expandTo / setSelection / setFocus / domFocus                                                          | setFocus 经 List.syncRows 触发 reveal；不能查询虚拟化 DOM 定位，P1 locator 面向模型身份                                                            |
| 过滤               | ObjectTreeModel.filter / refilter，Tree find API                                                            | 保留祖先；预计算标签/搜索文本，避免每次输入对全历史 JSON.stringify                                                                                 |
| 事件短名称         | base/browser/ui/iconlabel/iconlabel.ts，IconLabel                                                           | IconLabel 拥有图标、截断与 hover；Trace 提供 icon、label、description、title                                                                       |
| 操作               | base/browser/ui/toolbar/toolbar.ts，ToolBar.setActions(primary, secondary, trailing)；现有 WorkbenchToolBar | Toolbar 拥有 More 与 roving focus；Button / ActionBar 拥有状态，不在 Trace CSS 穿透重写 hover / checked                                            |
| 搜索               | base/browser/ui/inputbox/inputbox.ts，InputBox，presentation: 'compact'                                     | InputBox 拥有焦点/disabled/皮肤；Trace 只设 root 外部尺寸                                                                                          |
| 检查器 tabs        | base/browser/ui/tablist/tabList.ts，TabList.setTabs(items, selectedId)，presentation: 'flush'               | TabList 拥有键盘/选中；Trace 拥有 tabpanel 生命周期与 aria-controls / labelledby                                                                   |
| 关系列表           | base/browser/ui/list/listWidget.ts，List，稳定 getId                                                        | List 拥有选择/键盘/滚动；Trace 提供方向、关系名称、目标、是否可跳转                                                                                |
| 正文滚动           | base/browser/ui/scrollbar/scrollableElement.ts，ScrollableElement                                           | 复用主题滚动条 / wheel / focus reveal，不造另一套                                                                                                  |
| JSON / 长正文      | editor/browser/widget/codeEditor/codeEditorWidget.ts，IModelService                                         | 参考 contrib/output/browser/outputView.ts 的只读嵌入：readOnly，关闭 minimap / suggestions / inline completions；按需创建并释放 model / editor     |
| Loading            | base/browser/ui/progressbar/progressbar.ts + role=status                                                    | 没有总量就用 indeterminate，不伪造百分比                                                                                                           |
| 数量               | base/browser/ui/countBadge/countBadge.ts                                                                    | 只显示真实计数，不用数量徽标装饰类型或伪装状态                                                                                                     |

注意：旧 skills 中的 SplitView 构造示例已经过时；本次核实当前签名为 new SplitView(container, 'horizontal', options)。按实际源代码实现。

## 数据边界

- AgentTrace 当前包含 durable event、diagnostic event、payload ref、可选 graph。字段只有明确记录时才展示。
- modelInvocationRecorded.record.startedAtUnixMs / completedAtUnixMs 同时有效且结束不早于开始，才显示模型调用时长。usage.inputTokens / outputTokens 等存在才显示对应 token 数。
- recordedAt 是记录时间。相邻事件时间差不是工具耗时、排队耗时或模型延迟；全局时间排序不等于跨 Thread 因果顺序。
- 本批不承诺整份会话 token 总和、成本、critical path、并发等待或工具耗时。聚合先明确无重复计数的来源与范围。
- 模型 attempt / 工具调用只使用已有 attempt / execution / tool / graph 身份连接；缺失身份不靠文本相似度或时间邻近配对。
- 输入区分 coreRequest / materializedRequest，输出区分 modelResponse / partialOutput。取消前 partial output 不标成完整 response。
- 请求正文缺失、omitted、diagnostic disabled、storage unavailable 提供不同短说明；缺失不等于空输入。
- 关系只显示 graph 已知 edges；unknown 类型保留原名。跨 Thread 连线需要真实证据，warnings 可见。
- Timeline 仅后续可选：明确起止的记录才画区间，无起止事件只能画时间点。数据不足时维持事件序列，不能画假 waterfall。本批默认不做。

## 密度、状态与长历史

- 紧凑树行保持一行，采用 Tree 现有 presentation 与固定 row height；不要用 Trace selector 重写内部 padding / line-height。24px 或 Tree 默认尺寸以实际截图核实，不每事件造卡片。
- 内容沿用 editor.background；元数据用 description.foreground / muted.foreground；错误图标和短说明用 error.foreground，避免整行错误色破坏选中前景对比度。
- 标题/body/metadata 使用既有 heading3 / body1 / body2 / label tokens；间距使用 size40 / size80 / size120 / size160，stroke 与 monospace 沿用既有 token。共享控件内部保持 owner 边界。
- Empty：一句“打开已保存会话或导入 Trace”，现有 Import 按钮即可。
- Loading：显示实际阶段；首次读取进度条，后续刷新保留旧内容与选择，不整页闪空。
- 无命中：树内显示空过滤结果，保留条件并可清除，不清掉原记录。
- 长正文：按真实消息角色/工具结果边界折叠区段，只在选择 tab / 区段后读取 evidence；不为每条事件创建 editor。
- 活跃刷新不抢焦点、不改手动折叠、不把已离开底部的用户强拉到最新事件，保留选中节点与 tab。
- Accessible View 内容从模型的过滤投影生成，不能继续遍历 mounted DOM：虚拟化后屏幕外事件不在 DOM。row cache eviction 时通过 onDidRemoveRow 释放行级 IconLabel / hover 等资源。
- 变窄时在 layout 按约束切换树/详情显隐或堆叠，使用 SplitView 约束；不延续 container query 与不可拖动 50/50 grid。

## 实现顺序与验收

- [ ] 在现有 Trace 分支做纯投影层：稳定身份、短 label、字段摘要、正文分类、错误/缺失状态；保留 unknown 字段和完整导出。
- [x] 手写 button 树迁移到 ObjectTree，managed 固定行虚拟化；P1 location / relation jump 面向模型身份，不依赖 rows DOM 是否挂载。
- [x] CSS grid 迁移到 SplitView；左侧搜索/树，右侧标题/TabList/按需正文。
- [x] 七个等权重按钮收敛成 Refresh / More 和局部错误过滤；Request / Response 和 Relationships 移入相应详情 tab。
- [x] 概览默认，raw JSON 单独 tab；saved evidence / imported payload / 缺失提示在新结构中可回查。
- [ ] 相关单测、normal Desktop / Web 构建、stylelint / hygiene。明确 passed、failed、never run，focused checks 不当作全通过。
- [ ] Web / Electron 实际截图：light、dark、HC；宽/窄；多 Thread/Turn、多层关系、失败、disabled evidence、omitted payload、超长 ID/正文、空结果。
- [ ] 键盘路径：搜索 → 树上下/左右 → 选择 → tabs → 正文 → 关系跳转 → 精确目标展开并 reveal。
- [ ] P1 回归：durable / diagnostic sequence 冲突、未挂载虚拟行定位、filter 清除、连续选择/正文读取、导出期间增量、连续导入、hidden/show、input 切换、dispose。
- [ ] 长历史实测：事件数、首次展示/搜索时间、mounted row 数、listener / model 清理。不能把“已虚拟化”直接当性能验收。
- [x] 真实持久会话独立验收；正式 Web / Electron initialize、历史定位、实时增量与关闭重开通过。合成 fixture 截图/录像不能替代后端端到端通过。

## 交接范围

本方案可添加到现有 trace-todo.md 的 UI 章节。实现集中于 Trace contribution 及测试。不恢复新 Node backend，不改 Rust 协议迎合截图；不修改其它任务工作树，不 push / merge / deploy。

若基座真缺少多个消费者所需能力，先明确契约与 owner，再独立最小扩展。不能为了 Trace 单处颜色或 spacing 增加“通用”转发层。

## 落地状态（2026-10-08）

以上方案正文保留云端调研交接时的范围；本地实现从 `cac4c2f8c` 开始，当前已经迁移 ObjectTree、SplitView、TabList、ToolBar、关系 List、IconLabel 与按需只读正文编辑器。原始捕获和订阅仍归编辑器，派生模型只保留导航身份与搜索缓存。P1 整体验收仍未完成，合成 UI 验证不作为真实持久会话验收。

旧界面新增两条红测均失败：2,000 条记录全部挂载、详情没有五个页签。迁移后六个 Trace 测试文件共 57 项通过，其中编辑器 27 项：覆盖定位/订阅/导出/导入、虚拟视口、诊断与持久序号冲突的关系跳转、按需只读模型创建与释放，以及正文迟到响应不会覆盖新选择。定向 CSS 检查为 0 errors / 0 design suggestions，Renderer、浏览器集成与 smoke 类型检查通过，7 个修改的 TypeScript 文件格式检查通过。仓库 hygiene 通过：263 个 CSS 文件为 0 errors / 0 design suggestions，设计 token 一致性 2 项通过。

第一次新版浏览器集成的两个场景未通过；fixture 未装载共享控件样式且使用了未注册的图标。修正后复跑进一步暴露详情宿主零高度，现已按共享控件契约修复；两个 headless 场景、最新正常 Desktop/Web 前端构建、四主题宽窄截图与 20,000 事件实测均通过。Electron 与真实 App Server 场景仍待验收；不能以合成 fixture 或改造前图片覆盖这些验收。

Sherpa 官方归档正常重试的大小与 SHA-256 已通过锁定校验；完整后端准备尚未完成。原失败响应的临时文件已由下载器清理，原实测 hash 未保留，不能推断先前失败原因。

导出身份复核又补充一条失败回归：相同 eventKey 来自其它 Thread/Turn，或把持久记录误作模型诊断时，旧范围过滤会错误收入图节点。修复同时核对来源、Thread 与 Turn；关系定位建立键索引，避免每个图节点反复扫描全历史。该新增回归先失败、修复后通过；关闭仍在分页读取的输入时，进度条也立即隐藏。

### 更新到最新 main 后的运行复验

本树已 fetch 并无冲突 rebase 到 `77fcedc89`。UI 与文档分别提交，P1 与导入导出提交保留；没有 push。

headless Chromium 复跑先暴露详情零高度：TabList 会填满宿主，直接挂到检查器会挤掉详情；滚动控件的额外 block 宿主也未给绝对定位视口分配高度。现在给 TabList 独立的一行，滚动根直接占内容区，不改共享控件内部样式。测试中的错误 editor CSS 名称改为实际 Saved execution body region，并断言宽窄面板可见及模型/编辑器释放。

修复后两个集成场景通过：light、dark、两种 HC 的宽/窄布局、树/页签/分栏键盘、错误与选中前景、空筛选保留详情、Accessible View 屏幕外事件，以及按需原始正文。保存 8 张实际 headless 截图；真实 Electron 与 App Server 场景仍另行验收。

20,000 事件本次单样本：导入至 Imported 状态约 315 ms，搜索并选择目标约 65 ms，初次 mounted rows 为 29；正文打开时 1 个模型/编辑器，关闭后均为 0。计时包含 Playwright 文件传输/交互，服务初始化已完成，同时存在两个后端编译任务；没有同机旧版相同数据集的时间基线，不据此宣称整体性能提升。

修复后的正常 Desktop/Web 前端构建与 smoke 编译已通过；最终 57 项 Trace 单测、hygiene、格式检查均已通过。后端正常准备先因默认 Python 无 tomllib 停止，再由 PYTHON 指向本机 Python 3.12；后一次 Cargo 因终端服务器断连退出，现通过独立进程重跑正常命令并记录退出码，CARGO_BUILD_JOBS=2。所有 Cargo/runtime/protocol/包使用本树，后续正常准备及真实 initialize 已通过，见以下阶段检查点；没有复用其它树产物。

### 真实 Web 与最新 main 阶段检查点

后端 Rust 编译完成后，LiveKit 官方归档 TLS EOF 重试通过锁定 SHA-256；Desktop/Web 两个正常准备均 exit 0 并发布本树包。真实 Web 首轮 2 项通过、4 项失败；Sessions 缺少已有 IModelService，现由窗口注册服务，容器负责关闭释放，不扩展共享 API。概览断言验证翻译语义，Raw 保留原枚举断言。修复后先重跑四项，中文及循环决策通过；剩余两个 has 定位器按 Playwright 相对作用域修正后通过，保留 Thread 层级和所有行为断言。

真实持久场景完成实际 App Server initialize、历史 shell Turns、Session 入口精确定位、真实新 Turn 的实时增量、子 Thread 层级及关闭后重开定位最新 Turn。该阶段六项 Web 分别通过；随后 latest main 的整组复跑结果见下节。新版 Electron/前台仍按父任务队列，合成 fixture 与真实持久验收分开记录。

本树无冲突 rebase 到 `c6d6db1ef`，保留 P1、导入导出、UI 与运行修复的独立提交。最新基线上正常 Desktop/Web 前端构建、smoke 编译、57 项 / 6 文件单测、hygiene、8 文件格式均 exit 0；两种后端包 sourceDigest、所有文件哈希与 protocol major 7/schemaHash 只读复验通过，未改变包输入或复用其它树产物。详细退出码和日志见 [Trace 路线检查点](trace-todo.md#后端与真实-web-阶段检查点c6d6db1ef)。

阶段交接时 Trace 自有编译、监督器与服务均已退出；其它 Cargo 属于 ash-external-conflict 树，未干预。不 push。Sessions skill 所列 valid-layers-check 在当前脚本中不存在，新增导入按已有层级核对，未宣称该命令通过。

### 最新 main 整组 Web 与截图审阅

已无冲突更新到 `bf5bcdfc6`，通过正常 full Web 入口一次运行 6 项 smoke / 0 failed；5 项为导入/离线证据 UI 验证，1 项为真实持久 App Server 场景，包含 initialize、历史 Turn 定位、真实新 Turn 增量、子 Thread 和关闭重开。随后六文件 57 项单测通过。正常 Web 构建、smoke 编译、最新 Web 后端准备与 sourceDigest/完整包哈希/协议核验均通过，未复用其它树产物；前次 c6d6db1ef 的 Desktop 构建/包证明保留为历史，最新 Desktop 包刷新与前台/Electron仍等队列。

代表截图已实际查看并保存 Library：`libfile_97f4600bf6e081919e47a6ccb37f868d`（深色宽屏），`libfile_a93c0e82ab4881918944e25a8abf8c14`（浅色窄屏）。来源是 headless Chromium 的共享 Trace 组件及离线 fixture，不作为完整产品或 Electron 截图。8 张四主题宽窄和 20,000 事件的前阶段测量边界保持不变。

本轮记录见 [整组退出码](.build/trace-validation/web-six-current-main-state.json)、[Web 六场景](.build/trace-validation/current-main-web-six.log)、[57 项单测](.build/trace-validation/current-main-unit.log)、[Library 截图身份](.build/trace-validation/ui-headless-library-images.json)。不 push 未完成双端验收的状态。

本次轻量复验：hygiene 通过（263 CSS 文件，0 errors / 0 design suggestions；设计 token 2 项），8 个修改 TypeScript 文件格式通过。当前无 Cargo、Trace 监督器或 App Server 进程；见 [轻量记录](.build/trace-validation/current-main-light-checks.json) 与 [进程检查](.build/trace-validation/current-main-processes.json)。

### Desktop 与 Electron 阶段检查点

基线更新到 `e05e17e93` 后，正常 Desktop 后端准备、完整前端构建和 smoke 编译通过，CARGO_BUILD_JOBS=1；正式 Electron 首轮 2 项通过、4 项因测试驱动的菜单 owner 不匹配失败。复用现有 Menus helper 修复后，4 项 Electron 和相同 4 项正式 Web 复跑通过。六个 Electron 场景分别通过，包含真实 initialize、持久 shell Turns、当前 Turn 定位、实时增量、fork Thread 和关闭重开。菜单 popup、导出路径与重启确认的进程内测试 hook 不算实际 OS 菜单/对话框验收；五个导入场景的合成模型证据不算真实 provider loop 验收。

Desktop 与 Web 最新 runtime 包源码摘要、完整文件哈希和协议均通过；Electron 确实与 AgentHost 独立应用并行，每个任务 workers=1、独立产物目录，无本树构建与验收同时写产物。修复只改 Trace smoke 驱动及重启后的 application 句柄，保留菜单状态、动作结果、完整导出和中文断言，没有追加生产图/Core/协议变更。详情与保留的首轮失败证据见 [路线检查点](trace-todo.md#desktop-与真实-electron-复验e05e17e93)。

四主题宽窄 headless 及 20,000 事件测量沿用已有验证边界，不能写成 Electron 全主题截图已通过；P2 完整模型/工具/子任务链、retry/审批代表记录、分享脱敏和旧版同机时间基线继续保留。

### 受控模型与真实执行闭环检查点

当前界面按已保存 Thread 前缀锚定模型 attempt 的诊断阶段；子 Thread 保留自身 sequence，共享 ObjectTree 显示轻量层级线。请求前缀不提供完成阶段与并发持久事件的精确交错顺序。关系列表合并既有后端 graph 与按明确身份派生的工具结果、子任务返回、join 和加载后 Core input 消费关系；重复标识、错父 Thread、错 digest、跨 Turn 或缺少证据时不连线。没有新增 Core/Rust/protocol 契约。原始捕获、正文与导出继续归共享编辑器。

已修复真实长请求的 Find 装配、正文切换继承旧搜索/滚动位置，以及切换事件后的迟到正文关系缓存。只读正文仍按需创建；迟到正文不能替换当前阅读内容，关闭释放 model/editor。

当前源码正常 full Web 与 Desktop 准备通过，66 项 / 8 文件定向单测通过。Web 与 Electron 各自一次完成 8/8 场景；每端包含六项既有回归与两项本地模型 fixture 经真实 App Server 的调用链。父任务三次模型调用、真实 shell、两个并行子任务、返回/汇合、下一次模型输入的工具结果、关系跳转、重开、15 份正文完整导出和离线复查通过。另有错误与取消并行场景，保存终止状态并在重开后复查。fixture 不使用付费账户或私密上下文；导入 fixture 和真实执行链分开报告。

最新 headless 2/2 覆盖四主题宽窄及 20,000 事件，挂载 29 行；本轮导入约 333 ms、筛选约 79 ms，关闭后 model/editor 为 0。已查看深色宽屏和浅色窄屏两张代表图。这些图片来自共享组件与离线 fixture；Electron 四主题截图、旧版同机时间基线、retry/审批 deadline、部分输出的流式取消、费用与分享脱敏仍保留验收项。当前两种包源码摘要、文件哈希和协议校验通过；未复用其它树产物，不 push。

证据：[66 项单测](.build/trace-validation/flow-current-unit.log)、[Web 八场景](.build/trace-validation/flow-current-web-eight.log)、[Electron 八场景](.build/trace-validation/flow-desktop-electron-eight.log)、[退出记录](.build/trace-validation/flow-desktop-state.json)、[性能测量](.build/trace-validation/flow-current-headless-evidence/long-history-measurements.json)、[截图附件](.build/trace-validation/flow-current-headless-evidence/attachments.json)。完整能力边界见 [Trace roadmap](trace-todo.md#当前受控模型与真实执行闭环检查点)。

### 独立审查后的正文恢复修复

Input 正文在隐藏 Trace 时尚未完成的读取，现会在恢复同一选择后重读。只失效未完成读取的渲染状态；已加载正文及阅读位置保留，迟到旧读取不能清理新读取。两个新增回归分别覆盖旧结果在恢复前/后到达，先红后绿。分支无冲突跟进已发布 SCM / Search `main` `5db5dfcec`；当前基线正常 Web / Desktop 准备、68 项 / 8 文件单测、headless 2/2、renderer 类型、hygiene 与两种新协议包契约均通过；Web 与 Electron 各自一次 8/8。源码执行检查点 `f2a54bc57`；退出结果见 [验证状态](.build/trace-validation/published-main-visibility-state.json)。

代表性截图来自本地 HTTP 模型 fixture 经真实 App Server 的执行场景，并带明确的 fixture 标签；标签属于证据产物的测试注释，不属于产品界面。截图不替代关系跳转、状态、导出和生命周期断言。重开范围为编辑器/窗口和离线导入，App Server 停止重启后的磁盘恢复仍未验收。重试、费用与分享脱敏继续保留。

[深色代表图](.build/trace-validation/published-main-visibility-web-results/areas-sessions-trace-flow--6289c-turns-and-offline-reopening-browser-app-server/ash-dark-wide.png) 与 [浅色 Trace 区域图](.build/trace-validation/published-main-visibility-web-results/areas-sessions-trace-flow--6289c-turns-and-offline-reopening-browser-app-server/ash-light-narrow.png) 已查看并更新原 Library 图片身份；完整补丁 v4 保持不变，最小正文修复 delta 单独供复审，见 [交付回执](.build/trace-handoff/reviewed/trace-review-library.json)。这些是 Browser 实际模型 fixture 场景，未扩大为全 Electron 主题或整窗响应式验收。

### Storage 基线交付复核

已审批候选在 `e4d668f37` 基线上保持相同 Trace 源码和测试。正常 Desktop 准备、83 项 / 9 文件 Trace 与 Storage 单测、本树两种包契约，以及真实 Electron 八场景均通过，见 [集成退出记录](.build/trace-validation/storage-main-loop-state.json)。源码检查点 `657016924`；此前 Web 8/8 明确保留 `5db5dfcec` 基线。局部模型 fixture 与未验收边界未扩大，Library v4 + 独立 delta 和两图版本 1 未重复上传。

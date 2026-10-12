# Sessions 右侧编辑器与 Details 对齐状态

范围是 Code 会话右侧的编辑器标签栏、Files / Changes 编辑器、Details 视图和桌面布局控制器。主对话输入、Sessions 列表、Library / Creator 内容实现不在本次范围内。

只读参照为 `../vscode/src/vs/sessions`，提交 `959031245ebb1fe077e0d512e1397c0ae82006e4`。清单包含生产 `.ts` / `.css`，排除测试、文档和图片。上游存在但未接入本地调用链的文件只记录为待调查，不作为实现队列。

## 文件集合

下列路径均相对 `src/ash/sessions/` 或上游 Sessions 根目录。

| 范围                                  | 双方同路径 | 仅 Ash | 仅 VS Code |
| ------------------------------------- | ---------: | -----: | ---------: |
| `contrib/files/`                      |          3 |      0 |          0 |
| `contrib/editor/`                     |          6 |      0 |          5 |
| `contrib/changes/`                    |         27 |      0 |          7 |
| `contrib/layout/`                     |          5 |      1 |          9 |
| 下列限定的 Part、挂载器和布局服务契约 |          0 |      7 |          8 |
| 合计                                  |         41 |      8 |         29 |

用户选择保留类似 Workbench 的按组件分目录结构，`parts/editor/` 与 `parts/auxiliarybar/` 不平铺。以下原始文件集合差异用于定位职责；有明确职责对应的异路径文件不作为缺陷计数。同路径也不代表公开契约或行为已全部对齐。

### 双方同路径

```text
contrib/files/browser/files.contribution.ts
contrib/files/browser/filesView.ts
contrib/files/browser/media/filesView.css
contrib/editor/browser/addTabActions.ts
contrib/editor/browser/editor.contribution.ts
contrib/editor/browser/emptyFileEditor.contribution.ts
contrib/editor/browser/emptyFileEditor.ts
contrib/editor/browser/emptyFileEditorInput.ts
contrib/editor/browser/media/emptyFileEditor.css
contrib/changes/browser/changes.contribution.ts
contrib/changes/browser/changesView.ts
contrib/changes/browser/media/changesView.css
contrib/changes/browser/media/sessionChangesEditor.css
contrib/changes/browser/sessionChangesEditor.ts
contrib/changes/browser/sessionChangesEditorInput.ts
contrib/changes/browser/sessionsChangesAccessibilityHelp.ts
contrib/changes/common/changes.ts
contrib/changes/browser/changesSummaryWidget.ts
contrib/changes/browser/checksActions.ts
contrib/changes/browser/checksViewModel.ts
contrib/changes/browser/checksWidget.ts
contrib/changes/browser/createPullRequestContextView.ts
contrib/changes/browser/createPullRequestWidget.ts
contrib/changes/browser/sessionSyncChanges.ts
contrib/changes/browser/media/changesActions.css
contrib/changes/browser/media/changesSummaryWidget.css
contrib/changes/browser/media/checksWidget.css
contrib/changes/browser/media/createPullRequest.css
contrib/changes/common/pullRequestCreation.ts
contrib/changes/browser/changesViewService.ts
contrib/changes/common/changesViewService.ts
contrib/changes/browser/changesViewRenderer.ts
contrib/changes/browser/changesViewActions.ts
contrib/changes/browser/media/changesViewActions.css
contrib/changes/browser/createPullRequestChatRequest.ts
contrib/changes/common/createPullRequestPreferences.ts
contrib/layout/browser/baseSessionLayoutController.ts
contrib/layout/browser/desktop/desktopDetailPanelCoordinator.ts
contrib/layout/browser/desktop/desktopDockedTabsCoordinator.ts
contrib/layout/browser/desktopLayoutController.ts
contrib/layout/browser/sessions.layout.contribution.ts
```

### 异路径对应与本地归属

Part 目录沿用按组件分组，不迁移或删除现有文件。其余挂载器与产品 entry 服务维持已有职责。已有产品契约见 `src/ash/sessions/README.md` 和 `LAYOUT.md`。

| 当前文件                                                | 对应职责或保留方式                                                              | 直接生产调用方                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `browser/parts/editor/editorPart.ts`                    | 对应上游 `browser/parts/editorPart.ts`；保留现有路径、类名和 Ash 产品页面组     | `browser/workbench.ts` 创建；`contrib/layout/browser/sessionsLayoutService.ts` 读取页面组 |
| `browser/parts/editor/editorPartSizing.ts`              | 对应上游 `browser/parts/editorPartSizing.ts`；保留现有路径及已验证的 Ash 尺寸值 | Sessions EditorPart、`browser/layoutPolicy.ts`、`browser/desktopWorkbench.ts`             |
| `browser/parts/auxiliarybar/auxiliaryBarPart.ts`        | 对应上游 `browser/parts/auxiliaryBarPart.ts`；保留现有路径，承载视图容器        | `browser/workbench.ts` 创建                                                               |
| `browser/parts/auxiliarybar/media/auxiliaryBarPart.css` | 对应上游 `browser/parts/media/auxiliaryBarPart.css`；继续与组件同目录           | Sessions AuxiliaryBarPart                                                                 |
| `browser/dockedAuxiliaryBarController.ts`               | 保留 Ash 挂载器职责；布局尺寸和可见性仍由桌面布局提供                           | `browser/desktopWorkbench.ts`                                                             |
| `browser/media/dockedAuxiliaryBar.css`                  | 保留挂载器样式职责                                                              | `browser/dockedAuxiliaryBarController.ts`                                                 |
| `contrib/layout/browser/sessionsLayoutService.ts`       | 保留产品 entry 切换、导航队列和页面组保留职责                                   | `contrib/layout/browser/sessions.layout.contribution.ts` 注册；各产品 entry 消费服务契约  |
| `services/layout/common/sessionsLayoutService.ts`       | 保留上述产品 entry 服务契约                                                     | layout contribution、Chat / Cowork / Library / Creator 等贡献                             |

前四项已有真实职责对应，文件集合中的差异源于目录组织。`desktopEditorPart.ts`、`desktopAuxiliaryBarPart.ts` 和 `editorParts.ts` 是否需要独立 owner，仍由本地调用链、运行环境及生命周期决定，不为补齐名称新增外壳。

### 上游同路径在本地不存在

前述四个 Part 路径已有异路径对应；其余项目保持待调查。

```text
browser/parts/auxiliaryBarPart.ts
browser/parts/desktopAuxiliaryBarPart.ts
browser/parts/desktopEditorPart.ts
browser/parts/editorPart.ts
browser/parts/editorPartSizing.ts
browser/parts/editorParts.ts
browser/parts/media/auxiliaryBarPart.css
browser/parts/media/editorPart.css
contrib/editor/browser/diffEditor.sessions.contribution.ts
contrib/editor/browser/diffEditorOptionsService.ts
contrib/editor/browser/media/editorBreadcrumbs.css
contrib/editor/browser/media/editorHeader.css
contrib/editor/common/diffEditorOptionsService.ts
contrib/changes/browser/changesActions.ts
contrib/changes/browser/changesEditorLabels.ts
contrib/changes/browser/changesMultiDiffSourceResolver.ts
contrib/changes/browser/changesetReviewActions.ts
contrib/changes/browser/media/sessionChangesEditorInput.css
contrib/changes/browser/sessionChangesService.ts
contrib/changes/common/sessionChangesService.ts
contrib/layout/browser/chatLayoutOwnerKeys.ts
contrib/layout/browser/desktop/desktopDraftSessionStrategy.ts
contrib/layout/browser/desktop/desktopExistingSessionStrategy.ts
contrib/layout/browser/desktop/desktopLayoutStrategy.ts
contrib/layout/browser/desktop/desktopOwnerCompositionStore.ts
contrib/layout/browser/desktop/desktopSharedHelpers.ts
contrib/layout/browser/desktop/desktopVisibilityProfileStore.ts
contrib/layout/browser/mobileSessionLayoutController.ts
contrib/layout/common/sessionEditorWorkingSet.ts
```

## 职责与调用链

| 用户入口                          | 当前调用链与唯一 owner                                                                                                                                                                           | 对齐问题                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 点击 Add tab 中的 Files / Changes | `SessionsLayoutService` 创建并持有 `EditorTitleMenuBridgeContribution`；`registerAddTabActions` 注册 Files / Changes 命令和菜单；回调通过现有队列调用布局控制器及 `DesktopDockedTabsCoordinator` | 已迁回 `addTabActions.ts` 和 `editor.contribution.ts`；布局状态仍只有原 owner           |
| 切换文件或比较标签                | `SessionsLayoutService` 观察活动编辑器，`DesktopDetailPanelCoordinator` 选择 Files / Changes 容器                                                                                                | 已有独立协调器，不能再创建平行的活动编辑器或 Details 状态                               |
| 在 Files 树中打开文件             | Sessions Files contribution → `SessionsExplorerView` → Workbench `ExplorerView` → `IEditorService`                                                                                               | Files 目录路径集合一致；此结论不代表整个 Explorer API 已审计                            |
| 切换会话                          | `ISessionsService` 选择 → `BaseLayoutController` 恢复工作集 → 桌面控制器协调标签及 Details                                                                                                       | 页面组与会话文档组必须继续分离；当前 Ash 替换会话策略不同于上游 transient / pinned 策略 |
| 拖动 Details 分隔线、隐藏编辑器   | `DesktopWorkbenchLayout` 提供尺寸及可见性 → `DockedAuxiliaryBarController` 挂载 Details、更新 sash 和编辑器 inset                                                                                | 几何继续由唯一 owner 提供；Part 按组件分目录保留，不新增桌面 Part 外壳                  |
| Changes 展示和提交                | `SessionChangesEditor` / `ChangesViewPane` → 共享 Chat 服务的 Turn ledger                                                                                                                        | 保留 Ash 后端账本语义；PR checks、同步和创建 PR 等上游文件须另行验证本地入口及 owner    |

已迁移切片：点击 Add tab → 编辑器 contribution 与命令注册 → 既有布局操作队列、标签协调器及 `IEditorService` → 打开对应标签并显示正确 Details。原控制器退出命令、菜单和 context key 注册，继续拥有布局操作及会话恢复。窗口布局服务创建和释放两个 owner。

`registerAddTabActions` 的回调契约保留 Ash 既有命令 ID 和窗口生命周期，不伪造上游 `Action2` 类或宣称公开 API 已完全一致；后续 API 对齐须独立核对使用方和生命周期。

## Files 与 Changes 文件职责核对

路径相对 `contrib/`。目录保持按组件分组。

| 文件                                                  | 唯一职责与本地调用方                                                                                | 处理结果                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `files/browser/files.contribution.ts`                 | 装配 Sessions 视图目录，注册聚焦、折叠及远程下载动作；main entry 加载，文件下载使用共享 FileService | 保留；容器标识沿用已有公开入口，与上游归属一致                                 |
| `files/browser/filesView.ts`                          | 适配共享 Explorer 视图的标题动作、空文件夹提示；Files contribution 创建视图                         | 保留；文件树和资源打开继续由 Workbench Explorer / EditorService 负责           |
| `files/browser/media/filesView.css`                   | Files 本地 DOM 和空视图布局、token 样式                                                             | 保留；不增加全局布局或复制上游样式                                             |
| `changes/common/changes.ts`                           | Changes 容器和视图标识；注册入口、Details 协调器及无障碍提供者消费                                  | 已从注册入口移入，不含 DOM 或注册副作用；现有 ID 值不变                        |
| `changes/browser/changes.contribution.ts`             | 装配视图容器、Changes 编辑器及无障碍注册；main entry 加载                                           | 已移出共享标识和无障碍内容逻辑                                                 |
| `changes/browser/changesView.ts`                      | 当前可见列表的行、选择、焦点和异步请求生命周期；通过 ChatService 读取不可变 Turn 账本并执行预览操作 | 保留视图状态归属；隐藏时停止刷新、使迟到请求和动作失效，重新显示后读取当前会话 |
| `changes/browser/sessionChangesEditor.ts`             | 输入所指会话的比较编辑器、子 pane、AbortController、视图状态与显隐生命周期                          | 保留；已具备隐藏失效及重新显示刷新行为，测试继续覆盖                           |
| `changes/browser/sessionChangesEditorInput.ts`        | 编辑器资源身份、展示元数据、能力及序列化；标签协调器创建，EditorService 持有                        | 保留；不缓存账本或持有第二套会话选择状态                                       |
| `changes/browser/sessionsChangesAccessibilityHelp.ts` | 定义列表和编辑器的 Help / Accessible View 提供者；注册入口统一注册                                  | 已移入既有四个提供者的内容和焦点恢复逻辑，读取 live pane，不保存内容副本       |
| `changes/browser/media/changesView.css`               | 变更列表本地 DOM 的排版、路径省略和状态文本样式                                                     | 保留                                                                           |
| `changes/browser/media/sessionChangesEditor.css`      | Changes 比较宿主的尺寸及溢出边界                                                                    | 保留                                                                           |

账本和提交操作继续通过 `workbench/services/chat/common/chatService.ts` 的领域契约执行。列表快照、编辑器显示内容各自属于 UI 生命周期，不成为另一份业务账本。`browser/turnMultiDiffSource.ts` 及其 contribution 同时供 Code、Cowork 和共享多文件比较消费，继续留在 Sessions core；将其移到 Changes contribution 会造成 core 反向导入 contribution。

### Changes 能力补齐

Turn 内容、修订和提交状态继续由 ChatService 与后端账本拥有。以下入口已走生产调用链，UI 状态不改写账本证据：

| 用户入口                      | 唯一 owner 与当前行为                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表、摘要、失败重试          | ChangesViewPane 从账本读取文件；同一会话刷新保留焦点和选择，失败清除旧行，隐藏后忽略迟到结果。                                                                                                                          |
| Turn 筛选、List / Tree        | changesViewRenderer 独立构建按 Turn 和目录分组的树，重复路径可独立选择。changesViewActions 注册显示模式命令，ChangesViewService 保存展示状态。                                                                          |
| 逐文件审阅                    | 标记绑定 Session、Thread、ChangeSet、文件和具体 revision；只保留在当前窗口，修订变化不会继承标记，也不改变提交条件。                                                                                                    |
| 视图恢复                      | profile UI state 保存显示模式；窗口内分别保存会话、Turn 筛选和模式的选区、焦点、折叠及滚动快照。Checks 折叠状态按会话恢复。                                                                                             |
| Sync / Publish / working tree | Git 命令绑定会话目录下的确切仓库；pull 后重新核对 branch / remote，失败或切换会话阻止后续 push。Git 提供方返回真实 upstream 和未提交计数，命令边界验证非负安全整数；旧提供方缺失的计数不显示为 0。                      |
| CI checks                     | 可取消地读取关联开放 PR 当前 head 的全部分页 checks 和 commit statuses；账号变更清除旧数据，隐藏释放读取，普通刷新保留链接焦点。                                                                                        |
| 直接创建 PR                   | 准备与写入分离；提交前重核 local head、remote、账号和工作目录。创建后附加到发起会话，附加 / 自动合并失败仅作为已创建结果的警告；不同 published head 不启用自动合并。                                                    |
| Agent 创建 PR                 | createPullRequestChatRequest 在准备上下文复核后向发起 Thread 提交用户显示的字段。空闲 Thread 使用 startTurn，活动 Turn 使用 queueTurn，沿用正常权限。档案状态检查和准备失败不会提交；无法确认写入结果时禁用同表单重试。 |
| PR 表单偏好                   | profile UI state 仅保存 Draft、合并方式和主操作，不保存标题、正文、路径或账号。恢复时受当前仓库能力限制，未支持的合并方式及 Agent 入口不会恢复为有效操作。                                                              |
| Help / Accessible View        | 使用实际表单、树和状态内容，中英文覆盖新增控制。键盘支持树折叠、文件选择、表单焦点循环和取消后的焦点恢复。                                                                                                              |

ChangesViewService 当前只拥有上述展示状态及修订绑定的 read marker；它不是上游 provider changeset / isolation / feedback 的聚合服务。`reviewedFilesObs` 由树和无障碍内容消费，没有第二份业务账本。Agent 请求成功只表示任务已提交，不表示 PR 已创建，也不提供后台合并策略。

共享 multi-diff 的来源替换会取消旧模型的就绪等待；等待捕获所属代次的取消信号，防止已经释放的模型让编辑器一直停在 pending。SessionChangesEditor 在加载子比较前提供视口，并传递宿主输入取消信号。Turn / commit 源、来源操作和内容标签仍在已确认的共享 Sessions core 中，服务 Code 和 Cowork。

### 剩余契约边界

文件集合中仍缺少七个上游路径；同路径文件也不等于全部公开成员或行为已对齐：

- `sessionChangesService.ts`、`common/sessionChangesService.ts`：上游 session URI / provider changeset 编辑器 facade 与 Ash 的 Session / Thread 身份及稳定 EditorInput owner 不同，没有另造一份身份服务。
- `changesMultiDiffSourceResolver.ts`、`changesEditorLabels.ts`：已有共享 core 的实际来源和标签 owner；未将其反向迁入 contribution 或增加转调外壳。
- `changesActions.ts`、`changesetReviewActions.ts`：当前提供不可变 Turn 预览 / 提交与窗口内审阅标记；后端没有跨客户端持久化 reviewed-file 和通用 provider changeset operation 契约。
- `media/sessionChangesEditorInput.css`：现有 input 是稳定资源身份，没有对应上游 label DOM；未创建没有命中对象的样式文件。

已接入的 IChangesViewService / renderer 是基于 Turn 的实际展示端口，尚不提供上游 transient changeset、隔离、反馈评论和 provider operation API。PR 已支持直接创建、Agent 请求、Draft、auto-merge 和有效偏好；agent merge policy 的持续执行与 request metadata 仍需后端工作流契约。CI 的 rerun、logs / annotations 与 Fix CI 请求仍没有完整领域端口。

### Terminal、启动装配与 fixture

扩展宿主注册已迁到 `workbench/api/browser/extensionHost.contribution.ts`，保留依赖就绪顺序；旧 `services/extensionHost/browser/extensionHostServiceRegistration.ts` 按用户确认的准确路径删除。后续 Terminal contract 收敛至 Workbench services 后，API 入口消费这些领域契约，层级检查包含类型引用和唯一 service identifier owner。

Sessions 集成 fixture 移除全局 Plugin 服务 mock，使用产品现有的 disconnected API 和窗口拥有的唯一 Plugin 实例。连接后的 AppTools 使用共享 Task / Terminal 服务，Sessions 入口装配 Task、Output 和窗口 Marker registry。Task / Output 的视图注册由 Code 与 Sessions 分别选择其注册表，避免导入服务时重复注册另一种窗口的命令；Output 的 reveal contribution 在两种 Sessions 入口装载。`registerOutputView(registry)` 是本轮实际窗口调用的 Ash 装配端口，服务实现及业务状态 owner 没有迁移。

## 验证与当前完成范围

Changes 当前有 27 个生产 TS / CSS 文件，均有上游同路径及实际调用方。文件缺失从 14 个减少到七个，以上边界未计为已实现。

使用原 tsconfig.test.json 的编译选项和 ambient typings 对 11 个受影响测试文件定向编译，并通过既有 unit runner 执行：75 项通过，包含 21 项 Changes / Git context、17 项共享 multi-diff、37 项层级及架构检查。全量单测准备阶段曾被并行的 Chat 未完成字段修改阻塞；未修改或绕过其业务代码。

Changes 浏览器七项覆盖筛选、模式切换、折叠、选区与会话恢复、修订 / 会话审阅隔离、Git 计数、PR 直接创建及 Agent 提交 / 排队、偏好能力限制、焦点、中英文和主题。完整 Sessions fixture 11 项已通过，Changes 短窗格布局场景已通过。最终执行 Changes、Sessions 和 viewpaneLayout 三个浏览器文件，共 31 项全部通过（包含 renderer 错误处理回归）。

七个 Changes CSS 通过 stylelint；CSS ownership audit 的完全相同、品牌替换等价、上游品牌引用、产品 root 和新增品牌引用均为零。

`pnpm typecheck:renderer` 通过，包含 3,690 个 renderer 文件和 common 检查。相关 35 个 TS / JS 文件通过格式检查，所触及的 diff 通过空白检查。

实际 Electron 启动 smoke 和完整提交 / 会话隔离 E2E 已通过。扩展场景连续 3 次完成 A 会话部分提交、B 会话完整提交、返回 A 提交剩余文件；核对两份 Turn 账本均为 committed、三个文件内容和 4 个 Git 提交，并继续验证比较显隐、折叠恢复和已提交文件不可再次预览。测试的运行时错误检查未降低。

renderer exitCode 5 已通过 minidump 和匹配 Electron 44.4.5 的官方符号定位：Blink 在处理异常消息时触发 partition_alloc::internal::OnNoMemoryInternal。最初异常来自 Sessions 未加载标准 editor.all，Changes 折叠未改动区域时缺少 Diff Editor breadcrumbs 注册；默认错误处理器重新抛出带栈的异常，经 WorkbenchWindow 再次送回，导致消息递归膨胀。Sessions 入口现加载现有标准能力集合；Workbench 的窗口错误和 rejected promise 终止于现有日志服务，窗口释放时恢复原处理器。真实浏览器回归验证两类错误各记录一次、窗口仍可操作、正式 shutdown 后恢复处理器。原生诊断开关和临时输出已移除。

本轮定向单测及架构测试 54 项通过，renderer / automation 类型与 5 个触及 TS 文件格式检查通过。尚未执行上游窗口的配对全场景，不宣称上游全部 API 和 UI 行为已完全对齐。

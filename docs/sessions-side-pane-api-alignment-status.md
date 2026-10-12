# Sessions 右侧编辑器与 Details 对齐状态

范围是 Code 会话右侧的编辑器标签栏、Files / Changes 编辑器、Details 视图和桌面布局控制器。主对话输入、Sessions 列表、Library / Creator 内容实现不在本次范围内。

只读参照为 `../vscode/src/vs/sessions`，提交 `959031245ebb1fe077e0d512e1397c0ae82006e4`。清单包含生产 `.ts` / `.css`，排除测试、文档和图片。上游存在但未接入本地调用链的文件只记录为待调查，不作为实现队列。

## 文件集合

下列路径均相对 `src/ash/sessions/` 或上游 Sessions 根目录。

| 范围                                  | 双方同路径 | 仅 Ash | 仅 VS Code |
| ------------------------------------- | ---------: | -----: | ---------: |
| `contrib/files/`                      |          3 |      0 |          0 |
| `contrib/editor/`                     |          6 |      0 |          5 |
| `contrib/changes/`                    |         20 |      0 |         14 |
| `contrib/layout/`                     |          5 |      1 |          9 |
| 下列限定的 Part、挂载器和布局服务契约 |          0 |      7 |          8 |
| 合计                                  |         34 |      8 |         36 |

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
contrib/changes/browser/changesViewActions.ts
contrib/changes/browser/changesViewRenderer.ts
contrib/changes/browser/changesViewService.ts
contrib/changes/browser/changesetReviewActions.ts
contrib/changes/browser/createPullRequestChatRequest.ts
contrib/changes/browser/media/changesViewActions.css
contrib/changes/browser/media/sessionChangesEditorInput.css
contrib/changes/browser/sessionChangesService.ts
contrib/changes/common/changesViewService.ts
contrib/changes/common/createPullRequestPreferences.ts
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

列表仍以 ChatService 的不可变 Turn 账本为业务来源。以下入口已经接入真实生产调用链，未复制上游实现，也未新增平行业务状态：

| 用户入口                                          | 对应文件与唯一 owner                                                                                                      | 当前行为                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 列表刷新与失败重试                                | `changesView.ts`、`changesSummaryWidget.ts` 及对应 CSS                                                                    | 展示文件更改数和增删摘要；刷新保留同一会话的选择和焦点，加载期间禁用预览，失败清除过期行并提供重试                                                                             |
| Sync changes、Publish branch、Review working tree | `sessionSyncChanges.ts`、`media/changesActions.css` → 可选 Git 扩展命令                                                   | 按会话目录筛选仓库，多仓库由用户选择；操作显式传入仓库 ID，分支或 remote 改变、切换会话、pull 失败都阻止后续 push                                                              |
| Checks 展开与结果链接                             | `checksViewModel.ts`、`checksWidget.ts`、`checksActions.ts` 及 CSS → 既有 GitHub API                                      | 读取关联开放 PR 的当前 head 的全部分页 check runs 和 commit statuses；账户或会话切换取消旧读取，隐藏视图释放模型，普通刷新保留链接焦点                                         |
| Create pull request                               | `createPullRequestContextView.ts`、`createPullRequestWidget.ts`、`common/pullRequestCreation.ts` 及 CSS → 既有 GitHub API | 只读准备表单，编辑标题、描述、目标分支、Draft 和仓库允许的自动合并方式；提交前核对 local head、remote 与账户；创建后附加到发起会话，后续附加或自动合并失败作为已创建结果的警告 |
| PR 表单 Help / Accessible View                    | `sessionsChangesAccessibilityHelp.ts`、`common/changes.ts`                                                                | 读取 live 表单内容，显示字段值和 Draft 状态，关闭后恢复原控件焦点；列表帮助覆盖新增动作                                                                                        |

PR 创建一旦发出，其完成归属发起会话，关闭表单不会把结果改附到另一个会话。结果不确定时禁止在同一表单重复提交；发布分支与 local head 不同的实际结果提示审阅并不启用自动合并。业务操作由平台 GitHub 服务执行，未引入新的 transport DTO。

当前契约是 Ash Turn 账本和可选 Git/GitHub 提供方的独立适配，不能称为上游全部 API、模型和布局完全对齐。以下 14 个文件仍没有对应的完整本地契约；不创建占位文件：

- `changesViewService.ts`、`common/changesViewService.ts`、`sessionChangesService.ts`、`common/sessionChangesService.ts`：上游 provider changeset、Git 状态、隔离模式与审阅状态的聚合契约仍不同；Ash 的账本、会话选择、Details 路由及比较输入已有各自 owner。
- `changesMultiDiffSourceResolver.ts`、`changesEditorLabels.ts`：Turn / commit 多文件来源与标签仍由已确认的共享 Sessions core 拥有，服务 Code、Cowork 和共享比较；不能将 core 反向迁入 contribution。
- `changesViewRenderer.ts`、`changesViewActions.ts`、`media/changesViewActions.css`、`media/sessionChangesEditorInput.css`：上游层级 changeset 树、显示模式及其专用操作契约未实现；当前 Turn 行 DOM 继续由 view 拥有，通用比较操作由共享 Editor 提供。
- `changesActions.ts`、`changesetReviewActions.ts`：持久化 reviewed-file 状态和 provider changeset 操作没有对应的 Turn 领域接口。
- `createPullRequestChatRequest.ts`、`common/createPullRequestPreferences.ts`：上游创建 PR 的 agent 请求 metadata、agent merge 策略和偏好契约未接入；本次只提供现有 GitHub API 能执行的人工创建与自动合并。

Checks 目前提供状态及结果链接。工作流重跑、日志/annotation 读取和 Fix CI agent 请求缺少当前领域接口，未伪造可点击入口。Git 仓库上下文不提供 incoming/outgoing 数量，因此 Sync 不显示虚构的计数。

## 验证与当前完成范围

Changes 当前有 20 个生产文件，Files 的三个文件保持原样。新增的 12 个 Changes 文件均有上游同路径及本地生产调用方；没有文件移动或删除。剩余 14 个路径的契约差异见前表，未将其计为已实现。

定向单测共 14 个通过，覆盖列表的中英文内容、选择与焦点、失败重试、显隐释放、二进制比较、Checks 分页与账户取消、Git 同步的仓库绑定与中断、PR 编辑值保留、重复提交阻止及迟到结果。最后的无障碍内容关闭保护及表单改动分别定向重跑通过。运行入口：

```sh
pnpm test:unit \
  --run src/ash/sessions/test/browser/changesView.test.ts \
  --run src/ash/sessions/contrib/changes/test/browser/sessionChangesEditor.test.ts \
  --run src/ash/sessions/contrib/changes/test/browser/checksViewModel.test.ts \
  --run src/ash/sessions/contrib/changes/test/browser/sessionSyncChanges.test.ts \
  --run src/ash/sessions/contrib/changes/test/browser/createPullRequestWidget.test.ts

pnpm test:browser:integration changes.integration.spec.ts viewpaneLayout.integration.spec.ts --project=chromium

pnpm run test:smoke:ui test/smoke/areas/sessions/turn-changes.spec.ts --grep 'starts disabled'
```

相关浏览器场景 17 个通过，其中最终 Changes / PR 五个场景在最后改动后单独重跑通过。覆盖键盘、取消及账户切换焦点恢复、异步刷新链接焦点、真实 DOM 与计算样式、窄窗口、浅色/深色/高对比度、中英文、编辑后的 PR 创建和会话附加、实际发布 head 不同时禁止自动合并。

Electron smoke 的一个实际 Changes 场景通过。此前启动失败暴露了 Sessions common entry 未加载共享配置解析服务；已补上 `sessions.common.main.ts` 的装配 import，让现有 Terminal profile resolver 的依赖闭合。此修复没有新增服务实现。

`pnpm typecheck:renderer` 通过；本次 20 个相关 TypeScript 文件通过格式检查，六个 Changes CSS 文件通过 stylelint。CSS ownership audit 结果为：完全相同、品牌替换等价、上游品牌引用、上游产品 root 和新增品牌引用均为零。

全局验证仍有两项既有问题：

- `test/architecture/layer-boundaries.test.ts` 的 11 项中 10 项通过，服务实现不得依赖 contribution 的一项失败；现有 `workbench/services/extensionHost/browser/extensionHostServiceRegistration.ts` 导入了 Terminal 的 browser/common contribution 契约，本次未修改该模块。
- 扩大到 `sessions.integration.spec.ts` 的四个页面场景在 fixture 启动时因 `pluginManagementService` 重复注册失败，未进入页面断言；其 fixture 全局单例与 Sessions 既有显式注册冲突。Changes 独立场景和实际 Electron 启动不受该 fixture 问题阻塞。

未执行与上游窗口逐项配对的完整场景，因此这里报告的是已接入并验证的 Ash 能力，不宣称上游全部 API、审阅模型或 UI 行为完全对齐。

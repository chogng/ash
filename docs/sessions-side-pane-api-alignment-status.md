# Sessions 右侧编辑器与 Details 对齐状态

范围是 Code 会话右侧的编辑器标签栏、Files / Changes 编辑器、Details 视图和桌面布局控制器。主对话输入、Sessions 列表、Library / Creator 内容实现不在本次范围内。

只读参照为 `../vscode/src/vs/sessions`，提交 `959031245ebb1fe077e0d512e1397c0ae82006e4`。清单包含生产 `.ts` / `.css`，排除测试、文档和图片。上游存在但未接入本地调用链的文件只记录为待调查，不作为实现队列。

## 文件集合

下列路径均相对 `src/ash/sessions/` 或上游 Sessions 根目录。

| 范围                                  | 双方同路径 | 仅 Ash | 仅 VS Code |
| ------------------------------------- | ---------: | -----: | ---------: |
| `contrib/files/`                      |          3 |      0 |          0 |
| `contrib/editor/`                     |          6 |      0 |          5 |
| `contrib/changes/`                    |          8 |      0 |         26 |
| `contrib/layout/`                     |          5 |      1 |          9 |
| 下列限定的 Part、挂载器和布局服务契约 |          0 |      7 |          8 |
| 合计                                  |         22 |      8 |         48 |

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
contrib/changes/browser/changesSummaryWidget.ts
contrib/changes/browser/changesViewActions.ts
contrib/changes/browser/changesViewRenderer.ts
contrib/changes/browser/changesViewService.ts
contrib/changes/browser/changesetReviewActions.ts
contrib/changes/browser/checksActions.ts
contrib/changes/browser/checksViewModel.ts
contrib/changes/browser/checksWidget.ts
contrib/changes/browser/createPullRequestChatRequest.ts
contrib/changes/browser/createPullRequestContextView.ts
contrib/changes/browser/createPullRequestWidget.ts
contrib/changes/browser/media/changesActions.css
contrib/changes/browser/media/changesSummaryWidget.css
contrib/changes/browser/media/changesViewActions.css
contrib/changes/browser/media/checksWidget.css
contrib/changes/browser/media/createPullRequest.css
contrib/changes/browser/media/sessionChangesEditorInput.css
contrib/changes/browser/sessionChangesService.ts
contrib/changes/browser/sessionSyncChanges.ts
contrib/changes/common/changesViewService.ts
contrib/changes/common/createPullRequestPreferences.ts
contrib/changes/common/pullRequestCreation.ts
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

### 上游其余 Changes 文件的职责判断

以下 26 个路径均已核对公开声明与当前本地调用方。已有职责对应不表示上游全部公开 API 已实现；没有本地入口的能力不提前创建文件。

| 上游路径（相对 `contrib/changes/`）                                                                                                                                                                                                          | 本地承担者或缺口                                                                                                                        | 当前处理                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `browser/changesViewRenderer.ts`、`browser/changesEditorLabels.ts`                                                                                                                                                                           | 列表行和路径标签目前由 `ChangesViewPane` 渲染；比较标签由 `turnMultiDiffSource.ts` 生成。没有复用同一 renderer 的第二个入口             | 保留当前 DOM owner，不机械拆分；上游层级树 renderer 与标签 API 未宣称实现        |
| `browser/changesMultiDiffSourceResolver.ts`                                                                                                                                                                                                  | 当前 Turn / commit 来源注册和解析由 `browser/turnMultiDiffSource.contribution.ts` 承担，内容合成由 `turnMultiDiffSource.ts` 承担        | 保留共享 core owner；上游 reviewed-file context 和 provider changeset 契约仍不同 |
| `browser/changesViewService.ts`、`common/changesViewService.ts`、`browser/sessionChangesService.ts`、`common/sessionChangesService.ts`                                                                                                       | 业务账本属于 ChatService；会话选择属于 SessionsService；Details 路由与标签协调已有 owner。上游还汇集 Git、隔离模式及 changeset 操作状态 | 不为服务名创建并行账本或选择模型；其他契约须在实际入口出现时调查                 |
| `browser/changesActions.ts`、`browser/changesViewActions.ts`、`browser/changesetReviewActions.ts`、`browser/sessionSyncChanges.ts`                                                                                                           | 本地已有打开比较、选择提交预览及提交准备树入口。上游文件另包含操作工具栏、reviewed-file 标记、分支同步等职责                            | 不把现有不可变比较等同于上游审阅状态或同步能力；当前 Changes 没有这些新增入口    |
| `browser/changesSummaryWidget.ts`、`browser/media/changesSummaryWidget.css`                                                                                                                                                                  | 列表目前显示逐文件计数与状态，没有独立摘要 widget 入口                                                                                  | 不创建 widget 外壳                                                               |
| `browser/checksActions.ts`、`browser/checksViewModel.ts`、`browser/checksWidget.ts`、`browser/media/checksWidget.css`                                                                                                                        | 当前 Changes 没有 CI checks 展开、修复或展示入口                                                                                        | 不创建 actions、model 或 widget                                                  |
| `browser/createPullRequestChatRequest.ts`、`browser/createPullRequestContextView.ts`、`browser/createPullRequestWidget.ts`、`common/createPullRequestPreferences.ts`、`common/pullRequestCreation.ts`、`browser/media/createPullRequest.css` | 当前 Changes 没有创建 PR 表单及其偏好入口；已有 PR 关联服务不等同于创建表单                                                             | 不扩展本次范围，不创建请求或偏好占位接口                                         |
| `browser/media/changesActions.css`、`browser/media/changesViewActions.css`、`browser/media/sessionChangesEditorInput.css`                                                                                                                    | 对应的专用操作 DOM 或输入内嵌展示尚未由本地创建                                                                                         | 不提前添加不命中本地 DOM 的样式                                                  |

## 验证与当前完成范围

当前已完成 Files / Changes 全部 11 个生产文件的职责核对、共享标识及无障碍提供者分离、Changes 列表生命周期修复。无文件移动或删除，未新增平行业务状态、服务外壳或未接入的动作。Files 的三个生产文件及两者的 CSS 保持原样。

本批运行：

```sh
pnpm test:unit \
  --run src/ash/sessions/test/browser/changesView.test.ts \
  --run src/ash/sessions/contrib/changes/test/browser/sessionChangesEditor.test.ts \
  --run src/ash/sessions/contrib/files/test/browser/files.contribution.test.ts \
  --run src/ash/sessions/contrib/layout/test/browser/desktopLayoutController.test.ts \
  --run test/architecture/layer-boundaries.test.ts
```

36 个相关测试通过：Changes 列表 4 个、Changes 编辑器 1 个、Files 3 个、布局控制器 17 个、架构 11 个。补充列表中英文无障碍内容及编辑器焦点恢复断言后，定向重跑相关 5 个测试通过。新生命周期 suite 启用 disposable tracker，并验证会话、账本和 ready 监听器释放。单测 runner 的 9 个测试通过。

`pnpm typecheck:renderer` 通过，涉及的 7 个 TypeScript 文件通过 `pnpm format:ts`。CSS 源码检查确认既有三个文件使用本地 selector/token，未与对应上游 CSS 完全相同；本批未修改 DOM 结构、CSS、主题或尺寸。未执行真实窗口配对场景，未将剩余上游公开 API 计为已实现。

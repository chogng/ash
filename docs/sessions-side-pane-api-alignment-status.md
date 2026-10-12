# Sessions 右侧编辑器与 Details 对齐状态

范围是 Code 会话右侧的编辑器标签栏、Files / Changes 编辑器、Details 视图和桌面布局控制器。主对话输入、Sessions 列表、Library / Creator 内容实现不在本次范围内。

只读参照为 `../vscode/src/vs/sessions`，提交 `959031245ebb1fe077e0d512e1397c0ae82006e4`。清单包含生产 `.ts` / `.css`，排除测试、文档和图片。上游存在但未接入本地调用链的文件只记录为待调查，不作为实现队列。

## 文件集合

下列路径均相对 `src/ash/sessions/` 或上游 Sessions 根目录。

| 范围                                  | 双方同路径 | 仅 Ash | 仅 VS Code |
| ------------------------------------- | ---------: | -----: | ---------: |
| `contrib/files/`                      |          3 |      0 |          0 |
| `contrib/editor/`                     |          6 |      0 |          5 |
| `contrib/changes/`                    |          6 |      0 |         28 |
| `contrib/layout/`                     |          5 |      1 |          9 |
| 下列限定的 Part、挂载器和布局服务契约 |          0 |      7 |          8 |
| 合计                                  |         20 |      8 |         50 |

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
contrib/changes/browser/sessionsChangesAccessibilityHelp.ts
contrib/changes/common/changes.ts
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

## 验证与当前完成范围

已完成目标文件集合核对、Part 职责映射和编辑器命令、菜单、context key 注册迁移。Files / Changes 后端行为及 Part 几何不变。未将其他上游缺失项标为已实现。

现有基线命令：

```sh
pnpm test:unit \
  --run src/ash/sessions/contrib/files/test/browser/files.contribution.test.ts \
  --run src/ash/sessions/contrib/layout/test/browser/desktopLayoutController.test.ts \
  --run src/ash/sessions/test/browser/sessions-layout.test.ts
```

迁移后的上述 34 个测试继续通过。新增 `contrib/editor/test/browser/editor.contribution.test.ts` 验证真实命令入口、Add tab 的串行操作、菜单可见性与禁用态、窗口注册释放以及英文和 `zh-CN` 菜单文案。另运行 `test/architecture/layer-boundaries.test.ts`，11 个架构测试通过。新增测试首次运行的中文断言与既有翻译不一致，修正断言后定向重跑通过；最终相关测试合计 46 个通过。单测 runner 的 9 个测试也通过。

`pnpm typecheck:renderer` 通过，涉及的 5 个 TypeScript 文件通过 `pnpm format:ts`，`git diff --check` 通过。文件清单逐项验证了当前双方路径及四个 Part 路径保留情况。本次没有 DOM、CSS 或布局行为修改，未执行 Ash 与上游配对的真实窗口场景，也未宣称其他公开 API 全部对齐。

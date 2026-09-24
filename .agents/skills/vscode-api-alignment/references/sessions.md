# Sessions 对齐

仅在目标位于 `app-ts/src/ash/sessions` 时读取。修改 Sessions 代码时还必须使用 `sessions` skill，并读取仓库的 [Sessions 实现说明](../../../../app-ts/src/ash/sessions/README.md)；本 reference 只补充 VS Code 对齐边界。

## 对应范围

- 本地根目录：`app-ts/src/ash/sessions`
- 上游根目录：`../vscode/src/vs/sessions`
- `sessions` 位于 `workbench` 之上，可以复用工作台和更低层能力；`workbench` 不得反向依赖 Sessions 产品 UI 或布局。

## 对齐边界

- 按 `common`、`browser`、`electron-browser`、`electron-main`、`services` 或单个贡献完成整批对比；缺失的 VS Code 文件和公开 API 直接补齐，尚无决定的仅 Ash 项请求用户决定。
- 与 VS Code 对应的窗口、服务、布局或操作必须对齐准确 owner、公开契约、生命周期和真实调用链；仅 Ash 的产品模式、提供方适配和后端语义必须先取得用户决定，确认后可以继续承接确认范围内的产品职责。
- Session 领域模型、管理服务、窗口选择状态、布局和 Part 各自保持唯一 owner。API 名称迁移不能新增第二套 Session 类型、选择状态、布局状态或提供方入口。
- 用户决定保留的 Sessions 产品能力可以复用工作台机制，但不能把 Sessions 专属策略写入通用工作台或更低层。

## 验证

- 沿启动入口检查运行时创建、服务注册、布局、选择状态、主视图和释放顺序，确认生产调用经过唯一 owner。
- 运行实现说明列出的相关 Sessions 定向测试；涉及窗口或布局时验证真实用户流程和关闭释放。
- 同步检查 `workbench` 没有新增对 `sessions` 的反向依赖，并列出所有仅 Ash 文件和公开 API 的用户决定。

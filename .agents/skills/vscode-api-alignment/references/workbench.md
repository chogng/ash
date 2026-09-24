# Workbench 对齐

仅在目标位于 `app-ts/src/ash/workbench` 时读取。共同的对比规则、单一实现、删除确认和验证规则由主 `SKILL.md` 负责。

## 对应范围

- 本地根目录：`app-ts/src/ash/workbench`
- 上游根目录：`../vscode/src/vs/workbench`
- `workbench` 拥有应用壳、Part、窗格、编辑器承载、跨功能服务和产品组合，不拥有更低层的通用能力，也不拥有应用进程启动。

## 对齐边界

- 按 `browser`、`common`、`electron-browser`、`services` 或单个 `contrib` 完成整批对比；缺失的 VS Code 文件和公开 API 直接补齐，尚无决定的仅 Ash 项请求用户决定。
- 对应工作台核心、服务和贡献必须使用准确 owner 与公开契约。一个贡献从单一 `.contribution.ts` 入口注册，跨贡献调用依赖公开的共同契约，不进入其他贡献的内部文件。
- `workbench.common.main.ts`、`workbench.desktop.main.ts` 和 `workbench.web.main.ts` 只装载各自环境需要的服务与贡献；API 对齐必须同时检查入口导入和真实装载路径。
- 用户确认的 Ash 产品贡献可以继续承接确认范围内的产品职责，但不能借用职责不同的上游名称。`workbench` 不得导入 `sessions`，Sessions 专属布局和产品 UI 留在 `sessions`。

## 验证

- 同批读取目标切片的注册入口、服务 owner、生产调用方和相关行为测试，不能只比较声明文件。
- 证明公开 API 迁移后只有一个注册入口、一个状态 owner 和一条生效调用链，并检查桌面与 Web 入口是否都保持正确。
- 运行受影响服务或贡献的定向测试和最小 TypeScript 检查；UI 行为还需验证真实交互、键盘路径、焦点和释放。

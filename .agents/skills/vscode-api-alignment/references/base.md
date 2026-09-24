# Base 对齐

仅在目标位于 `app-ts/src/ash/base` 时读取。共同的对比规则、单一实现、删除确认和验证规则由主 `SKILL.md` 负责。

## 对应范围

- 本地根目录：`app-ts/src/ash/base`
- 上游根目录：`../vscode/src/vs/base`
- `base` 只拥有不依赖服务的通用 TypeScript 能力和 UI 基础部件，不承载 `platform`、`editor`、`workbench`、`code` 或 `sessions` 的领域状态与产品策略。

## 对齐边界

- 按 `common`、`browser`、`node`、`electron-*` 等运行环境比较 owner；不得为了同名 API 把环境能力放进错误目录。
- `common` 只使用基础 JavaScript。浏览器、Node 与 Electron 能力必须留在对应运行环境目录，不能通过间接导入进入 `common`。
- 对明确对应 VS Code 的工具、集合、生命周期或 UI 部件，要求文件路径、公开契约、边界行为和调用方对应；内部算法继续使用唯一的 Ash 实现。
- 尚无决定的仅 Ash 能力必须请求用户决定；调查清单同时说明它是否确实通用、是否存在服务依赖和真实跨领域调用方。用户确认由某个仅 Ash 文件承接的通用能力可以迁入该文件；带有编辑器、工作台或产品语义的能力不能为保留文件而抽象成 `base` API。
- 对 `base/browser/ui` 部件，先记录本地 DOM owner、状态 owner、输入监听点、尺寸来源和释放链。上游同路径文件只能提供公开契约与行为清单，不能作为类图或 DOM 模板；尤其禁止为了同名 `ScrollableElement`、Scrollbar 或 Widget API 整体搬入上游 wrapper 层级和私有控制器拆分。
- 基础部件第一次改变 DOM 层级、滚动/焦点输入或状态 owner 时，只实现一个真实调用切片并运行浏览器行为测试。该切片未证明交互和布局不退化前，不批量迁移 Workbench 或 Editor 调用方。

## 验证

- 审计完整目标目录的生产文件集合，并按运行环境分别报告同路径、仅本地、仅上游和大小写差异。
- 检查所有生产调用方，确认公开名称迁移后没有旧入口、重复实现或更高层反向依赖。
- 运行受影响的 `base/test/common`、`base/test/browser` 或对应环境测试，以及覆盖目标文件的最小 TypeScript 检查。

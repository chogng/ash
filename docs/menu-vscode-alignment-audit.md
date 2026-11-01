# Menu 与 VS Code 对齐审计

更新日期：2026-11-01。此前登记的 Menu 行为、ActionBar 继承和 Base MenuBar 所有权缺口已沿生产调用链补齐。保留用户确认的连续同级子菜单立即切换；首次展开仍等待 250ms，离开后的关闭宽限仍为 750ms。

## 参照与范围

只读参照为相邻 `../vscode`，提交 `1306698e328e5e531f5e632301d30020aa994eff`。公开声明用于确认契约，生产调用方、上游测试及同语义源码运行用于确认行为。Ash 的实现、DOM、CSS 和回归测试独立编写，不复制上游私有实现。参照目录没有工作区修改。

初次审计的 Ash 提交为 `788edb2012c85a10290f2e428904c4fd5c06e6af`；本轮验证的提交与未提交源码快照另外记录在本地证据中。工作树包含其他任务的改动，提交号不能单独证明本次构建内容。

范围包括 `base/browser/ui/menu` 整个目录，及其 action、ActionBar、ContextView、主题和真实宿主调用链。`menu.ts`、ActionBar 等在原路径修改；Base MenuBar 的 TypeScript/CSS 在上游对应路径创建，并实际接入 Workbench 与 Sessions。Ash 静态 `menu.css` 和 LSP 状态行保留其产品职责。

## 已闭合的缺口

| 原缺口                                | 当前行为与唯一 owner                                                                                                                                     | 验证                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 构造、options 和继承不一致            | `Menu(container, actions, options, styles)`，使用 `IMenuOptions/context/getKeyBinding`；继承并实际使用 ActionBar 的集合、runner、context、导航和生命周期 | 所有直接消费者迁移；集合、取消、失焦、重复 action、借用 runner 测试                           |
| 动态状态和替代操作                    | Base `Action` 发出变化事件；Menu 原地投影 label、enabled、checked、icon、class 和快捷键；按当前 Alt/平台 Shift 状态选择显示与激活的 action               | 两份实际源码对照；实时修饰键和状态回归                                                        |
| 打开时提前解析 alt                    | 浏览器保留原 action 图，由 Menu 在激活时决定；系统菜单在原生序列化边界取得快照                                                                           | BrowserContextMenu、工具栏、原生菜单执行/错误/取消测试                                        |
| 助记键缺失                            | 支持英文、俄文、中文后缀、重复助记键循环、动态替代 action 的助记键                                                                                       | 源码对照及真实 Chromium 测试，中文菜单名也保留可见助记符                                      |
| Tab、取消与焦点                       | 独立 Menu 保留 Tab；带过滤器/页脚的 ActionList 由宿主管理 Tab/Shift+Tab；子菜单返回原父项；替换控件不发出瞬间失焦                                        | Menu、ActionWidget、模型选择器和工具栏回归                                                    |
| 滚动与方向                            | `onScroll/scrollOffset/trigger` 使用实际 viewport；仅真实滚动关闭子菜单，触摸或滚轮抵达边界不关闭；左右展开按 option，嵌套弹层从父行顶部展开             | 原生滚轮、CDP 触摸、方向对照和浏览器几何断言                                                  |
| 嵌套选项与循环图                      | 子 Menu 继承 provider、ARIA 描述、radio 策略、runner/context 和样式；按需创建并携带祖先 ID 集合                                                          | 嵌套执行、provider、上下文更新、循环图及生命周期回归                                          |
| Shadow DOM、transform、HC             | 安装并按引用释放自身 ShadowRoot 样式；ContextView 使用浏览器顶层定位；HC 选中轮廓只作用于当前行；补齐 selection border、scrollbar 样式字段               | ShadowRoot 几何、无动画、样式释放、HC dark/light、实际窗口 tooltip 顶层命中                   |
| Base MenuBar 缺失、标题栏重复展开控制 | Base MenuBar 拥有分类、紧凑/溢出菜单、显隐、助记键和弹层生命周期；Workbench/Sessions 仅提供菜单贡献、作用域和执行错误通知                                | 两份源码导航/紧凑/显隐对照、生产 BrowserMenubarControl 浏览器测试、宿主 DI 与异步错误通知测试 |

ActionBar 同批迁移 `domNode/push/getWidth` 的真实调用方；Menu 不再保留另一套 action 集合与运行 owner。标题栏通过所属实例化作用域创建控制器，scoped context key 仍由该标题栏拥有。外部传入的 runner 不由菜单释放，命令异步失败在弹层关闭后仍交给宿主通知服务。

## 保留的增强和 Ash 实现边界

连续展开直接读取**本父 Menu 中另一个仍可见的子菜单**：A 展开后移动到同级 B，立即关闭 A 并展开 B；全部关闭后重新进入恢复 250ms；更深一层首次展开独立等待 250ms。要求真实指针移动，静止指针下出现菜单不自动展开。没有历史时间窗、全局热状态或 LSP 专用延迟分支。

MenuBar 分类/溢出层继续保留其已有的立即展开策略，这与普通嵌套菜单的连续切换判定分别归属当前层。没有引入 SCM/HoverService 的 after-hide 历史策略。

对齐覆盖生产契约与可观察行为，不要求两者内部 DOM、原生滚动实现或皮肤逐像素一致。Ash 使用自身 `.ash-*` 根、主题 tokens、图标和静态 CSS；没有复制 `monaco-*`、`--vscode-*` 或额外维护上游动态 CSS owner。无真实消费者的 `formatRule`、转义正则和 CSS 生成导出没有为了补清单保留。已有 Ash 的自定义状态行、provider、`update/contains/closeSubmenus` 等被真实调用的扩展点继续保留。

普通对象赋值不等同于 `Action` 变化事件：VS Code 不自动观察任意普通对象，Ash 的显式 `Menu.update()` 仍是兼容已有状态投影消费者的扩展。错误的多重助记符输入没有刻意复现上游的异常文本编码。系统原生菜单仍由操作系统拥有，本次没有改成自绘菜单。

## 清理

移除了旧 Menu 构造入口、旧 options 名、业务层提前递归替换 alt 的 helper、标题栏重复展开状态和键盘控制、重复的子菜单展开入口，以及无调用方辅助导出。每行变化订阅归该行生命周期，不再不断注册到长期 Menu store；保留列表正确处理同一 action 在多个位置出现的情况。原弹层 shell 样式在菜单释放时恢复，ShadowRoot 样式在最后一个菜单释放时移除。

没有删除文件，也没有整理无关工作区改动。

## 验证与证据

本地证据目录为 `.build/ash-playwright-mcp/menu-alignment-implementation/`；原始审计基线仍在 `menu-alignment-audit/`。具体测试数量、构建来源、源码与日志 SHA-256、PNG、真实 WebM、带章节 MP4 和 manifest 链接统一记录于本轮 `evidence.md`。

- 304 项相关测试通过（18 个文件的 302 项，加原生锚点新增 2 项）；另有 46 项 unit runner 回归和 1 项主题 registry release 检查通过。相关回归包含 action、Menu、ActionBar、ContextView、Toolbar/TabList、ContextMenu、ActionWidget、模型选择器、LSP、标题栏、Sessions 和文件菜单生产宿主；其中 Menu 浏览器场景覆盖真实触摸、HC、ShadowRoot、中文和紧凑/溢出菜单。
- renderer 类型检查、当前 renderer 构建、CSS 检查、中文本地化完整性及 CSS 内联资源 unit runner 回归均单独记录。样式检查保留既有 badge 10px 字号建议，错误为零。
- 两份实际源码使用相同语义输入运行：导航、Tab、激活、替代 action、助记键、事件模型状态、子菜单、ShadowRoot、循环图、MenuBar 导航/更新/显隐、紧凑菜单和方向；预期差异为已批准的连续切换和已说明的 Ash 状态投影/皮肤边界。
- 实际 Ash Desktop 四步场景通过：注册服务发现、8 次打开、12 次悬停/切换、关闭后重入、整行点击、左右键和 Escape、状态栏焦点恢复，以及状态 tooltip 在顶层菜单之上的实际命中。

该 Desktop 小样本记录中，打开中位数 2.4ms，首次悬停 254.4ms；连续同级切换中位数 0.8ms、p95 1.2ms；全部关闭后的重新悬停为 252.7ms。记录带录屏与 trace，不代表无录制负载或长期内存数据。250/750ms 的调度边界另有确定性计时测试。

### 验证限制

实际 Desktop 使用当前 checkout 的 renderer、已准备的 Main/App Server、隔离合成 workspace/profile，环境为 macOS arm64、Ash 0.1.0、Electron 44.4.5、Chrome 152.0.7977.130、Node 24.21.0。源码组件对照使用本机 Chromium。未验证安装包、Windows/Linux 实机和操作系统原生菜单。

Web 全产品场景在启动时被鉴权要求阻止（`Open the authenticated Web URL provided by the Ash launcher`），未进入菜单步骤。Agents Desktop 场景确认本机 macOS 使用 actions-only 标题栏，未找到自绘应用菜单，按失败保留证据；自绘 MenuBar 的生产宿主行为由实际 BrowserMenubarControl 浏览器 fixture 和 DI 测试覆盖，不能把它们称为 Web/Agents 完整产品验收。没有为通过场景修改鉴权或 macOS 产品策略。

原 live-LSP 场景因无关的 Settings 布局缺项 `chat.upvoteAnimation` 失败；通过场景使用真实服务发现返回的未启动 LSP 行，不包含本轮真实服务器进程 Stop/Restart 验收。失败记录与通过结果分别保留。

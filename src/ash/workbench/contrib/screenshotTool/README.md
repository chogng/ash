# 内置截图

`browser/screenshotTool.contribution.ts` 注册配置和 `snapshot.code` 命令。Web 与 Electron 入口分别注册窗口级 `ScreenshotToolService` 和 `NativeScreenshotToolService`。旧命令 ID、`snapshot.code.*`、`screenshot.globalShortcut` 与无障碍设置键保持不变，设置页归入内置 Screenshot 分类。

Chat、独立区域截图和代码图片通过 `ScreenshotToolService` 进入同一标注界面。服务持有配置与请求取消，`screenshotAnnotation.ts` 持有冻结图片、选区、绘制和撤销历史，`screenshotSelection.ts` 处理图片坐标。支持矩形、箭头、画笔、文字、马赛克、撤销、复制、保存与加入 Chat。Chat 发起的截图继承原草稿取消信号；独立截图在请求加入 Chat 后才获取附件目标。

`codeImage.ts` 根据截图配置渲染代码图片。`screenshotToolView.ts` 直接挂载标注组件，使用当前 Renderer 的 NLS、主题快照和本地字体资源；主题变量只写入组件根节点。脚本、CSS 和字体沿标准 Vite 模块依赖构建，没有专用虚拟模块或内联 HTML 打包。Browser 在当前文档挂载，桌面截图通过标准 imageView Renderer 入口在原生窗口挂载，同一份组件实现处理选区与标注。内置截图不经过扩展 Provider 选择，多个扩展默认注册不会影响它。

通用 `services/imageEditor` 保留外部 Provider 注册、代码图片快照、主题数据和隔离窗口承载。`platform/imageView` 持有原生呈现窗口、复制和文件输出；权限检查与系统操作由 Native 层提供。Snapshot 扩展及其启动链已移除。

与 VS Code 对齐当前调用链的文件职责；Ash 保留冻结整屏选区和增强标注。服务只暴露现有调用方使用的端口，未移植没有生产调用方的附件二次编辑、历史与遥测接口。

## 取像范围与权限

VS Code 的普通截图通过 `webContents.capturePage()` 获取自身窗口，应用窗口截图另走原生取像与 Chat Setup。Ash 保留的全桌面框选属于增强入口，不等同于上游的自身窗口截图。

| 输入               | 取像与权限入口                                                                                                                                                 | 标注输入                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Ash 全桌面框选     | `NativeScreenshotToolService` 在 macOS 预查权限；不足时调用 `ScreenCaptureSetupService`。Main 在采集与重拍时再次检查，返回 `ScreenCapturePermissionRequired`。 | 获得的桌面图片。             |
| 其他应用窗口       | `AppWindowScreenshotService` 返回 `permissionRequired`，Chat action 提供自己的 Setup 文案。                                                                    | 冻结的窗口图片。             |
| 代码图片或已有图片 | 不查询屏幕录制权限，也不采集桌面。                                                                                                                             | 代码快照渲染结果或传入图片。 |

Setup 服务每个 Workbench 窗口只打开一份界面，操作取消或窗口释放时关闭。设置跳转、返回复查、受限提示和显式重启共用 Ash Dialog、Button 与无障碍入口；权限状态始终重新读取 OS。授权后关闭 Setup，截图由用户重新发起。

全局快捷键在已授权时继续由 Main 直接采集桌面，保留后台取屏行为。权限不足时回到原 Workbench 命令，由该窗口显示 Setup。标注组件只接收图片，外部扩展 HTML 继续由通用图片窗口的隔离 iframe 承载。通用图片协议没有权限卡片、设置跳转、拖拽应用或复制应用路径的能力。

Pin 常驻贴图尚未实现。现有窗口已有置顶机制；常驻贴图需要独立于截图交互的窗口生命周期，避免被下一次截图、草稿取消或发起窗口关闭一并释放。

## 候选功能

以下功能未排期。

| 功能 | 候选范围                                                               | 待确定事项                                               |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| OCR  | 识别当前选区或已编辑图片中的文字，展示可选择、可复制的结果，保留原图。 | 识别引擎、语言支持、本地或在线处理方式。                 |
| 翻译 | 按用户选择的目标语言翻译截图文字；可复用 OCR 结果，展示原文与译文。    | 翻译服务、语言支持、调用成本，以及图片或文字的发送范围。 |

OCR 与翻译由用户显式触发。结果和在途请求绑定具体图片及操作；重新截图或关闭操作后取消旧请求，迟到结果不得覆盖新图片。

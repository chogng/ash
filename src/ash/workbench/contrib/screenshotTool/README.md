# 内置截图

`browser/screenshotTool.contribution.ts` 注册配置和 `snapshot.code` 命令。Web 与 Electron 入口分别注册窗口级 `ScreenshotToolService` 和 `NativeScreenshotToolService`。旧命令 ID、`snapshot.code.*`、`screenshot.globalShortcut` 与无障碍设置键保持不变，设置页归入内置 Screenshot 分类。

Chat、独立区域截图和代码图片通过 `ScreenshotToolService` 进入同一标注界面。服务持有配置与请求取消，`screenshotAnnotation.ts` 持有冻结图片、选区、绘制和撤销历史，`screenshotSelection.ts` 处理图片坐标。支持矩形、箭头、画笔、文字、马赛克、撤销、复制、保存与加入 Chat。Chat 发起的截图继承原草稿取消信号；独立截图在请求加入 Chat 后才获取附件目标。

新请求在权限预查前取消旧请求，迟到的权限结果不能替换当前截图或打开 Setup。屏幕截图提供“重拍”；冻结的应用窗口图片和代码图片提供“重置标注”，清除标注并保留原图和选区。

`codeImage.ts` 渲染代码图片。冻结的应用窗口图片和代码图片直接在发起 Workbench 中挂载标注组件，不创建原生编辑窗口；复制、保存沿用 Clipboard、File Dialog 与 File Service。主题、NLS 和本地字体由客户端提供。

`platform/screenshot` 仅持有全桌面截图覆盖窗口与独立 Pin 窗口。原生协议不接受 Provider HTML、代码快照或外部 Renderer。`code/electron-browser/screenshot` 是固定的产品入口，挂载同一标注组件或只读贴图组件。

`services/imageEditor` 仅管理扩展编辑器与附件目标，通过现有 Webview 承载扩展 HTML。截图服务只借用其附件目标，不借用扩展呈现协议。`platform/imageResize` 负责图片解码、缩放和编码；Chat 保留自己的 2048 像素附件预算与内容哈希。

## 取像范围与权限

VS Code 的普通截图通过 `webContents.capturePage()` 获取自身窗口，应用窗口截图另走原生取像与 Chat Setup。Ash 保留的全桌面框选属于增强入口，不等同于上游的自身窗口截图。

| 输入               | 取像与权限入口                                                                                                                                                 | 标注输入                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Ash 全桌面框选     | `NativeScreenshotToolService` 在 macOS 预查权限；不足时调用 `ScreenCaptureSetupService`。Main 在采集与重拍时再次检查，返回 `ScreenCapturePermissionRequired`。 | 获得的桌面图片。             |
| 其他应用窗口       | `AppWindowScreenshotService` 返回 `permissionRequired`，Chat action 提供自己的 Setup 文案。                                                                    | 冻结的窗口图片。             |
| 代码图片或已有图片 | 不查询屏幕录制权限，也不采集桌面。                                                                                                                             | 代码快照渲染结果或传入图片。 |

Setup 服务每个 Workbench 窗口只打开一份界面，操作取消或窗口释放时关闭。新请求可以接替仍在等待 Native 返回的已取消请求；旧请求结束时不能清除新请求。设置跳转、返回复查、受限提示和显式重启共用 Ash Dialog、Button 与无障碍入口；权限状态始终重新读取 OS。授权后关闭 Setup，截图由用户重新发起。

应用窗口在 macOS 通过 Native Main 取像；Windows 和 Linux 通过 Native Renderer 的桌面流回退取像。草稿取消、单帧完成或失败后停止所有轨道，并清除首帧回调和超时计时器；取消后迟到的流立即停止。

全局快捷键在已授权时继续由 Main 直接采集桌面，保留后台取屏行为。权限不足时回到原 Workbench 命令，由该窗口显示 Setup。标注组件只接收图片；外部扩展 HTML 由 Workbench 的共享 Webview 承载，不能请求原生 Pin 或系统权限操作。

桌面端的 Pin 将带标注的选区导出为独立置顶窗口。贴图可通过标题栏拖动、窗口边缘缩放，并提供复制、保存和关闭。Main 在 Renderer 就绪后移交窗口生命周期；下一次截图、草稿取消或发起窗口关闭不会释放贴图。贴图关闭或渲染进程退出时释放 IPC 和图片资源。Web 不显示 Pin。

## 候选功能

以下功能未排期。

| 功能 | 候选范围                                                               | 待确定事项                                               |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| OCR  | 识别当前选区或已编辑图片中的文字，展示可选择、可复制的结果，保留原图。 | 识别引擎、语言支持、本地或在线处理方式。                 |
| 翻译 | 按用户选择的目标语言翻译截图文字；可复用 OCR 结果，展示原文与译文。    | 翻译服务、语言支持、调用成本，以及图片或文字的发送范围。 |

OCR 与翻译由用户显式触发。结果和在途请求绑定具体图片及操作；重新截图或关闭操作后取消旧请求，迟到结果不得覆盖新图片。

# 剪贴板服务归属

`IClipboardService` 负责文本、查找词、选区文本、图像和 Ash 资源列表的剪贴板读写及粘贴事件触发。Ash 扩展的 `read()` 返回当前宿主可读取的 MIME 表示及其字节快照，不暴露宿主 ClipboardItem 或延迟读取对象。资源列表携带复制或移动操作，以便不同窗口中的 Explorer 保持剪切语义。Explorer 自己的选中项与剪切显示状态由 `IExplorerService` 持有。

| 文件                                                                              | 与 VS Code 的关系 | 已确认的职责                                                                         |
| --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `src/ash/platform/clipboard/common/clipboardService.ts`                           | 同路径            | 跨运行环境的剪贴板契约；不包含 Windows 文件剪切探测。                                |
| `src/ash/platform/clipboard/browser/clipboardService.ts`                          | 同路径            | 浏览器 Clipboard API 实现。                                                          |
| `src/ash/platform/clipboard/electron-browser/electronRendererClipboardService.ts` | 仅 Ash            | Renderer 到 Electron Main 的剪贴板 IPC 适配器；平台层的账户登录和 Workbench 共用它。 |
| `src/ash/platform/clipboard/electron-main/electronMainClipboardService.ts`        | 仅 Ash            | Electron Main 中的系统剪贴板格式读写，由宿主路由调用。                               |
| `src/ash/workbench/services/clipboard/browser/clipboardService.ts`                | 同路径            | Workbench 与 Sessions 的文本读取权限提示及重试；底层读写仍由 platform 实现。         |
| `src/ash/workbench/services/clipboard/electron-browser/clipboardService.ts`       | 同路径            | 两类桌面窗口共用的服务注册入口，复用已确认的 platform IPC 适配器。                   |

Web 剪贴板服务延迟创建，确保窗口布局和打开链接的依赖完成装配后再使用。文本读取失败时，通知提供“重试”和权限说明入口；删除通知或销毁服务会以空文本结束等待，并释放监听器。重试再次失败会重新提示。编辑器仍按原有选区、内容和焦点变化取消粘贴，权限恢复不允许过期的读取结果写入其他编辑器。

本目录的 Electron 对齐范围是环境注册入口。上游的桌面实现类在 Ash 中由已确认的 platform 适配器承接，未新增第二套状态或转发类。`triggerPaste(targetWindowId)` 已接入编辑器及普通输入框的 Paste 命令。Web 对注册窗口尝试系统粘贴命令，不支持时返回 `undefined`，普通 Paste 继续走带取消的文本读取；Electron 经可信 IPC 路由在发送窗口或其已登记的辅助窗口调用 `webContents.paste()`，由现有 EditContext paste 事件处理器消费文本、HTML、文件和粘贴 provider 数据。Renderer 的窗口 ID 仅用于本地窗口确认，辅助窗口使用创建时的唯一名称关联；Main 只在发送者的辅助窗口登记中解析目标，关闭后立即失效。系统窗口编号不从 Renderer 接收。普通 Paste 等待 CopyPasteController 的 provider 编辑完成；取消后返回，迟到的 provider session 仍被释放。Paste As 优先触发真实事件，保留 HTML、复制准备数据和编辑器元数据；服务资源列表仅在事件没有 URI list 时合并。无法触发事件时，Paste As 使用 `read()` 的 MIME 快照进入同一 provider、选择器和撤销流程，读取期间的选区、内容、焦点、只读、组合输入或销毁变化取消迟到结果。普通 Paste 继续使用文本回退。

`readText(type?)` / `writeText(text, type?)` 已接入真实选区剪贴板调用。Web 的具名文本属于服务内存，与系统文本独立；Electron 接受普通 `clipboard` 和 Linux `selection` 类型，宿主校验 typed payload，保留启动错误页面使用的普通文本 IPC。其他桌面平台的 selection 读返回空文本，写不改变普通剪贴板。

`src/ash/workbench/contrib/codeEditor/electron-browser/selectionClipboard.ts` 在 Linux Workbench 注册编辑器 contribution 和 `editor.action.selectionClipboardPaste`。非空多选区按位置排序并去抖写入 selection；超过 65,536 字符的选区不写入。`editor.selectionClipboard` 默认开启，沿用现有 settings.json 配置服务和已确认的 Workbench 注册归属；打开的编辑器立即响应设置变化。禁用该设置、模型切换、恢复状态和销毁会取消待写任务。中键粘贴和命令使用同一读取操作，选区、内容、焦点、只读、组合输入或销毁变化取消迟到粘贴；中键不重复触发 Chromium 默认粘贴。Sessions 桌面入口本批未加入该 contribution。单测覆盖任务与取消；Linux 系统 selection 和中键实机 smoke 场景已提供，当前 macOS 验证环境不运行该场景。禁用中键默认粘贴的文档监听覆盖现有及新登记的辅助窗口，并随窗口关闭释放。扩展测试专用内存剪贴板仍未迁入；资源列表继续使用已确认的复制或移动契约。

Web 的 Ctrl/Cmd+V 交给浏览器产生真实 paste 事件，EditContext 和 textarea 都从该事件取得 HTML、文件和 provider 数据。编辑器快捷键 contribution 不能阻止默认粘贴后再用 `readText()` 替代。命令面板或菜单发起的 Paste As 在系统粘贴命令不可用时，通过 `read()` 读取文本、HTML、自定义 MIME 和图像等表示；Web 自定义格式的 `web ` 前缀在服务边界移除，provider 仍使用原 MIME 类型。仅在浏览器缺少 rich read API 时回退为纯文本表示；权限拒绝和格式读取失败不会静默降级，Workbench 复用权限提示和重试，关闭提示或销毁服务返回空快照。Electron 的 `read()` 经可信 IPC 传递字节快照，正常 Paste As 仍优先走真实事件。Playwright 的富格式场景写入系统 ClipboardItem 并检查事件的 `isTrusted`、HTML、模型内容、撤销和焦点，不用合成事件证明系统粘贴。默认 HTML provider 只在显式 Paste As 中提供 HTML 编辑，普通粘贴仍插入纯文本。

快照转换由 `src/ash/editor/browser/dataTransfer.ts` 的 `toVSDataTransfer` 承接。文本和已知 JSON/XML 表示提供字符串；其他 MIME 保留文件项及原始字节，PDF 等格式使用对应扩展名，未知格式使用 `.bin`。自定义格式的 `asString()` 按需解码 UTF-8，无效字节返回空字符串，`asFile().data()` 始终返回原始字节。复制准备标识通过 `asString()` 解析，仍受同一读取取消边界保护。扩展名与 MIME 的查询统一归属 `src/ash/base/common/mime.ts`，Webview 资源响应也复用该基座。

Windows 上可用 [WSL 2 + WSLg](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps) 验证 Linux GUI 路径，支持 Windows 10 Build 19044+ 或 Windows 11。在 WSL 内安装依赖并使用 Linux Node/Electron，`node -p process.platform` 应返回 `linux`，`DISPLAY` 应指向可用的 WSLg X11 显示。Windows 版 Ash 或 Node 无法覆盖 Linux selection；Windows 剪贴板同步也不能替代 selection 测试，两种缓冲区在 [Electron 契约](https://www.electronjs.org/docs/latest/api/clipboard) 中相互独立。WSLg 跨 Windows 边界的 PRIMARY 同步另有 [上游跟踪](https://github.com/microsoft/wslg/issues/642)，本测试检查 Linux 应用内的 selection 和中键行为。

在 WSL 的仓库目录中运行以下已有场景；首次执行会构建 Linux Electron 所需产物。当前 macOS 环境未运行此测试。

```sh
pnpm run test:smoke:ui test/smoke/areas/editor/clipboard.spec.ts --grep 'Linux selection clipboard'
```

编辑器查找通过 `readFindText` / `writeFindText` 共享查找词，原模块级 `sharedFindTerm` 已退出。Web 的词属于窗口剪贴板服务；Electron 的 macOS 实现使用系统 find pasteboard，其他桌面平台返回空词且不写入。普通复制文本与查找词相互独立。`editor.find.globalFindClipboard` 默认关闭；开启后，打开或重新打开 Find 未从选区或参数取得查询时读取最新共享词，即使编辑器已有旧查询，修改非空查询会写回。大文件不访问 find pasteboard；迟到读取不能覆盖后续输入、关闭查找、模型切换、禁用共享设置或销毁。

用户确认沿用 `src/ash/workbench/contrib/codeEditor/common/editorConfiguration.ts` 的 Ash 专属配置注册职责来注册此开关，由 TextResourceEditor 读取并立即更新打开的编辑器，显式实例选项仍具有优先级。

Settings 的稳定服务通过构造注入解析；SettingActions 使用 IClipboardService，Workbench 和 Sessions 都通过各自作用域的实例化容器创建设置组件，options 仅携带每个实例的状态回调。

系统文件复制或移动后的目标写入属于文件转移：Explorer 调用 `ISystemFileTransferService.pasteSystemFiles(directory, moveRequested)`，文件服务将获授权的目标目录交给 App Server。

| 平台    | App Server 处理的系统文件粘贴                                                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | 核对文件列表与 `Preferred DropEffect` 剪切标记后执行移动；普通复制交给浏览器文件列表处理。                                                                                                                        |
| macOS   | 读取系统文件列表，按 `moveRequested` 选择复制或移动；Finder 的复制后移动由 Explorer 的移动粘贴命令发起。                                                                                                          |
| Linux   | 读取 GNOME 的 `x-special/gnome-copied-files`，或 `text/uri-list` 与 KDE 的 `application/x-kde-cutselection`，由剪贴板标记决定复制或移动。X11 支持直接数据和 INCR 分块传输；Wayland 读取路径已实现，尚未实机验证。 |

未连接 App Server 或没有可处理的系统文件列表时，该操作返回 `false`。普通粘贴会继续处理浏览器提供的文件列表；显式移动粘贴不会改成浏览器文件复制。移动完成后，后端仅在剪贴板仍对应本次文件列表时清空它。

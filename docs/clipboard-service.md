# 剪贴板服务归属

`IClipboardService` 负责文本和 Ash 资源列表的系统剪贴板读写。资源列表携带复制或移动操作，以便不同窗口中的 Explorer 保持剪切语义。Explorer 自己的选中项与剪切显示状态由 `IExplorerService` 持有。

| 文件                                                                              | 与 VS Code 的关系 | 已确认的职责                                                                         |
| --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `src/ash/platform/clipboard/common/clipboardService.ts`                           | 同路径            | 跨运行环境的剪贴板契约；不包含 Windows 文件剪切探测。                                |
| `src/ash/platform/clipboard/browser/clipboardService.ts`                          | 同路径            | 浏览器 Clipboard API 实现。                                                          |
| `src/ash/platform/clipboard/electron-browser/electronRendererClipboardService.ts` | 仅 Ash            | Renderer 到 Electron Main 的剪贴板 IPC 适配器；平台层的账户登录和 Workbench 共用它。 |
| `src/ash/platform/clipboard/electron-main/electronMainClipboardService.ts`        | 仅 Ash            | Electron Main 中的系统剪贴板格式读写，由宿主路由调用。                               |

系统文件复制或移动后的目标写入属于文件转移：Explorer 调用 `ISystemFileTransferService.pasteSystemFiles(directory, moveRequested)`，文件服务将获授权的目标目录交给 App Server。

| 平台    | App Server 处理的系统文件粘贴                                                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | 核对文件列表与 `Preferred DropEffect` 剪切标记后执行移动；普通复制交给浏览器文件列表处理。                                                                                                                        |
| macOS   | 读取系统文件列表，按 `moveRequested` 选择复制或移动；Finder 的复制后移动由 Explorer 的移动粘贴命令发起。                                                                                                          |
| Linux   | 读取 GNOME 的 `x-special/gnome-copied-files`，或 `text/uri-list` 与 KDE 的 `application/x-kde-cutselection`，由剪贴板标记决定复制或移动。X11 支持直接数据和 INCR 分块传输；Wayland 读取路径已实现，尚未实机验证。 |

未连接 App Server 或没有可处理的系统文件列表时，该操作返回 `false`。普通粘贴会继续处理浏览器提供的文件列表；显式移动粘贴不会改成浏览器文件复制。移动完成后，后端仅在剪贴板仍对应本次文件列表时清空它。

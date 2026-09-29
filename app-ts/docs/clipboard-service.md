# 剪贴板服务归属

`IClipboardService` 负责文本和 Ash 资源列表的系统剪贴板读写。资源列表携带复制或移动操作，以便不同窗口中的 Explorer 保持剪切语义。Explorer 自己的选中项与剪切显示状态由 `IExplorerService` 持有。

| 文件 | 与 VS Code 的关系 | 已确认的职责 |
| --- | --- | --- |
| `src/ash/platform/clipboard/common/clipboardService.ts` | 同路径 | 跨运行环境的剪贴板契约；不包含 Windows 文件剪切探测。 |
| `src/ash/platform/clipboard/browser/clipboardService.ts` | 同路径 | 浏览器 Clipboard API 实现。 |
| `src/ash/platform/clipboard/electron-browser/electronRendererClipboardService.ts` | 仅 Ash | Renderer 到 Electron Main 的剪贴板 IPC 适配器；平台层的账户登录和 Workbench 共用它。 |
| `src/ash/platform/clipboard/electron-main/electronMainClipboardService.ts` | 仅 Ash | Electron Main 中的系统剪贴板格式读写，由宿主路由调用。 |

系统文件剪切后的目标写入属于文件转移：Explorer 调用 `ISystemFileTransferService.pasteSystemCutFiles`，文件服务将获授权的目标目录交给 App Server。Windows 后端核对系统剪贴板的文件列表与剪切标记后执行移动；不匹配时返回 `false`，由 Explorer 继续处理浏览器提供的文件列表。未连接 App Server 时，该操作返回 `false`，不阻断浏览器文件导入。

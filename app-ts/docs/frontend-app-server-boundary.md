# 前端 Service 与 Rust App Server 的连接边界

结论：Workbench 通过前端领域 Service 使用业务能力；领域 API 把调用交给同一窗口的 App Server 协议客户端。Electron Main 负责取得连接、启动连接载体和转发消息，不按业务方法分发请求。`electron-main/` 不是所有 `xxxApi` 的归属目录，Service 也不负责启动 Rust 进程。

## 一次业务调用经过哪里

```text
Workbench / 编辑器调用方
  → 前端领域 Service（需要时提供接口、状态、事件和生命周期）
  → 该领域的 API 适配层（把领域操作映射为协议请求）
  → Renderer 中共用的 AppServerProtocolClient（初始化、请求配对、通知、关闭）
  → Electron MessagePort → Main 透明转发 → Rust App Server
  → 对应 Rust 领域能力
```

前端 Service 是调用方的稳定契约。它决定 UI 看见什么状态和错误、如何订阅变化，以及何时释放资源；如果一个能力只是简单的领域 API，并无需要管理的前端状态，也不必为了目录整齐新建 Service。领域适配层负责类型与协议的转换，不保存另一份后端持久状态。多个领域 API 复用一个窗口的协议客户端，不能各自启动进程或建立连接。

例如 [Workbench 装配](../src/ash/workbench/browser/workbench.ts)把 `api.git` 交给 Git Service；[Git API](../src/ash/platform/git/browser/gitApi.ts)将 `status()` 映射为 `git/status` 请求；[Renderer API 装配](../src/ash/platform/app-server/browser/webRendererApi.ts)让 Git、账户、会话等领域 API 共用协议客户端。普通 UI 不需要知道请求 ID、JSON-RPC 消息或连接端口。

## 目录按职责选择

| 位置 | 放什么 | 不放什么 |
| --- | --- | --- |
| `platform/<领域>/common/`、`workbench/services/<领域>/common/` 或 `workbench/contrib/<功能>/common/` | 前端领域接口和类型 | 传输消息、生成协议类型 |
| `platform/<领域>/browser/`、`workbench/services/<领域>/browser/` 或 `workbench/contrib/<功能>/browser/` | 领域 API 适配层、Service 实现 | 进程启动、通用连接状态 |
| `platform/app-server/browser/` | 协议客户端、请求配对、初始化和通知 | 具体领域的业务状态 |
| `platform/app-server/electron-browser/` | Renderer 的 MessagePort 传输 | Rust 进程管理 |
| `platform/app-server/electron-main/` | 连接载体启动、端口取得和透明转发 | 业务方法路由、领域 Service |
| `code/electron-main/` | Electron 应用、窗口与上述组件的装配 | 领域协议解析 |
| `ash-rs/` | 协议入口及各 Rust 领域的执行与持久状态 | 前端编辑器对象和窗口 UI |

领域属于 `platform` 还是 `workbench`，取决于它的真实调用方及 `base → platform → editor → workbench` 依赖方向。Workbench 中，非特定功能的核心 Service 放在 `services/`；Git 这样的功能专属 Service 放在 `contrib/git/`，即使它调用 App Server。`browser/` 表示可在浏览器环境使用的实现；只有需要 Electron IPC 的部分进入 `electron-browser/`。Main 若需提供系统窗口等宿主能力，应使用明确的宿主接口，不能因此成为业务协议的入口。

## 谁启动后端

桌面启动时，[Electron 应用入口](../src/ash/code/electron-main/app.ts)创建窗口的连接转发组件；[本地启动器](../src/ash/platform/app-server/electron-main/localAppServerProcessLauncher.ts)运行 `ash-app-server-daemon connect-selected`（前端专用调试入口可运行 `connect`）。[连接转发组件](../src/ash/platform/app-server/electron-main/appServerConnectionRelay.ts)把该连接载体的消息与 Renderer 的 MessagePort 对接。[daemon 客户端](../../ash-rs/app-server-daemon/src/client.rs)选择或复用同一 profile 的受管理 App Server，再转发当前连接的输入输出。因此窗口有各自的连接载体和协议客户端，后端服务进程可由多个窗口共用；不要把“每窗口一条连接”理解成“每窗口一个 Rust 服务进程”。

Web 页面使用另一条接入路径：浏览器直接连接经过认证的 App Server WebSocket，不经过 Electron Main；领域 Service 与 API 的职责仍相同。详细连接生命周期见[前端连接与浏览器能力](design/app-server-connection.md)。

## 与 VS Code 的关系

VS Code 的 Service 是前端取得能力的一种接口形式，也不意味着 Service 实现自己创建进程。其 Electron Main 创建 shared process（`src/vs/platform/sharedProcess/electron-main/sharedProcess.ts`）；扩展宿主由 Main 中的 `ExtensionHostStarter` 创建，Renderer 通过注册的远程 Service 请求它。Ash 可以借鉴“调用接口与进程生命周期分开”的边界，但 Rust App Server 是 Ash 自己的业务后端，不对应 VS Code 的某一个通用后端进程。

新增能力时，先确定 Rust 领域与前端调用方的契约，再实现领域 API 映射；有真实调用方需要稳定的前端领域契约时才增加 Service，不按协议方法数量创建。进程、连接和协议客户端继续复用上述各自的归属组件。

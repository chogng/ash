# Media Preview：云端方案与验收清单

## 范围与快照

- 选定独立模块：`src/ash/workbench/contrib/mediaPreview`，职责是 Workbench 图片、音频和视频只读编辑器预览。它与正在处理的 Search、Preferences、Trace、AgentHost、SCM、Output、Notifications、Editor 保存 owner 分离，适合作为并行模块。
- Ash 实现基线：`chogng/ash` `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`。云端实现分支为 `media-preview-retry-flow`。本地验收在 `codex/media-preview-retry-20261008` 独立工作树完成，基于 `e05e17e93c26f0281357ff9aca53bea8aaf98a67`，不改最初 AgentHost 活跃工作树。
- 对齐参考：`microsoft/vscode` `ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5`（2026-10-07）。上游实际 owner 是内置扩展 `extensions/media-preview`，不是 Workbench 通用 Editor 核心。
- 当前进度：首次读取/解码失败可见且可重试、取消与过期事件隔离、预览资源释放已通过单元回归与真实产品验收。macOS arm64 上 Browser UI、连接 App Server 的 Web 与 Electron 各 5/5 通过。大小预算、Open With 文本重开和扩格式仍属后续范围。未 push。

## 现有能力

| 用户能力         | Ash owner 与当前行为                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 打开图片         | `extensions/media-preview/package.json` 声明 `.png`、`.jpg`、`.jpeg`、`.webp` 和 image MIME 的只读自定义编辑器；Workbench 注册在 `src/ash/workbench/contrib/mediaPreview/browser/mediaPreview.contribution.ts`。`imagePreview.ts` 经 `IFileService.readFileBytes` 取二进制，再由 `inspectImage` 校验签名/解码。 |
| 查看与缩放       | `src/ash/workbench/contrib/mediaPreview/browser/imagePreview.ts` 当前支持窗口适配、原尺寸、缩放按钮、`+`/`-`、`0`/`1`；ResizeObserver 更新几何，放大的图可在 viewport 中滚动。                                                                                                                                  |
| 播放音视频       | `mediaPreview.ts` 按音频/视频创建浏览器 `<audio>` / `<video>` 原生控件；`preload="metadata"`，不自动播放；Space 可切换播放；Accessible View 提供文件名、大小、时长和状态。                                                                                                                                      |
| 失败恢复         | 首次读取错误现在留在预览 Pane，以可访问错误提示和 Retry 按钮恢复；图片解码错误同样可 Retry。图片/音视频文件变更后的读取失败仍可见。标准文本/二进制 Open With fallback 仍未实现。                                                                                                                                |
| 取消、切换、关闭 | 图片读取/解码使用取消信号、generation 防旧输入覆盖；图像位图会 `close()`。图片 `ImageResource` 拥有 object URL。音视频清理顺序是 pause、移除 src、`load()`，再 revoke URL；隐藏编辑器会暂停播放。                                                                                                               |
| 文件变化与安全   | 两种 Pane 都订阅 `IFileService.onDidChangeFiles`。图片先按 PNG/JPEG/WebP 签名识别，不以扩展名或 MIME 声称值决定格式；不创建文本模型。媒体字节变成 Blob/object URL，不直接把 workspace 路径装进 DOM。                                                                                                            |

现有覆盖位于 `src/ash/workbench/contrib/mediaPreview/test/browser/imagePreview.test.ts` 与 `mediaPreview.test.ts`，包括 editor 注册/匹配、zoom、音视频键盘播放、切换时暂停、撤销 URL、取消竞态、文件变更刷新和中文 NLS。测试当前主要用假 `IFileService`。

## 确认的缺口与方案

### P0：首次打开失败要留在预览内并能恢复（已实现并通过 Mac Electron/Web 验收）

当前 `ImagePreview.setInput` 在首次读取或 `inspectImage` 失败时直接 reject；不会设置 `loadFailure`，可访问内容退回 “No image loaded.”。音视频首次读取 reject 也不会走刷新订阅中的 catch，失败区不会呈现。上游 `media-preview` 对读取/解码错误给专门状态，并提供重新用文本/二进制编辑器打开的操作。

方案：把首次 read、签名/解码和媒体加载失败转换成 Pane 自己的可见、可访问状态。当前已保留 input 并实现显式 Retry；标准文本/二进制 Open With fallback 仍是后续 TODO。后续成功输入或资源变更清除错误。旧的异步请求失败或成功都不能覆盖新输入。

验收：

- [x] 打开失败时，编辑器保持打开，用户能看见本地化的读取/解码错误和 Retry。
- [x] 图片错误通过 `role="alert"` 暴露；音视频错误通过 `role="alert"` 与 Retry button 暴露；重试成功与失败受 generation/input 所有权保护。
- [x] retry、切换输入、关闭 Pane 不留下旧 URL 或播放；测试断言 pause → 清除 src 后 load → revoke 的释放顺序。
- [ ] 标准文本/二进制 Open With fallback 与 `ENOENT`/权限等具体错误区分仍未完成；目前显示泛化、已本地化的加载/解码错误。
- [x] 在真实 Mac Electron/Web 验证 Accessible View 元数据与帮助、可见错误/Retry 布局、实际 codec、播放与关闭时资源释放。系统读屏软件未在这组自动化中运行。

### P0：统一资源上限；超限前反馈

当前两个 Pane 都完整 `readFileBytes`，然后再创建 Blob；没有 Pane 自己的大小预检。App Server 当前 binary file endpoint 的上限是 50 MiB，`AppServerFileSystemProvider` 逐 256 KiB 读取 `resourceId` 并在 `finally` release；但 Browser `HTMLFileSystemProvider.readFile` 和 Node `DiskFileSystemProvider.readFile` 的 `readFileBytes` 目前没有同样上限。后者会把大资源整体拉进 Renderer。`appServerFileSystemProvider.ts` 还注释说 preview panes 会设更小的上限，但当前 Preview owner 中没有这道检查。

方案选择（本次不加预算常量，先由 owner 根据实测决定）：

1. **统一单文件字节上限**：先 `stat` 再读，并验证实际 `bytes.length`；明确每个 provider 都一致拒绝超限。App Server 现有 endpoint 为 50 MiB，但这只能作为已有协议的最大接受值，不能据此断言它对 Renderer 内存安全或用户体验合适。
2. **按媒体种类设独立预算**：图片要把压缩字节数、解码像素数/位图驻留算开；音视频通常含解码器/浏览器缓冲，也不应只比较文件大小。每个阈值都需以可复现的目标设备/浏览器内存数据论证。
3. **提供有界流式读取或渐进 URL**：避免 Browser/Node provider 为一次预览把超大对象整体 `arrayBuffer()`；但浏览器媒体的可 seek/play 语义、对象 URL 生命周期和现有 provider API 需另作设计。

验收：在选定预算后，超限资源显示 Pane 内的可访问错误且不创建/保留 URL、不启动解码/播放；Browser、桌面和 App Server provider 的行为一致；测试包含阈值边界和读回 bytes 大于预估值的情况。图片像素预算与字节预算分别声明/测试。若本轮未做预算决策，这组能力继续留 TODO，不让首次失败恢复工作顺手引入平台级限额。

### P1：图片缩放交互对齐

现有工具栏/键盘缩放完整覆盖基础需求。上游额外支持按级别缩放、点击/修饰键滚轮缩放、保留 viewport 中心/滚动偏移、10%–2000% 范围和高倍率像素化。本轮建议保留 Ash 的既有工具栏、`+/-/0/1` 与键盘可达性；补齐滚轮/触控板缩放（按平台修饰键），缩放后维持鼠标/视口焦点附近内容位置，持续展示倍率。若要加入像素化/扩格式，单独测量并以具体验收需求为准，不机械复制上游 Webview/status bar 架构。

验收：Fit、Actual size、Zoom in/out、resize、触控板/滚轮；缩放在 1%–1600% 范围内且无 NaN/Infinity；滚动位置稳定；键盘用户可完成等价操作，Accessible View 和可见 summary 同步倍率。

### P1：格式清单可见且失败可解释

Ash 当前图片仅处理 PNG、JPEG、WebP；上游清单另包含 BMP、GIF、ICO、AVIF、SVG。Ash 使用 `createImageBitmap` 并刻意不允许 SVG，避免把可执行/复杂文档内容直接变成预览；这属于有意义的安全边界。首版不扩大图片格式，除非给出具名的格式和安全实现方案。音频/视频沿用当前 MP3/WAV/OGG/OGA、MP4/WEBM 能力。

验收：不支持的图像扩展或错误 MIME/签名组合给明确错误，不能交给浏览器对任意原始文件做类型猜测；格式清单、帮助文案、manifest selector 与格式测试同步。

## 完整用户流程

### 图片

1. 用户从文件浏览器打开 PNG/JPEG/WebP，或从 “Open With” 选择 Image Preview。按 selector 选择 Pane；文件仍是原始资源。
2. Pane 通过 `IFileService` 读取字节并验证文件签名，解码取得尺寸，创建唯一短期预览 URL；默认 Fit，显示文件名、像素尺寸、格式、字节数和 zoom。
3. 用户用工具栏、`+`/`-`、`0` Fit、`1` Actual Size、viewport 滚动和缩放手势查看图片；Accessible View 给出元数据而不虚称图片描述。
4. 若读取、解码或容量检查失败，Pane 呈现错误和恢复动作；当前已提供 retry 或关闭。标准文本/二进制 Open With fallback 仍未实现。
5. 文件被外部修改时重新读取；成功后换 URL 并撤销旧 URL，失败时不显示过期图像、保留文件引用并显示错误；再次修改可恢复。
6. 用户切换/关闭 Pane 或用 Accessible View 离开时，异步取消不允许旧结果覆盖；关闭时释放 URL 和解码器资源，原文件保持不变。

### 音频 / 视频

1. 用户打开受支持扩展名，默认用 audio/video preview；错误扩展由 Open With 可选择时也必须面对后端实际内容和解码失败。
2. 用浏览器控件播放/暂停、seek、音量、全屏（浏览器支持时）。默认绝不 autoplay；自然加载 `metadata`，文件变化重新加载。
3. 不支持 codec、损坏内容或读取失败时，错误在 Pane 内可见且可被辅助技术读取，可重试或重新打开标准文本/二进制编辑器。
4. 切换离开立即 pause；关闭 Pane 时先 pause 并移除/重载 src，再撤销 URL；重复打开、并发切换和重新打开都不播放旧资源。

## 真实文件与资源读取路径

Preview 不应自己拼接 filesystem path、读 `fetch(file://...)` 或创建第二份存储。真实 Workbench 入口在 `workbench.ts`：`IFileService` 的 `file` scheme 由当前 Browser Filesystem Access provider 或 `AppServerFileSystemProvider` 服务，`ashRemote` 由 App Server provider 服务。Pane 调 `IFileService.readFileBytes(resource)`。

Workspace App Server 路径为：

`ImagePreview/MediaPreview → IFileService.readFileBytes → AppServerFileSystemProvider.readFile → fs/readBinaryFile(dirId, workspace-relative path) → ResourceMetadataResult → resource/read chunks → resource/release → Blob URL`。

`fileTarget()` 要求 URI 属于当前 workspace folder；后端以 `Permission::ReadFiles` 和 folder id/path 授权。读取的 resource ID 是连接 scoped 的临时句柄，不是永久文件身份；当前后端 50 MiB 上限，resource lease TTL 5 分钟。关闭 Pane 可停止其等待和防旧渲染，但前端 `IFileService.readFileBytes` 没有取消参数，正在进行的后端 read 可能完成后才 `finally release`；验收关注最终 release、不产生 URL 和无旧 UI 更新，不声称能取消 Rust 读请求。

建议在本模块测试中用 `FileService + AppServerFileSystemProvider` 合成夹具串起资源 id、分块 bytes、offset 校验和 release 计数，确保 Pane 真调用服务而非绕过到浏览器直读。该夹具测试的是 Ash 前端真实 provider 边界；Rust `fs/readBinaryFile/resource/read/resource/release` 契约已有 `crates/app-server/src/server/fs_operations.rs`、`server/operations.rs` 与 `server_tests.rs` 测试。若要改 AgentHost/App Server provider 或协议，先与 AgentHost owner 协调，本模块方案不依赖那类共享改动。

## 文件 owner 与依赖边界

- 主要生产 owner：
  - `src/ash/workbench/contrib/mediaPreview/browser/imagePreview.ts`
  - `src/ash/workbench/contrib/mediaPreview/browser/mediaPreview.ts`
  - `src/ash/workbench/contrib/mediaPreview/browser/mediaPreview.contribution.ts`
  - `src/ash/workbench/contrib/mediaPreview/browser/media/{imagePreview.css,mediaPreview.css}`
  - `extensions/media-preview/package.json`、`package.nls.json`、`package.nls.zh-CN.json`
- 主要测试 owner：
  - `src/ash/workbench/contrib/mediaPreview/test/browser/imagePreview.test.ts`
  - `src/ash/workbench/contrib/mediaPreview/test/browser/mediaPreview.test.ts`
- 只依赖既有契约：`IFileService`、`EditorPane`、Accessible View、`ImageResource`。
- `src/ash/platform/media/browser/image.ts` 的 `ImageResource/inspectImage` 供 Workbench、Design/Creator、Library 共用。首轮尽量不改；若格式解码契约需要变化，先评估其他消费者和 ownership，另开协作依赖。
- 不编辑 `AppServerFileSystemProvider` / App Server 协议与后端、Workbench Editor tab 保存 owner，或已在改动中的 Search/Preferences/Trace/SCM/Output/Notifications/AgentHost。若测试只需依赖实际接口，不因此修改这些 owner。
- 不把 Image Preview 的状态或 DOM 放进 `base`；不要复制 VS Code extension 的 Webview、遥测、外部路径或 status bar 实现。

## 验证矩阵

### 单元/服务测试

用仓库 pnpm 脚本运行模块测试，并按需对相邻服务契约运行 targeted tests：

```sh
pnpm test:unit --run src/ash/workbench/contrib/mediaPreview/test/browser/imagePreview.test.ts --run src/ash/workbench/contrib/mediaPreview/test/browser/mediaPreview.test.ts
```

代码实现及 selector/NLS 更新后，再运行所属静态检查：`pnpm typecheck:renderer` 与 `pnpm typecheck:extensions`。如 UI/媒体解码路径变更，跑仓库 Browser / Electron Playwright smoke 项目（`pnpm test:smoke:browser`、`pnpm test:smoke:ui`）；只有 provider/backend owner 改动才加跑对应 AgentHost/App Server 目标测试，不能把这些 targeted checks 描述为全仓验证。

新增或更新测试至少覆盖：

- 普通输入、不同编辑器匹配、错误签名/MIME、损坏/截断图片、浏览器 decode error。
- [x] 图片和音视频首次 read 失败、retry 成功；图片 decode failure retry；旧失败/旧媒体事件、关闭时 late failure 和取消竞态。
- [ ] 首次文件测试当前使用假 `IFileService`；另需合成 `FileService + AppServerFileSystemProvider` 的真实前端 provider 边界集成测试。
- 超限输入在 read/decode/URL 前拒绝，大小边界与媒体错误可访问。
- 读取/解码过程中切换新文件、取消 signal、关闭 Pane、同资源连续 change；late completion 不更新 UI、不会遗留 URL、ImageBitmap close 一次。
- Audio/Video 播放时隐藏/关闭；顺序断言 `pause → src cleared + load → revoke`；重新打开后无旧播放。
- 模拟真实 `IFileService` + `AppServerFileSystemProvider` 的 `readBinaryFile → chunk read → release` 成功/错误流程；验证授权资源/路径由 provider 边界负责，Preview 没有直接路径读取。
- 中文 NLS 和无障碍状态/恢复动作同步。

若改了用户可见文案，更新两份 media-preview NLS 文件，并用 `zh-CN` 断言。单元测试覆盖 DOM、状态、listener/disposable 和资源顺序；测试断言优先于 screenshot。

### Web / Electron 浏览器场景

只有改动会影响实际 editor 注册、CSS 几何、原生浏览器 codec、文件 provider 或媒体控制时，跑 Playwright Browser 和 Electron UI 的对应场景。至少用固定小型本地样本走一次“打开图片 → Fit/Actual/Zoom → resize → error/reopen”、一次“打开音视频 → 播放/隐藏暂停/关闭释放”。如果更改未触及外观/媒体解码，只跑上面的 targeted 单元测试与受影响的 typecheck/build，不机械跑全 UI。

截图仅在用户可见布局或视觉状态发生改变时采集，覆盖 Fit/Zoom/失败提示/音视频控制中实际改动的页面；截图是审核材料，不是测试 oracle。录像只在需要审查交互时序（例如切换时停止播放、缩放手势/滚动位置、长异步失败恢复）或明确要求演示时录制；不为单纯代码修复生成无关录像。使用仓库现有 Playwright，不安装新的重依赖。

## VS Code 上游证据

上游 SHA 固定为 `ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5`：

- [扩展贡献、支持格式与命令 selector](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/package.json)
- [三个 preview 的注册入口](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/src/extension.ts)
- [共享 panel 生命周期、watcher 与资源根约束](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/src/mediaPreview.ts)
- [图片 manager、命令、缩放与 pane 生命周期](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/src/imagePreview/index.ts)
- [图片加载失败/Git LFS/文本 fallback、CSP 与缩放实现](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/media/imagePreview.js)
- [音频 owner](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/src/audioPreview.ts) 与 [音频 UI 错误/播放就绪状态](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/media/audioPreview.js)
- [视频 owner 与 autoplay/loop 配置](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/src/videoPreview.ts) 与 [视频 UI 错误/加载状态](https://github.com/microsoft/vscode/blob/ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5/extensions/media-preview/media/videoPreview.js)

VS Code 是基于文件 URL 的 Webview 扩展：限制 `localResourceRoots`、禁 forms、采用 nonce 和 restrictive CSP，以 `asWebviewUri` 加载文件；音/视频通过 browser 元素与配置控制，图片用独立 Webview 脚本管理滚动/缩放。Ash 是内置 Workbench Pane，采用现有 FileService provider 和 Blob URL，所以对齐的是职责、错误/恢复、用户操作和生命周期契约，不是上游的扩展/Webview 技术方案。

## 云端实现验证记录

- Red：临时恢复两个 Pane 生产文件到基线后，定向首次失败/重试、解码恢复、旧媒体事件和取消用例共 7 项失败（符合预期）；“关闭时未完成读取”用例通过。测试前在当前 worktree 生成所需 protocol/NLS 产物，没有从其他树复制协议文件。
- Green：`pnpm test:unit --run src/ash/workbench/contrib/mediaPreview/test/browser/imagePreview.test.ts --run src/ash/workbench/contrib/mediaPreview/test/browser/mediaPreview.test.ts` 通过；Mocha 共 17 个测试、0 个失败文件，运行器自身回归 5/5。
- `pnpm typecheck:renderer` 退出码 0；`pnpm stylelint` 检查 263 个 CSS 文件、0 errors/0 design suggestions；`prettier --check`、`git diff --check`、中文 locale JSON parse 均通过。
- 没运行 `pnpm typecheck:extensions`（本次未改 extension manifest/selector）、Browser/Electron Playwright smoke 或 Rust tests；目标设备的真实媒体 codec 和播放行为尚未验证。
- 独立工作树从 `dd086508b8c0eabe5931793302e8f7dc3d7a47b3` 起始；原 AgentHost 活跃树中的 mediaPreview 相关生产路径保持未修改。无提交、无 push。

## macOS 本地产品验收（2026-10-08）

- 同一独立工作树 `/Volumes/1t/ash-media-preview-20261008` 正常 fetch/rebase 到 `e05e17e93c26f0281357ff9aca53bea8aaf98a67`。消费时保存的 58060 字节补丁 SHA256 为 `1fc6c54819057e52880a61ffea4812bdd5be6839c50618cd1fd21d5ad14df4a7`，8 文件目标 blob 全部匹配；后续仅补充 smoke 与本验收记录，生产实现保持所给补丁。
- 本树生成 protocol/NLS、安装独立依赖；正常 Desktop/Web backend prepare、Desktop、离线及连接 Web production build 均成功。Cargo 最终按 jobs=1，未复制其他树 Cargo/runtime/protocol 产物。
- 两种后端包均通过现有 package validator、sourceDigest 校验及隔离 HOME/profile/workspace 下的真实 stdio initialize；major/schemaHash 精确匹配本树生成契约。
- 定向模块单测 17/17，运行器回归 5/5；renderer、automation 类型检查通过。263 CSS stylelint、所属 JSON/CSS/Markdown 与 TypeScript 格式检查通过。
- 两个现有 media smoke 文件共 5 项（2 项既有、3 项新增），在 Browser UI、Browser App Server、Electron App Server 三个产品项目各 5/5 通过，没有跳过。本组不使用系统剪贴板、真实 OS 菜单、CUA 或 OS 窗口激活断言；每测使用现有隔离 harness，workers=1、自动端口、任务独立 output/HTML。验收期间未在同一树运行 build/watch/clean。
- 使用真实 PNG/JPEG/WebP、PCM WAV 和 VP9 WebM，验证首次 read 失败后键盘 Retry、损坏图片/视频恢复、Fit/Actual/Zoom、播放/暂停/seek/volume、切换时暂停、旧播放器 error、迟到读取与关闭释放。连接项目的图片、媒体与关闭中读取证据分别记录 4/4、5/5、1/1 个 URL 创建/撤销，以及 6、5、2 个后端资源 release；最终均无存活 lease。
- Electron 首轮发现测试竞态：修复文件后，显式 Retry 与合法 watcher 刷新可发生在两次远程断言之间。旧事件断言改为同一 DOM 回合内精确比较 source 与错误区，再验证最终解码成功；未增加 timeout 或放宽预期。生产实现无需改动。离线 Browser 曾误用连接 Web 产物，按正常离线 build hooks 重建后通过。
- 每个最终项目保存 8 张失败/恢复/缩放截图及 4 份生命周期/旧事件 JSON；原失败 trace 保留在 `.build/media-preview-evidence`。完整命令、退出码、包身份与附件清单位于同目录，供本地审阅。未运行 Rust 全仓检查或系统读屏软件，未推送。

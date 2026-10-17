# 媒体与本机通话交付

本机负责音视频、屏幕和识别；远端负责文件、终端和 Agent。媒体源码归现有领域 crate，
不再提供 `extensions/media` 扩展或通用媒体 Provider。

| 本机程序             | 源码归属                                                        | 职责                           |
| -------------------- | --------------------------------------------------------------- | ------------------------------ |
| `ash-livekit-client` | [`crates/livekit-client`](../crates/livekit-client)             | 加入房间、音视频传输和屏幕共享 |
| `ash-realtime-voice` | [`crates/realtime-voice`](../crates/realtime-voice)             | 本地模型加载与识别             |
| `ash-voice-host`     | [`crates/voice-host`](../crates/voice-host)                     | 麦克风、扬声器和音频设备       |
| `livekit-server`     | [`livekit-server/runtime.json`](../livekit-server/runtime.json) | 显式部署本机通话服务           |

前三个程序仍合成一个媒体交付归档，保持现有安装缓存和发布流程；这不合并它们的业务状态。
Desktop 随包提供这些本机程序；独立本机宿主首次使用时安装。各程序仅在实际请求时启动。
LiveKit Server 继续独立分发，只在创建本机主持的通话时安装。

LiveKit 上游版本、校验和及版权记录保留在 [`third_party/livekit`](../third_party/livekit/README.md)，
上游程序和 Go 编译缓存位于忽略的 `third_party/.cache/livekit`。macOS 源码构建使用 `-ldflags="-s -w"`；
其他目标使用锁定并校验的上游产物。Go 工具链不随产品分发。

## 构建独立包

使用仓库锁定的 Python 工具环境执行以下命令，目标默认当前平台；可用 `--target` 显式选择。
输出目录必须不存在。媒体包仅支持已锁定 Sherpa ONNX 的目标，目前不包含 musl。

```sh
scripts/.venv/bin/python -B build/release/capabilities.py build \
  --kind media --package-dir dist/ash-media \
  --archive-dir .build/releases --descriptor-file dist/media.json
scripts/.venv/bin/python -B build/release/capabilities.py build \
  --kind livekit --package-dir dist/ash-livekit \
  --archive-dir .build/releases --descriptor-file dist/livekit.json
```

`build/app_server.py` 为独立本机宿主默认选择 `--media-distribution optional`，将媒体与
LiveKit 下载描述写入 `ash-resources/capabilities/{media,livekit}.json`。
`build/remote.py` 固定使用 `--media-distribution none`：不构建媒体与 LiveKit 附件，也不携带它们的下载描述，
并拒绝媒体目录、下载 URL 和辅助程序覆盖参数。Remote 发布不安装音频、识别或屏幕构建依赖。
Desktop 构建显式选择 `--media-distribution bundled`：主包携带 `ash-livekit-client`、`ash-realtime-voice`、`ash-voice-host`，
仅保留 LiveKit 下载描述，不生成媒体下载附件。两种模式的文件均纳入主包完整清单与身份。
传入 Desktop 的 `--backend-package` 也必须按 bundled 模式构建，转换器会拒绝缺少媒体的后端。
`--media-package-dir`、`--livekit-package-dir` 控制独立目录；`--capability-archive-dir` 控制归档位置。
Desktop 将归档保存在 `.build/releases`，避免删除 Electron 临时 staging 时丢失附件。

每个归档名为 `ash-<kind>-<build-id>-<target>.tar.gz`，内容包括不可变 `ash-package.json`。
归档确定性地生成；描述绑定精确目标、build ID、大小和 SHA-256。
正式构建默认使用本仓库对应版本的 GitHub Release URL。`--media-package-url`、`--livekit-package-url`
可覆盖产品构建下载端点；独立构建命令使用 `--url`。只接受不含凭据、查询参数或 fragment 的 HTTPS URL。

开发构建通过 `--cargo-profile dev-small` 选择调试配置；按需包没有 URL 覆盖时，描述引用独立本地目录，
在不访问网络的情况下验证同一安装流程。独立附件通过主包绑定的精确摘要与身份验证；
现有主产品系统签名步骤不等同于逐一给附件做系统签名。不可在绑定完成后修改附件字节。

## 发布配套附件

本机 Code 与 App Server 可以引用相同的独立附件，也可以绑定不同构建。Remote 不引用媒体或 LiveKit 附件。
Desktop 仅引用 LiveKit 附件；发布校验另外确认随包的媒体程序完整、摘要正确且没有媒体下载描述。
附件必须与引用它的主包一起发布；独立打包不代表独立升级到未经该主包绑定的版本。

```sh
scripts/.venv/bin/python -B build/release/capabilities.py stage \
  --package-dir .build/releases/runtime-aarch64-apple-darwin \
  --package-dir .build/releases/ash-code-aarch64-apple-darwin \
  --archives-dir .build/releases --output .build/release-artifacts/aarch64-apple-darwin
```

该命令按产品文件清单绑定的描述定位附件，不通过 glob 选择任意旧包。它验证归档大小、摘要、
内部 target、能力类型、build ID 和完整内容清单，去重后收集精确文件。缺包、开发目录描述、
篡改或文件名冲突会在复制前失败。多个归档目录可重复传入 `--archives-dir`。

macOS/Linux 的 `platform-checks.yml` 与 Windows 的 `release-windows.yml` 在所有最终产品完成后执行该检查，
包括 Desktop 实际引用的附件，再交给已有 Release 上传作业。整理或验证流程本身不会创建 GitHub Release。

## 首次使用与离线安装

Desktop 安装后可直接使用随包媒体，无需下载或创建 profile 的媒体安装目录；媒体进程仍按资源请求启动。
独立本机 App Server 首次设备/媒体请求才安装到 `$ASH_HOME/capabilities/media`。
本机产品仅在主持通话时安装 `$ASH_HOME/capabilities/livekit`；Remote 不安装它。
语音选择器主动枚举设备也算媒体请求。云听写使用客户端传入的 PCM 时不需要本机媒体包。
普通远程连接、重连、文件编辑及文字 Agent 不会触发安装；听写或加入外部房间不会安装 SFU。
本地模型准备/导入仅在验证推理时需要媒体包，模型下载缓存继续由原有模型服务管理。

下载使用发起能力请求的 profile 和出站策略，保留代理、TLS、重定向与大小限制。跨进程锁使并发窗口
复用同一次安装；下载和解包校验通过后才由 PackageStore 原子发布。失败保留旧版本，下次请求可重试。
运行中的资源持有包租约，重连使用同一代次；旧进程的房间和推理操作不会被重放。

`ASH_MEDIA_PACKAGE` 可选择已验证的绝对媒体包目录；`ASH_LIVEKIT_PACKAGE` 选择首次主持时安装的离线目录，
安装会保留源目录。`ASH_LIVEKIT_CLIENT_PATH`、`ASH_RECOGNIZER_PATH`、`ASH_VOICE_HOST_PATH`、`ASH_LIVEKIT_SERVER_PATH`
继续作为明确的开发可执行文件覆盖。默认产品路径无需这些环境变量。

各本机程序复用现有 SDK 数据通道与进程监管；首次启动不会自行打开设备或加入房间。
通话和识别分别注册 `livekit.v1` 与 `recognition.v1`，不提供跨域调用入口。
重依赖只由对应 crate 的 `host` feature 启用。构建器分别编译这些程序与基础 App Server，
避免 Cargo feature 合并把 RTC、屏幕或 ONNX 实现链接回基础后端。
Desktop 的通话、听写和本地模型操作始终使用本机连接；SSH 工作区使用远端连接处理文件、终端和 Agent。
LiveKit Server 的选择和安装入口由 [`crates/call`](../crates/call/src/deployment.rs) 的
`LocalDeployment::livekit_server` 拥有；媒体客户端不依赖通话部署。两者复用
[`crates/package-store`](../crates/package-store) 的可选 `installation` 功能，统一下载校验、
安装锁和原子发布，沿用现有 profile 缓存与包身份。

## 验证入口

```sh
just test-python build
just test-python scripts
just verify ash-package-store --features installation
just verify ash-call --features runtime
just verify ash-livekit-client
just verify ash-livekit-client --features host
just verify ash-realtime-voice --features host
just verify ash-realtime-voice
```

`crates/livekit-client/tests/hosting.rs` 另有显式忽略的真实用例：验证 Desktop 在出站网络被拒绝时直接使用随包媒体，
以及读取 Remote 主包绑定的 HTTPS 归档，在指定 profile 首次下载，
复用缓存、枚举屏幕源并加入真实 LiveKit 房间。用例声明了所需环境变量；TLS 使用测试 CA，不修改系统信任库。
`tests/rooms.rs` 和 `crates/voice-agent/tests/bridge.rs` 覆盖真实音频、权限、静音、重连清理及 Agent 取消。
这些合成音频用例不证明物理麦克风、实际屏幕帧捕获或真实模型听写已验证。

# `ash-remote-connections`

`ash-remote-connections` 是 `app`、Desktop Main 和其他原生产品可复用的本机 Remote backend
连接层。它负责构造本机 OpenSSH 子进程命令，为 `ash-app-server-client` 提供 Remote App Server
stdio backend，并提供 POSIX 平台探测、
不可变完整包安装、发布认证后的网络制品物化、无凭据运行时代际存储和命名目标目录。它不负责
Renderer 状态、SSH 凭据、发布频道/签名策略、产品配置档案位置、激活时机或远端领域服务。Electron Main 通过本机
`ash-remote install` 命令委托安装，同时保留自己的窗口和进程协调器。

跨产品行为与当前阶段以 [`docs/remote-development.md`](../../docs/remote-development.md) 为准；本文只
拥有该 crate 的精确实现契约。

## 契约

`SshAppServerConnectionOptions` 持有一个 `RemoteProfile`、产品选择的本机 SSH 可执行文件和非零连接
超时。`connect` 启动：

```text
ssh -T -o BatchMode=yes -o ConnectTimeout=<seconds> <host> <remote command>
```

`remote_app_server_command` 独立引用每个 POSIX shell 参数，只传递 `ASH_WORKSPACE_ROOT`、选中的运行时
可执行文件和 `connect`。该命令把标准输入输出代理到按工作区复用的远端守护进程；SSH
仍由本机产品宿主持有，可在不替换远端 App Server 的情况下替换传输连接。

选中的运行时提供 `ash-remote-server` 的命令契约。连接层使用产品指定的精确可执行路径。产品协调器可另行调用
`SshRemoteRuntimeInstaller` 安装完整的 packaged-node Ash 分发包，再用返回的精确可执行路径创建新
配置档案。

`SshAppServerConnectionOptions::probe_runtime` 是产品协调器的可用性检查。它以相同超时执行非交互
SSH 命令，在 `command -v` 成功时返回请求路径和解析后的精确路径。运行时不存在会返回
`RemoteConnectionFailureKind::RuntimeUnavailable`，SSH 或进程错误仍属于 `Transport`。可执行文件
存在不代表协议兼容；`SshAppServerConnectionOptions::probe_compatibility` 会启动短生命周期 App
Server，执行 canonical initialize/schema 协商，捕获 `InitializeResult`，然后在发出 Session、Thread、
文件系统或终端操作之前关闭 SSH 子进程。

本机宿主持有 OpenSSH config、agent socket 和凭据。任何配置档案字段或远端命令都不包含密码或
私钥。

## 运行时安装契约

`SshRemoteRuntimeInstaller::probe_platform` 把 POSIX `uname` 和 Linux libc 探测映射为六个 canonical
macOS/Linux package target。当前 POSIX 实现拒绝 Windows OpenSSH 远端。
`RemoteRuntimeArtifact` 把本机 rootless `tar.gz` 绑定到产品发布目录提供的可信版本、target、压缩
大小、展开大小和 SHA-256。`RemoteRuntimeCatalog::load_verified` 是共享的本机发现边界：它先用产品
宿主已认证的摘要校验完整目录，再拒绝未知字段、重复 target 和逃逸 archive 路径，最后为每个平台
公开至多一个精确制品。该方法自身不建立 publisher provenance。

`RemoteRuntimeCatalogRelease` 表达由签名产品发布认证的精确 `HTTPS catalog.json URL + SHA-256`，
不是接受任意 URL 的下载许可。`RemoteRuntimeCatalogUpdater` 通过共享 `ash-http-client` 直连公共
Internet，拒绝重定向、URL 凭据、query、fragment 和私网解析；catalog 限制为 1 MiB，artifact
压缩大小限制为 1 GiB、声明展开大小限制为 4 GiB。它把目录和 artifact 写入
`<cache>/remote-runtime-catalogs/<catalog-sha256>/`，缓存命中仍重新验证完整 archive。新下载先进入
同目录临时文件，完成精确长度、SHA-256、tar entry、package metadata 和展开大小检查后才原子发布。
缓存根及其 generation 子目录拒绝符号链接。`fetch_for_with_client` 只用于注入产品 transport 或确定性
测试，不减弱上述摘要、路径和 archive 检查。

SSH 启动前，`open_and_validate_artifact` 检查本机精确大小和摘要，拒绝绝对路径、非规范路径、重复
entry、链接和特殊文件，并验证声明的展开大小。制品必须采用 layout version 2，包含 `bin/ash-app-server`、`bin/ash-remote-server`、`bin/ash-app-server-daemon`、
`ash-path/rg`、`ash-resources/tgrep/tgrep` 和 packaged Node。远端脚本在解压前再次检查压缩大小和 SHA-256，在最终目录的同级
staging 中工作，可恢复陈旧 PID 锁，最后提交到：

```text
<user-data>/ash/remote/runtimes/<target>/<version>/<archive-sha256>/
```

最终目录包含完整 canonical package 和摘要 receipt；重复安装同一对象是幂等操作。这里没有可变
`current` symlink。升级激活必须先通过 App Server handshake，再保存新返回的 `RemoteRuntime`；回滚
则选择上一代精确路径。本 crate 只提供有界 active/previous 持久化，产品协调器决定何时激活、回滚
或清理不可变对象。

`SshRemoteRuntimeInstaller::install_with_progress` 与私有函数 `progress::upload_archive` 在宿主线程上
同步报告本机校验、平台探测、上传字节数、远端提交和 installed/reused 结果。`install` 是不带观察者
的便捷入口。回调不拥有策略且必须保持非阻塞；Electron Main 使用
`ash-remote install --progress json-lines` 作为进程边界。Desktop Main 把该进程绑定到自己的
`AbortSignal` 和 Workbench 前准备窗口；取消由产品宿主终止本机 CLI/SSH 生命周期。本 crate 的远端
脚本以 `trap` 清理未提交 staging 和安装 lease，且只有最后一次原子 `mv` 会发布 runtime，因此取消
不能让不完整对象成为可选 runtime。

远端宿主不会下载制品。SHA-256 只证明传输与内容身份，不证明发布者来源；本机产品必须在构造
`RemoteRuntimeCatalogRelease` 或 `RemoteRuntimeArtifact` 前认证发布元数据。打包后的 `app` 可把
目录 URL 与摘要编译进已签名二进制；Electron Main 从签名 Desktop 产品包读取同一 URL 与摘要。
离线产品包仍可直接认证本地 catalog。共享 updater 只负责安全物化，不选择 channel、版本升级时机或
publisher key。

## 连接配置档案契约

`RemoteConnectionCatalog` 是用户意图目录，与运行时代际历史分开。每个
`RemoteConnectionEntry` 只含 canonical `RemoteConnectionName` 和一个 `SshTarget`，不包含运行时、
SSH executable、任意 option、密码、私钥或 agent socket。使用 canonical 本机配置档案根的产品将
它存到 `<local-profile-root>/remote/targets.json`。`save` 必须显式接收
`RemoteConnectionSaveMode`，因此 create 不会静默覆盖已有名称。

`connection`、`connections`、`save`、`update` 和 `remove` 都先取得同级 advisory lease，再校验完整
的有界版本化文档。`update` 通过原名称定位已观察记录，可原子改名但不能覆盖另一 canonical 名称。
名称是大小写不敏感的 canonical ASCII 命令行身份；格式错误或 canonical 后重复的名称会使完整读取
失败。

目标目录回答“用户要连接哪台主机和哪个工作区”；下述运行时配置档案回答“哪个精确运行时代际已
通过该目标的最近一次兼容性握手”。两份文档分离后，安装和回滚无需重写用户命名连接。

`ash remote connections list|get|save|update|remove` 是不能直接链接本 crate 的产品宿主所使用的稳定
JSON 进程边界。Desktop Electron Main 用 `list` 提供展示，以 `save/update/remove` 承接严格限定为
name、host 和工作区路径的图形管理请求，并在安排产品重启前按 canonical name 再执行一次精确 `get`。
图形 `save` 固定为 create，Renderer 不能请求 replace；连接动作不能提交 host 或工作区，任何动作都
不能提交凭据或 OpenSSH option。`app` 直接链接目录实现，但保持相同记录语义。

`RemoteConnectionProfileStore` 按精确 `SshTarget`（OpenSSH host 与远端工作区）保存一个
`RemoteConnectionProfileRecord`。记录只含 active `RemoteRuntime` 和至多一代 previous runtime；
JSON schema 明确没有密码、私钥、SSH 路径、agent socket 或任意 SSH option。调用方决定资源位置，
`app` 当前使用 `<local-profile-root>/remote/connections.json`。

每次读写都先在 `acquire_lease` 取得同级 advisory lock；随后 `load_unlocked` 校验完整的版本化、有界
文档。`write_unlocked` 编码 `ProfileDocument` 并委托 `ash_utils_path::write_atomically` 做替换。
symlink 或非普通文件、未知字段、重复 target、错误身份、重复 active/previous runtime、超大文档和
锁竞争都会失败即关闭。

产品必须只在完成可用性与 App Server 兼容性检查后调用 `activate`。激活不同路径时，当前 active 会
进入唯一 previous 槽位；幂等激活不会丢失该槽位。`rollback_to_verified` 在持有写 lease 时比较调用方
刚验证的 previous profile，避免另一个进程让调用方切换到未验证的运行时代际；它还保存验证期间解析
出的精确可执行路径。

`ash remote profile rollback` 把上述契约与可用性、兼容性探测组合起来。`app` 在进程内调用，
Desktop Main 则调用 CLI adapter；只有条件交换成功后，Desktop 才替换 App Server 连接。

## 执行路径

```text
app `AppServerHost` / Electron Main
  -> AppServerSession (shared Local/Remote contract)
  -> optional RemoteConnectionCatalog target selection
  -> product-authenticated local catalog or RemoteRuntimeCatalogRelease
  -> optional RemoteRuntimeCatalogUpdater content-addressed cache
  -> SshRemoteRuntimeInstaller (or the ash remote install adapter)
  -> exact immutable RemoteRuntime path
  -> product compatibility preflight
  -> RemoteConnectionProfileStore activation
  -> SshAppServerConnectionOptions::connect
  -> AppServerSession::start_stdio (canonical App Server client boundary)
  -> OpenSSH stdio
  -> Remote runtime remote-server connect
  -> per-Directory Remote Server daemon
```

连接启动后，`AppServerSession` 持有子进程生命周期、typed initialize/schema gate、请求配对和通知流。

`connect` 与 `probe_compatibility` 使用同一兼容性 gate。Schema mismatch 属于
`RemoteConnectionFailureKind::ProtocolIncompatible`，服务端拒绝属于 `ServerRejected`。产品协调器
因此可按 `probe_runtime -> probe_compatibility -> connect` 执行，并只在运行时缺失或显式协议不兼容
时安装。`app` 在打开原生窗口前执行该 preflight；常规 Agent 和终端连接仍进行自己的权威握手。

`app` 当前为 Agent、language 和每个 Remote terminal runtime 打开独立的本机 App Server 连接。
独立 language connection 避免慢 LSP 响应阻塞 Agent 和文件系统请求；未来 SSH pool 可复用逻辑连接
而不改变其生命周期。Agent 和 language 协调器分别执行 30 秒有界重连，在断开时拒绝命令和语言请求，
不会重放未知结果操作；恢复后分别重读持久 Session/Thread 状态或重新同步打开文档。Remote terminal
使用 App Server reconnect lease，经替换后的 SSH connection attach 原 PTY。本 crate 仍只负责一次
SSH 连接尝试，重试策略属于产品宿主。

`SshTunnelOptions` 是首个宿主侧 Tunnel primitive。它使用 `ExitOnForwardFailure=yes` 和固定
`127.0.0.1` bind address 启动 `ssh -N`。Desktop 有窗口级协调器；`app remote tunnel` 直接作为
前台命令使用 primitive，Remote app 窗口则通过 Native tunnel host 和管理器监督它。
`select_available_loopback_port` 在 OpenSSH 启动前立即释放临时 listener，因此端口竞争仍由
`ExitOnForwardFailure=yes` 权威判断。

`SshTunnelDiagnostics` 允许图形宿主丢弃 OpenSSH stderr，而前台 CLI 可继承它。
`SshTunnel::poll_readiness` 要求 OpenSSH child 保持存活，并在短暂稳定间隔前后两次确认选中的本机
loopback 端口可连接；probe 不发送应用数据，只证明本地 forward listener 已经建立，不保证远端
endpoint 后的应用已接受连接。产品宿主负责围绕 poll 设置超时和取消。Primitive 只尝试启动一次；
`ash-remote-host` 在此之上提供共享的取消、保留本机端口和 30 秒恢复策略。产品仍负责把这些
typed events 映射到自己的事件循环、状态投影和窗口生命周期。

## 失败语义

OpenSSH spawn failure、输出关闭、错误 JSONL 和无法配对的 response ID 都属于
`RemoteConnectionError::Transport`；schema mismatch 属于
`RemoteConnectionFailureKind::ProtocolIncompatible`。安装错误分别区分 transport、不支持的平台、
不可用或不可信制品、target mismatch、远端前置条件缺失、并发安装和远端拒绝。

更新错误在 SSH 启动前区分无效发布绑定、HTTP transport/status、catalog、cache、完整性和 archive
验证失败。任何失败都不会把临时下载发布成可安装 artifact；调用方只能拿到经过完整验证的
`RemoteRuntimeArtifact`。当前默认网络 client 明确直连公共 Internet，不读取代理环境。

运行时配置档案错误分为 unavailable、busy 和 invalid；命名目录还区分已存在名称和并发消失的 update
目标。本 crate 提供原子激活与条件回滚机制，但不决定 retry、upgrade 或 downgrade policy；产品
协调器决定何时允许每项操作。

## 扩展方向

发布频道发现、publisher 签名验证、协议不兼容升级策略、不可变对象垃圾回收和产品级
Tunnel/recovery policy 都属于本 crate 上层；共享的本机 Tunnel 生命周期协调位于
[`ash-remote-host`](../remote-host/README.md)。`app` 已通过 Native picker/manager 消费命名目录；Desktop 通过本机
`ash remote connections` adapter 提供命令面板 saved-host picker/manager，并通过重启进入选中的 authority。
`app` 同时通过前台 CLI 与 Remote 窗口 Native manager 消费 Tunnel primitive。Desktop Browser
与 Browser Automation 通过 Electron Main 的 Remote navigation adapter 自动为 loopback 顶层导航持有
窗口级 Tunnel lease；requested/load URL 映射和 Browser history 生命周期仍属于 Desktop，而不是本
crate。其他产品可以拥有自己的生命周期和 UI。

不得把 SSH 凭据或制品选择移入 `ash-remote`、App Server 或 Renderer state，也不得在本 crate 中
增加第二套 typed App Server protocol；连接复用 `ash-app-server-client`。

## 验证

```bash
cargo test -p ash-remote-connections
```

更新器的确定性 fake-HTTP、缓存复用/篡改、原子失败和 linked-cache 测试位于
`src/runtime_updater_tests.rs`；canonical archive 验证继续由 `install/artifact_validation.rs` 承担，
不得在产品 adapter 中复制一套较弱的下载后校验。`src/tunnel_tests.rs` 使用真实 loopback listener
覆盖 pending、稳定 ready 和 OpenSSH 提前退出。

## 本机管理入口

- 本 crate 提供 `ash-remote`，供 Desktop 与脚本调用。
- `probe`、`fetch-runtime`、`install`、`profile` 和 `connections` 由 `src/command.rs` 及其子模块适配。
- Ash Code 的 `ash remote` 子命令调用同一 `run_command`；交互式 `connect` 由 CLI 负责。
- 安装成功返回不可变包内 `bin/ash-remote-server` 的绝对路径。

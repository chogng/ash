# `app` 发布图与产品边界

本文拥有 `app` 的 package staging、签名顺序和 CI contract；源码 owner 与 workspace 迁移见
[`app-migration-plan.md`](app-migration-plan.md)，app crate 的实现 owner 见
[`app-rs/README.md`](../README.md)。

## 快速理解

根 `Cargo.toml` 是唯一 canonical Cargo build graph；`app-rs/Cargo.toml` 仍是 `app` 产品 package
和发布边界。Bazel 只读取同一个 root `Cargo.toml/Cargo.lock`，通过单一 `@crates` hub 生成 app
owned crates、shared backend crates 和 `app` 的 target graph，不再需要跨 workspace metadata
patch 或重复 product hub。

`app-rs/` 与 `ash-rs/` 仍保持物理目录和依赖 ownership 分离：app 可以依赖 shared backend，shared
backend 不得依赖 app/UI。workspace 是统一构建图，不替代产品架构边界；boundary script 和 CI
继续验证反向依赖不会出现。

| 层 | 当前 owner | 入口 | 状态 |
| --- | --- | --- | --- |
| Rust compile/test | Root Cargo workspace / app package | `cargo check/test --manifest-path Cargo.toml -p app` | ✅ |
| Source/manifest input graph | Bazel app package | `//app-rs:app_sources` | ✅ |
| App Rust target graph analysis | Bazel + patched `rules_rs` | `//app-rs:app` | ✅ |
| Package/signing input contract | `app-rs/packaging/*.json` | `//app-rs:app_release_inputs` | ✅ |
| Unsigned package staging | `build/app_rs/build.py` | `just app-package` | ✅ |
| Workspace boundary CI | Bazel | `bazel test //app-rs:app_ci --test_env=PATH` | ✅ |
| 平台签名和验证 | `build/app_rs/signing.py` | 包内 target 选择对应签名工具 | ✅ 平台不能由调用者另行指定 |
| Hermetic Bazel Rust compile graph | `rules_rs` + single `@crates` hub | `//app-rs:app` | ✅ 完整 app binary build 已通过 |

### 根级 Bazel 基础设施

当前根级 Bazel 层只拥有仓库通用的构建边界，不拥有具体产品的业务组合：

- [`MODULE.bazel`](../../MODULE.bazel) 固定 `rules_rs`、LLVM Rust toolchain、hermetic macOS SDK 和系统 Framework；
- [`.bazelrc`](../../.bazelrc) 禁止探测本机 Xcode，并按宿主系统选择 Linux/Windows 的 platform constraint；
- [`BUILD.bazel`](../../BUILD.bazel) 提供 `//:ash` 产品入口、`disable_xcode` 和宿主 platform 定义；
- `app-rs/BUILD.bazel`、`code/BUILD.bazel` 和各 crate 的 `BUILD.bazel` 继续拥有各自产品/ crate target。

当前不引入 Codex 专属的 RBE、Wine 或 workspace-root test launcher。RBE 需要真实的远程执行/缓存后端和 CI 凭证；
Wine 只有在 Linux 主机交叉运行 Windows 测试时才有价值；专用 launcher 只有在测试需要 Codex 式 workspace-root、runfiles
环境或特殊变量时才应增加。它们属于后续 CI 能力，不是本地 hermetic 构建的前置条件。

## 阶段顺序

```mermaid
flowchart LR
    A[Cargo check/test] --> B[Unsigned package staging]
    R[Canonical packaged-node runtimes] --> RC[Deterministic Remote catalog]
    RC --> A
    B --> C[Binary SHA-256 + optional embedded catalog digest]
    C --> D{Platform signer}
    D --> E[Signature record]
    E --> F[Native verification]
    F --> G[Publish artifact]
    H[Bazel boundary CI] --> A
    H --> B
```

### 1. Build

所有 app-owned crate 和 shared backend 通过根 `Cargo.toml` 解析。Bazel 的 `//app-rs:app` 使用同一份
Cargo metadata-derived dependency graph；package builder 只接受 Cargo 生成的 `app` binary 或
从 app package 构建它，它不从 `ash-rs` 的旧 Native target 取 binary。未显式传 `--target` 时，
source build 保持 Cargo 的原生 host 输出拓扑；显式交叉 target 才产生 target-triple 子目录。两者都遵循
`CARGO_TARGET_DIR`，并从 Cargo JSON artifact 消息取得真实 executable，不猜测 profile 输出路径。

### 2. Stage

```bash
just app-package \
  --package-dir /absolute/path/to/app-package \
  --runtime-package /absolute/path/to/shared-runtime \
  --app-bin /absolute/path/to/app
```

共享运行时包必须先由 `build/ash_rs/build.py` 生成，使用 `packaged-node` 和 release profile。
App 打包器验证它的目标平台与完整文件清单，再把 `app` 加入同一个包并重算 `ash-package.json`：

```text
app-package/
├── bin/app[.exe]
├── bin/ash-app-server[.exe]
├── bin/ash-app-server-daemon[.exe]
├── ash-resources/
├── ash-package.json
├── app-package.json
└── app-signing-policy.json
```

`app-package.json` 固定 product、target、profile、binary path 和 SHA-256；`ash-package.json`
记录共享运行时与 `app` 的完整文件清单。staging 拒绝覆盖已有目录，并把状态标成
`unsigned`。这一步不取得密钥、不签名，也不宣称 artifact 可发布。

需要支持只安装 app 的用户时，先运行 `build/app_rs/remote/bundle.py`，输入一个或多个
canonical packaged-node Ash package directory，再给 staging 追加
`--remote-runtime-bundle <bundle>`。builder 将 catalog SHA-256 通过
`APP_REMOTE_RUNTIME_CATALOG_SHA256` 编译进 app，并输出：

```text
app-package/
├── bin/app[.exe]
├── bin/ash-app-server[.exe]
├── ash-package.json
├── ash-remote-runtimes/
│   ├── catalog.json
│   └── artifacts/ash-<target>.tar.gz
├── app-package.json
└── app-signing-policy.json
```

staging 拒绝未包含 catalog digest 的 binary；sign/verify 再验证 binding，signature record 记录同一
catalog digest。由此平台签名认证 binary，binary 认证 catalog，catalog 认证每个 runtime archive。

也可以生成不携带 runtime archive 的网络包：

```bash
just app-package \
  --package-dir /absolute/path/to/app-package \
  --runtime-package /absolute/path/to/shared-runtime \
  --remote-runtime-catalog-url https://releases.example/ash/<version>/catalog.json \
  --remote-runtime-catalog-sha256 <catalog-digest>
```

此时 builder 把 URL 和摘要同时编译进 binary，`app-package.json` 记录
`url + sha256 + compiledIntoSignedBinary`，sign/verify 检查两者都存在于签名 artifact。package 不含
`ash-remote-runtimes/`；运行时由本机 updater 下载并完整验证，远端主机仍不联网取包。

### 3. Sign 与 verify

`app-rs/packaging/app-signing-policy.json` 是 release job 的输入，不是开发机默认行为：

- macOS 使用 `codesign` 和 `ASH_MACOS_SIGNING_IDENTITY`，验证后再打包/公证；
- Linux 使用 `cosign sign-blob`，签名文件和 binary digest 一起进入 provenance artifact；
- Windows 使用 `signtool` 和 `ASH_WINDOWS_SIGNING_THUMBPRINT`，签名时加入 RFC 3161
  SHA-256 时间戳，并验证 Authenticode chain；GitHub Release 应使用 Azure Artifact Signing 后执行
  `build/app_rs/signing.py record`，不把代码签名私钥下载到 runner；
- 签名 job 只能读取 staging 输出，不能重建 binary；verify job 必须重新计算 digest，并检查与
  `app-package.json`、signature record 一致；
- 声明本地 Remote bundle 时，sign/verify 必须重新验证 catalog、archive 和 binary 内嵌 digest；
- 声明网络 Remote catalog 时，sign/verify 必须验证无凭据 HTTPS URL、catalog digest 以及 binary 内嵌
  的 URL/digest；
- 本地 unsigned package 只用于开发和测试，release job 必须拒绝 `signing.status != verified`。

密钥、证书和 token 不进入仓库，不由 Bazel rule 参数传递；CI secret store 和平台 signer 是发布
系统 owner。签名证明来源和完整性，不替代运行时安全审查。

发布任务按顺序调用打包、签名和验证：

```bash
python3 -B build/app_rs/build.py \
  --package-dir /absolute/path/to/app-package \
  --runtime-package /absolute/path/to/shared-runtime \
  --remote-runtime-bundle /absolute/path/to/remote-runtimes

ASH_MACOS_SIGNING_IDENTITY="Developer ID Application: ..." \
python3 -B build/app_rs/signing.py sign \
  --package-dir /absolute/path/to/app-package

python3 -B build/app_rs/signing.py verify \
  --package-dir /absolute/path/to/app-package
```

macOS 和 Windows 还须对包内共享运行时执行 `build/ash_rs/sign.py`。Windows 沙箱程序由运行时签名脚本负责，App 签名脚本只签 `app.exe`，不会对它重复签名。App 的签名脚本在
签名或验证后刷新共享包文件清单；运行时签名脚本验证所有运行时程序及其系统签名，并重新记录
签名后的整包身份。Windows 使用外部签名服务时，先运行 `app_rs/signing.py record`，再运行
`runtime/sign.py --verify-only`。Linux 的 App 签名是独立签名文件，同样写入整包清单。

网络包的打包参数改用 `--remote-runtime-catalog-url` 与
`--remote-runtime-catalog-sha256`，两者必须同时提供。

Linux 使用 `APP_COSIGN_IDENTITY` 指向 cosign key。本地或自管 Windows runner 使用
`ASH_WINDOWS_SIGNING_THUMBPRINT` 选择已经安装在用户证书库中的代码签名证书；GitHub-hosted runner
由 Azure Artifact Signing 修改 binary 后运行 `build/app_rs/signing.py record`，重新验证签名并更新
metadata 和 signature record。脚本完成后，`app-package.json` 和
`app-signature.json` 都必须是 `verified` 状态，才允许进入 publish step。

## CI 契约

当前已经可以在没有平台签名环境的机器上验证结构：

```bash
bazel test //app-rs:app_ci --test_env=PATH
```

`//app-rs:app_ci` 同时运行 workspace boundary、package staging、release contract 和 signing state
transition tests。

`.github/workflows/platform-checks.yml` 在 macOS、Linux 和 Windows 的 arm64/x64 机器上检查各自的 app target，并运行平台打包契约与 Python 发布工具测试。`//app-rs:app_ci` 继续负责不需要签名环境的结构检查。

具体 CI provider 只需要把 Build → Stage → Sign → Verify → Publish 节点接入 secret store；平台由 `app-package.json` 的 target 唯一决定，调用者不能另外传一个平台。不要把密钥逻辑写入 `app-rs/workbench`、`zui` 或通用 Bazel Rust macro。

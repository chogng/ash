# 插件系统

> 物理位置：`ash-rs/plugin/`、`ash-rs/core-plugins/`
> Rust crate：`ash_plugin`、`ash_core_plugins`
> 当前状态：`ash-plugin` 已拥有 Plugin identity、manifest、path 与 package observation；
> `ash-core-plugins` 已拥有 local/Marketplace package store、durable authority、activation、lease 与远端 registry 接入；
> Connector 领域类型、目录发现、连接状态持久化和认证流程统一归 `ash-rs/ext/connectors`。
> App Server 已能从注入的 activation 自动接线 Connector 与 MCP，通用 OAuth
> PKCE/device 状态机、App Server control plane、Desktop/TUI 产品入口与 GitHub providers 已实现；
> PL4 的可执行 Editor Extension 本地安装/授权声明已实现，Host runtime 不由本 crate 拥有
> crate 实现契约：[`ash-plugin`](../ash-rs/plugin/README.md)、[`ash-core-plugins`](../ash-rs/core-plugins/README.md)
> 跨 package family 的 Marketplace source、共享验证与领域投影：[`core-plugins.md`](../ash-rs/docs/core-plugins.md)
> Connector account/lifecycle：[`connectors.md`](connectors.md)
> MCP runtime：[`mcp.md`](mcp.md)
> Skill runtime：[`skills.md`](skills.md)
> Config authority 与 runtime snapshot 接入：[`config.md`](config.md)
> Editor Extension 双轨系统边界：[`editor-extensions.md`](editor-extensions.md)
> 可执行 Host runtime 实现：[`ash-rs/editor-extension-host/README.md`](../ash-rs/editor-extension-host/README.md)

## 快速理解

Plugin 是可同时携带多种 capability 的集成 bundle。`ash-plugin` 定义并校验这个 bundle；
`ash-core-plugins` 聚合内置 Ash catalog 与其他来源，统一拥有安装、更新、启用、授权和 activation。
Marketplace 只是 Plugin 来源，Skill、MCP、Connector 等运行方不解释 Marketplace。

| 用户动作 | 系统发生什么 | 不会自动发生什么 |
| --- | --- | --- |
| 安装 Marketplace Plugin bundle | `ash-core-plugins` 校验不可变 package、签名和摘要后只写入一次 | 不自动启用或授权任一 capability |
| 各领域启用 capability | Skill/MCP/Connector/Editor Extension consumer 分别应用自己的 policy | 不存在 bundle 级隐式全开 |
| 启用 local Plugin | 允许 contribution 参与解析 | 不连接 Connector、不启动 MCP、不执行脚本 |
| 批准请求的能力 | 记录精确的进程、网络、目录或凭据授权 | 不批准未来每一次工具调用 |
| 激活贡献 | 生成带来源和 generation 的不可变快照 | 不把 live manager 注入 Agent |
| 更新或回滚 | 并存校验后的版本并原子切换 | 不原地修改已安装包 |
| 卸载 | 撤销后续激活并清理可回收内容 | 不删除其他领域拥有的秘密或历史 |
| 打开正式打包的 Ash | 从产品内固定的 root 刷新官方 HTTPS Marketplace | 不信任服务器提供的新 root，不自动安装或启用 Plugin |
| 浏览 Marketplace | 读取已签名 manifest、能力、权限与包统计；离线时可使用仍有效的目录缓存 | 不预下载所有 Plugin ZIP |
| 安装远端 Plugin | 重新检查 TUF 与撤销状态，只下载所选 exact ZIP，再校验内容摘要 | 不因已浏览或已下载而自动启用、授权 |

## 1. 结论

Plugin 的定义与产品生命周期分别由两个 crate 拥有，来源不会建立第二套生命周期：

| 来源 | Package lifecycle owner | Capability activation owner |
| --- | --- | --- |
| Built-in / remote Marketplace Plugin bundle | `ash-core-plugins` | Skill/MCP/Connector/Theme/Language/Editor Extension 各领域 |
| Local Plugin v1 | `ash-core-plugins` | App Server 交给各领域；enable/grant 后形成 activation snapshot |

所有来源都可以提供 Skill、Connector、MCP、可执行 Editor Extension 或静态资源。
`ash-core-plugins` 先形成统一 installed Plugin 与 activation，再按 capability 交给各领域。

Plugin 不是：

- 第三方 Rust dynamic library 或稳定 in-process ABI；
- 一段安装后自动获得系统权限的代码；
- Skill、MCP server、tool 或 connector 的同义词；
- Thread/Turn 执行状态或 durable transcript；
- secret container；
- 允许扩展绕过 approval、sandbox、credential 和 network policy 的信任标记。

边界固定为：

```mermaid
flowchart TD
    D["ash-plugin definitions"] --> P["ash-core-plugins installed and active set"]
    M["Built-in / Marketplace / local sources"] --> P
    P --> S["Skill capability → Skill runtime"]
    P --> C
    P --> R
    P --> E
    P --> D["DeclarativeExtensionContribution → static package.json catalog"]
    P --> A["StaticAssetContribution → Resource consumer"]
    C -. "references exact MCP" .-> R
    C -->|"connected"| B["Ready MCP binding"]
    R -->|"standalone activation"| T["Tool Registry / Core"]
    E --> H["ash-editor-extension-host supervisor"]
    D --> X["ash-extensions immutable snapshot"]
    B --> R
```

`ash-plugin` 只表达 bundle；来源聚合、package lifecycle 与 activation 属于 `ash-core-plugins`。
Skill、Connector、MCP 和 Resource consumer 分别拥有自己的运行时语义；
它们不是 bundle/compatibility authority 内部的 live 子对象。Plugin、Connector 与 MCP 的 canonical 关系由
[`connectors.md`](connectors.md) 维护。

静态 Editor Extension 保持另一套内容边界：它读取自己的 `package.json` 和声明式
language/TextMate/snippet/theme/debugger 资源。Plugin v1 现在可用 `declarativeExtensions[]` 指向包内
静态 Extension 目录；只有 effective exact Plugin package 会被 App Server 投影到 `ash-extensions`。
这共享 install/enable/grant/revocation lifecycle，但不合并两种 manifest，也不把静态内容变成可执行
runtime。其 canonical 文档是 [`editor-extensions.md`](editor-extensions.md)。

Legacy Plugin v1 提供显式 `editorExtensions[]` bridge。每项指向包内一个可直接启动、自己实现 Ash Host
RPC v1 的程序；它不是由通用 Node/WASM runtime 加载的脚本。compatibility authority 只验证并授权声明，
`ash-editor-extension-host` supervisor 才拥有逐扩展进程隔离、RPC、crash recovery 和 provider
lifecycle。静态 `package.json` catalog 不会被隐式转换成该 executable declaration。

`declarativeExtensions[]` 是另一条显式 bridge：每项只有 manifest-local ID 和 package-relative
directory，目录必须包含 regular `package.json`。它不需要 `process` permission；安装只存储 bytes，
enable + grant 后才进入静态 catalog，disable、grant revoke、package revoke、update 或 uninstall 会使
下一次 catalog refresh 移除旧 exact package。Workbench 监听 Plugin activation generation 并自动刷新。
生产第三方执行还必须由产品注入能够实施 sandbox、memory/CPU/process hard limits 和 process-tree
termination 的 platform launcher；没有该 launcher 时 Host capability 必须为 false，不能用
`TrustedDevelopmentLauncher` 降级。该 v1 是 Ash executable RPC，不是 VS Code/Node Extension
Host。

安装、启用、授权和调用是四个不同动作：

1. **Install**：包进入本地 content store；
2. **Enable**：某个 user/directory profile 允许其贡献参与解析；
3. **Grant**：允许所需 process/network/root/credential capability；
4. **Invoke**：Agent 的某次 tool/script 操作仍经过 runtime approval 与 sandbox。

任何一个动作都不能隐含下一个动作。

## 2. 当前仓库审计

当前 `ash-plugin` 实现 strict v1 manifest、Plugin identity/SemVer、portable package-relative path、本地 package 安全校验和确定性 digest。`ash-core-plugins` 实现 discovery、稳定 staging snapshot、内容寻址 object、durable authority、原子 activation generation 与 Marketplace package lifecycle。

User/Directory TOML 与 App Server 已能表达 exact legacy Plugin request 和 desired enablement。
Package store 安全保存既有 local-development immutable object，
并把 exact installed package 解析为 generation-bound activation snapshot；App Server 可据此自动构造
Skill source、Connector catalog、durable authority 和 package-rooted MCP provider。Plugin authority
分别持久化 installed/enabled/granted/effective refs 和 command receipts，并驱动 live activation 切换；
App Server 当前暴露 Plugin authority 与 Marketplace package API；后续产品接口应以 `plugin/*` 为主，
只在来源管理时暴露 `marketplace/*`。
TUI 只有在 Plugin domain 进入 App Server API 后才能增加管理能力。TUI 已有可复用的 tabs/search/selection 组件，但当前没有 Plugin view model 或 `/plugins` command；
这些 UI 基础设施不改变本节的 backend gate。

已有可复用边界：

- `ash-config` 提供 ordinary config authority、typed patch 和 `CommandId` replay；
- 各 credential domain 是生命周期 owner，`ash-secrets` 是 opaque secret persistence owner；
- `ash-sandboxing`、`ash-tool-executor` 和 host capability 是已分离的本地进程执行权限边界；
  产品层 `ash-exec` 只运行完整的无界面 Agent Turn；
- App Server 是本地 runtime 的 composition root；
- Resource store 可承载大块只读内容，但不是 Plugin package authority；
- `ash-protocol` 已固定“共享纯语义进入 protocol，I/O 和 policy 留在执行层”的规则。

因此第一版不应从“动态加载代码”开始，而应先完成一个 declarative package：

```text
Plugin v1 contributions = Skills + Connectors + MCP server declarations
                        + executable Editor Extension declarations + static assets
```

第三方 UI、native library、hooks、model provider adapter 和任意 App Server method registration
不在 v1。

## 3. 职责与非职责

### 3.1 `ash-plugin` 拥有

- Plugin package layout 和 manifest schema；
- stable Plugin identity、version、digest 和 origin；
- contribution discovery、path containment、compatibility 和 conflict validation；
- executable Editor Extension 的 exact program、Host RPC v1、activation trigger 与 capability ceiling 声明；
- local package provenance、content validation 与 digest。

### 3.2 `ash-core-plugins` 拥有

- built-in、Marketplace 与 local Plugin 来源聚合；
- package staging、atomic install、side-by-side update 和 remove；
- installed/enabled/granted/effective authority 与 typed command replay；
- immutable `PluginActivationSnapshot`、generation 与 invocation lease；
- enabled Plugin 向 Skill/Connector/MCP runtime 的 normalized contribution；
- 不含秘密的 audit record 和 health state。

### 3.3 两个 Plugin crate 都不拥有

- Skill 的自动选择、prompt layering 或 context budget；
- MCP JSON-RPC、process supervision、Connector connection/OAuth 或 tools/resources/prompts catalog；
- Editor Extension Host RPC transport、process supervision、crash recovery 或 provider registry；
- script、binary 或 MCP tool 的实际执行；
- API token、OAuth token、cookie 或 private key；
- OS sandbox、network enforcement 或 per-call approval 的最终实现；
- Thread reducer、Tool Call/Result commit 或 Agent retry；
- Marketplace publisher、签名发布和远端 catalog 存储；
- 第三方 UI iframe、Renderer code execution 或 Electron preload extension；
- 任意 native ABI、WASM ABI 或 provider adapter ABI。

## 4. 目标依赖与组合

```text
                         ash-plugin
               identity / manifest / package observation
                              ▲
                              │
                     ash-core-plugins
       sources / store / resolver / authority / activation
                 ▲                         ▲
                 │ package source          │ trust verifier
                 │                         │
          filesystem/registry        signature service
                 \                         /
                  \                       /
                   App Server composition
                         │          │          │
             SkillContribution  ConnectorContribution  McpServerContribution
                         │          │          │
                         ▼          ▼          ▼
                    ash-skills  ext/connectors   ash-mcp
```

具体规则：

- `ash-plugin` 不依赖 store、Marketplace、Skill、Connector 或 MCP runtime；
- `ash-core-plugins` 依赖 `ash-plugin`，不反向依赖；
- `ash-core-plugins` 只输出 normalized descriptor 和 immutable root handle；
- App Server 将 Skill contribution 注册到 Skill source，将 Connector contribution 交给 Connector adapter，
  并将独立或 ready-bound MCP contribution 解析为 `McpServerDefinition`；
- contribution consumer 必须再次执行自己领域的校验，不能因为 package 已验证就跳过 schema、
  content 或 runtime policy；
- Plugin state 不进入 SessionStore/ThreadStore；
- App Server protocol 只暴露稳定 Plugin view 和 command DTO，不暴露内部 filesystem path、
  lock、transaction journal 或 signature library type。

## 5. Legacy local 包与清单

### 5.1 Legacy v1 布局

```text
plugin-root/
├── .ash-plugin/
│   └── plugin.json
├── skills/
│   └── code-review/
│       ├── SKILL.md
│       ├── references/
│       ├── scripts/
│       └── assets/
├── mcp/
│   └── review-server.json
├── bin/
│   └── review-server
├── assets/
└── LICENSE
```

目录可以省略，但 `.ash-plugin/plugin.json` 必须存在。manifest 中只允许相对 package root 的
slash-separated path；绝对路径、`..`、空 segment、NUL、平台 device path 和 escape symlink
全部拒绝。

### 5.2 清单结构

以下是当前 v1 语义示例；当前 authority 是 Rust strict parser，尚未发布独立 JSON Schema：

```json
{
  "schemaVersion": 1,
  "id": "acme/code-review",
  "version": "1.2.0",
  "displayName": "Acme Code Review",
  "description": "Review workflows and an optional MCP server.",
  "license": "Apache-2.0",
  "compatibility": {
    "ash": ">=0.1.0"
  },
  "contributions": {
    "skills": [
      { "id": "code-review", "path": "skills/code-review" }
    ],
    "mcpServers": [
      { "id": "review", "definition": "mcp/review-server.json" }
    ],
    "assets": [
      { "id": "icon", "path": "assets/icon.png" }
    ],
    "editorExtensions": [
      {
        "id": "review-runtime",
        "entrypoint": "bin/review-extension-host",
        "runtimeApiVersion": 1,
        "activationEvents": [
          { "type": "onCommand", "id": "acme.review.run" },
          { "type": "onLanguage", "id": "rust" },
          { "type": "onDemand", "capability": "testProfileProvider" }
        ],
        "capabilities": ["command", "languageProvider", "testProfileProvider"]
      }
    ]
  },
  "permissions": [
    { "type": "process", "executable": "bin/review-server" },
    { "type": "process", "executable": "bin/review-extension-host" },
    { "type": "directory", "access": "read" },
    { "type": "network", "hosts": ["api.example.com"] }
  ],
  "credentialSlots": [
    { "name": "api-token", "kind": "secretText", "requiredFor": ["mcp:review"] }
  ]
}
```

Manifest 必须 strict-parse：

- unknown top-level/security-sensitive field 明确报错；
- 自定义展示 metadata 只能放在 namespaced `metadata`；
- `schemaVersion` 是 manifest format version，不是 Plugin version；
- Plugin version 使用一个已选择并统一实现的 version scheme；
- 同一 Plugin version 的内容 digest 必须唯一；registry 不得让相同
  `(PluginPackageId, version)` 指向不同内容；
- manifest 只声明 credential slot，不包含 secret value；
- permission 使用 tagged enum，不使用 `network: true`、`directory: "all"` 一类含糊开关。

`editorExtensions[]` 是 strict typed control-plane declaration：ID 与 entrypoint 各自唯一；entrypoint
必须是包内 regular file，并有完全相同路径的 `process` permission；`runtimeApiVersion` 仅接受数值
`1`；activation event 和 capability ceiling 都必须 non-empty、unique、bounded。v1 triggers 是
`startup`、`onCommand`、`onLanguage`、`onDemand`、`onDebugType`、`onTaskType` 和
`onTestProfile`。除 `startup` 外，trigger 不得请求 ceiling 中未声明的 capability。

`workspaceContains` 当前故意不在 schema 中：安全实现必须由 Workspace authority 提供 bounded scanner
与 ignore/trust 语义，不能让扩展程序自行扫描工作区，也不能让 Host 静默忽略一个看似有效的 trigger。

exact `process` permission 只给 supervisor 一条 package-relative launch ceiling；provider invocation
仍走已经启动的 RPC session，不会每次重新直接执行 entrypoint。regular-file/containment 校验不承诺该
artifact 在当前 OS、CPU 或 ABI 上可运行，也不检查 Unix executable bit、Windows PE/扩展名或代码签名。
当前 v1 没有 per-platform artifact selector；supervisor 必须在 activation 时检查 launchability 并对不兼容
artifact fail closed。

### 5.3 身份

通用插件标识采用 `name@marketplace`，规则见 [Core Plugins](../ash-rs/docs/core-plugins.md#插件标识与-provider)。
本节的 `PluginPackageId` 专指现有 `.ash-plugin` manifest 中的 `publisher/name`，两段使用 lowercase ASCII、数字和单连字符，并限制总长度。
display name 可本地化且可变化，不能充当 identity。

```rust
pub struct PluginPackageId(String);
pub struct PluginVersion(String);
pub struct PluginPackageDigest(String);

pub struct InstalledPluginRef {
    pub id: PluginPackageId,
    pub version: PluginVersion,
    pub digest: PluginPackageDigest,
}
```

Plugin contribution identity 是：

```text
(PluginPackageId, contribution kind, manifest-local contribution ID)
```

升级时即使 path 改变，只要 manifest-local ID 不变，用户 grant 和配置才能被有控制地重新评估。

## 6. 包来源、来源与信任

Package source 使用显式 enum：

```text
BuiltIn
LocalDevelopment { canonicalPath }
Registry { registryId, package, version, digest }
Archive { sourceUri, digest }
```

v1 至少支持 BuiltIn 和显式 LocalDevelopment；remote registry 必须在下载、签名和更新 threat
model 完成后再启用。

每个 installed record 保存：

- exact Plugin ID/version/digest；
- manifest digest；
- source type 与 origin；
- install timestamp；
- signature verification result 与 signer identity（若有）；
- Ash version/manifest schema compatibility；
- requested permissions 和 granted permission revision；
- package quarantine/blocked reason；
- previous active version，供原子 rollback。

信任规则：

- BuiltIn 由 Ash release trust 继承，但仍经过 manifest/content validation；
- marketplace/registry package 必须 digest-pinned；生产 channel 还应验证受信 publisher 签名；
- LocalDevelopment 可以 unsigned，但 UI、status 和 audit 必须显著标记；
- signature 只证明来源/完整性，不证明 Skill 指令安全、MCP tool 无副作用或没有漏洞；
- publisher/release 被撤销后禁止新 activation，并停止或隔离受影响 runtime；
- trust store、revocation feed 和 signing key rotation 属于独立安全 policy，不能硬编码在 manifest。

## 7. Install store 与事务

### 7.1 内容寻址的不可变存储

Package 解包后放入 content-addressed directory：

```text
plugin-store/
├── objects/<sha256>/...
├── staging/<operation-id>/...
└── authority.json 或 typed database
```

runtime 永远从 immutable object root 读取。不能原地修改 active package，也不能让 update 覆盖旧 version 目录；local-development source 的后续变化只影响下一次成功安装，不改变已经激活的 generation。

安装流程：

```text
resolve source
→ download/copy into unique staging
→ enforce archive count/size/depth limits
→ reject traversal, special files and escaping links
→ compute digest
→ verify origin/signature
→ parse and validate manifest
→ validate all contribution paths
→ fsync + atomic promote to object store
→ commit installed authority record
```

Local-development source 是可变目录：复制完成后必须重新验证 source 和 staging；只要所选 Plugin ID/version 不变，source 变化会丢弃 staging 并有限次重试，以最后一次稳定内容的 digest 建立 object。文件身份检查只属于这段本地复制过程，用于把打开的句柄绑定到刚检查过的 source file；discovery、digest、object read 和 runtime 都只依赖内容与 package contract。正式 Marketplace artifact 应由 Manager 提供已经固定 digest 的 immutable archive/blob，不依赖文件身份或这套可变目录重试。

任何一步失败都不改变 active snapshot。staging cleanup 可恢复且不得把 broad root 当删除目标；update 只有在新 object、authority record 和新 generation 都准备完成后才原子切换，旧 generation 在 invocation lease 排空前继续读取旧 object。

### 7.2 权威与投影

Plugin authority 至少保存：

- installed exact package refs；
- per-profile desired enablement/version pin；
- grants 和 credential slot bindings；
- typed command receipts；
- active snapshot generation；
- rollback target。

package directory 是 immutable content，authority record 决定“已安装/已启用”；UI cache、搜索索引和
health 是可重建 projection。

不得只靠扫描目录推断 enablement，也不得只靠 config 中一个 path 宣布包已验证。

## 8. 状态模型

不要用一个巨型 enum 表达所有正交状态。至少拆分：

```text
InstallState
  NotInstalled / Staged / Installed / Quarantined

Enablement
  Disabled / Enabled

ActivationState
  Inactive / Resolving / Active / Blocked / Broken

RuntimeHealth
  Unknown / Healthy / Degraded / Unavailable
```

例子：

- Installed + Disabled + Inactive：包存在但不参与解析；
- Installed + Enabled + Blocked：缺 grant 或 Ash version 不兼容；
- Installed + Enabled + Active + Degraded：Skill 可用，但某个 MCP server 当前认证失败；
- Quarantined：任何 contribution 都不能激活。

health 不改变 package authority，MCP crash 也不能让 Plugin 变成“未安装”。

## 9. 范围、优先级与冲突

Activation profile 至少区分：

```text
BuiltIn
User
Dir { dirId }
```

Directory 声明可以请求某 Plugin/version，但不能静默下载、启用或授予权限。首次加入目录
时必须展示 package origin、digest、permissions 和 credential slots。

解析规则：

- exact `PluginPackageId` 在一个 profile resolution 中只能有一个 active version；
- directory pin 可以覆盖 user 的版本选择，但必须产生可见的 `VersionPinOverride`；
- 两个不同 Plugin 的 contribution 同名不能按 source priority 静默覆盖；
- Skill/Connector/MCP consumer 使用 namespaced identity；
- manifest-local duplicate ID 使整个 package validation 失败；
- incompatible/blocked Plugin 不提供部分“看起来能用”的 contribution，除非 manifest 明确声明
  独立 optional contribution group，且 resolver 能原子判断。

第一版不支持 Plugin 依赖其他 Plugin。长期若加入依赖，必须使用 lock snapshot、cycle detection、
exact resolved versions 和冲突解释；不能在启动时执行隐式 package-manager install。

## 10. 权限与凭据

### 10.1 两层授权

Plugin grant 与 action approval 分开：

```text
Activation grant
  允许启动哪个 executable、连接哪些 host、暴露哪些 roots、绑定哪个 CredentialRef

Invocation approval
  允许本次 materialized tool/script 操作及其具体参数
```

Grant 只限定最大能力，不能预先批准任意未来 side effect。MCP tool annotation 和 Skill
`allowed-tools` 也不能扩大 grant。

### 10.2 权限类型

目标使用 tagged values，例如：

```text
ProcessLaunch { packageRelativeExecutable }
Directory { access: Read, rootSelector }
Directory { access: Write, rootSelector }
NetworkConnect { scheme, hostPattern, portPolicy }
CredentialUse { slot }
HostCapability { capabilityKind }
```

以下声明 v1 拒绝：

- unrestricted filesystem；
- arbitrary shell；
- 任意 host/port 网络 wildcard；
- 读取所有 process env；
- Electron/Renderer/Node raw access；
- 注册任意 App Server method；
- 把 credential 注入日志、argv 或 manifest placeholder 后回写。

Secret materialization 在启动/请求的最后时刻由 credential adapter 完成。legacy Plugin authority 只看到
slot → `CredentialRef` binding 和 revision。

## 11. 贡献激活

Resolver 输出 immutable snapshot：

```rust
pub struct PluginActivationSnapshot {
    pub profile: PluginProfileId,
    pub generation: u64,
    pub plugins: Vec<ResolvedPlugin>,
    pub skills: Vec<ResolvedSkillContribution>,
    pub mcp_servers: Vec<ResolvedMcpServerContribution>,
    pub diagnostics: Vec<PluginDiagnostic>,
}
```

只有 consumer-visible resolution 变化才递增 generation。snapshot 中的所有 package root、path、
version、digest、grant 和 credential binding revision 都已冻结。

激活顺序：

```text
load authority
→ resolve exact packages
→ validate compatibility and grants
→ produce new snapshot off to the side
→ Skill manager validates/indexes new skill source
→ MCP manager validates definitions and prepares sessions
→ atomically publish generation
→ retire previous generation after references drain
```

如果 Skill 或 MCP consumer 校验失败，默认不发布半个 Plugin generation。optional contribution
只有在 manifest schema 明确表达隔离边界后才能独立降级。

Agent/Turn 使用自己开始时捕获的 activation/catalog snapshot。Plugin update 不改变已开始的 model
invocation；新版本只在下一个 safe point 生效。

## 12. 更新、回滚与卸载

### 12.1 更新

```text
fetch exact candidate
→ stage and verify
→ diff permissions/contributions/credentials
→ require consent for any grant expansion
→ resolve candidate generation
→ publish atomically
→ drain previous generation
→ retain rollback object
```

相同 Plugin version 出现不同 digest 必须拒绝，不能当普通 update。permission expansion、new
credential slot、new executable 或 endpoint 变化都需要重新授权。

### 12.2 回滚

Rollback 是切换 authority 的 exact package ref，不重新下载，也不修改旧 object。若旧版本已被
revoked/quarantined，则不可 rollback。

### 12.3 Disable 与卸载

Disable：

- 阻止新 Turn 捕获 contribution；
- 停止/排空对应 MCP session；
- 保留 package、配置和可解释 diagnostics；
- 不删除 historical Thread 中的 tool/skill provenance。

Uninstall：

- 必须先 disable；
- active generation 和 in-flight runtime 引用归零后才移除 installed record；
- object 只有在无任何 version/profile/rollback 引用时才进入垃圾回收；
- credential value 不随 Plugin package 删除；只解除 slot binding，是否删除 secret 由 credential
  owner 决定；
- directory 中的声明保留为 unresolved request，不能静默重装。

## 13. Skill、Connector 与 MCP 的明确关系

| 行为 | Legacy Plugin authority | Skill manager | Connector / Auth | MCP runtime |
| --- | --- | --- | --- | --- |
| 校验 package digest/path | 负责 | 不负责 | 不负责 | 不负责 |
| 解析 `SKILL.md` | 不负责 | 负责 | 不负责 | 不负责 |
| 选择/加载 Skill | 不负责 | 负责 | 不负责 | 不负责 |
| 管理外部账号连接状态 | 只声明 Connector | 不负责 | Connector runtime 负责 | 不负责 |
| OAuth/API-key 交互和 secret bytes | 只声明 credential slot | 不负责 | Auth adapter 执行，Secrets owner 保存 | 只消费 materialized credential |
| 发布 ready runtime binding | 只提供 declaration/provenance | 不负责 | connected generation 负责 | 只消费 binding |
| 解析 MCP JSON-RPC | 不负责 | 不负责 | 不负责 | 负责 |
| 启动 MCP process/session | 只声明/grant | 不负责 | 不启动 | 负责 |
| 执行 script/tool | 不负责 | 不执行 | 不执行 Tool | MCP tool 只执行协议调用 |
| approval/sandbox | 只提供最大 grant | 不扩大权限 | 连接成功不代表调用获批 | 服从 Agent/host policy |

一个 Skill 可以指示 Agent 使用同 Plugin 的 MCP tool，但关联必须通过 stable contribution identity
解析。Skill 文本不能通过写一句“此工具已批准”跳过 grant 或 approval。

### 13.1 Connector 与 built-in 工具

`Connector` 是外部产品连接的 domain object，不是 package format。Plugin 可以贡献 Connector declaration
和它引用的 MCP declaration，但二者进入独立的 Connector/MCP runtime 后，identity 和 lifecycle 仍然不同。
Connector 当前通过 MCP binding 连接能力 runtime；未来只有出现真实的非 MCP consumer 后，才扩展其他
binding variant。

当前 v1 manifest 已允许 `contributions.connectors[]` 用 manifest-local ID 引用同包的一个
`mcpServers[]`。`connectors::ConnectorCatalog` 将声明转换为同一 crate 的
`connectors::ConnectorSnapshot`：disconnected entry 进入 discovery，只有认证 owner 通过合法
generation transition 发布 `ConnectorAccount` 后才输出 ready MCP server ID。当前 API-token adapter、
SQLite authority、exact activation 到 package-rooted MCP provider 的自动构造、独立 Plugin MCP、
Connector-bound MCP composition、通用 OAuth PKCE 状态机、Desktop browser callback 与 GitHub provider
已实现。Legacy Plugin enable/update 已能 live replacement，并通过 exact invocation lease 阻止旧 contribution
在 authority commit 后开始 dispatch。完整边界由 [`connectors.md`](connectors.md) 维护。

| 概念 | Identity/lifecycle | 例子 |
| --- | --- | --- |
| Plugin | package ID + version + digest；install/update/uninstall | 一组 GitHub 扩展贡献 |
| Connector | account/tenant + credential binding；connect/revoke | 用户的某个 GitHub organization |
| MCP server | server definition + connection generation | GitHub MCP session |
| Skill | source + name + content digest；select/activate | PR review workflow |
| Built-in tool | Ash release 中的 compiled capability | 本地受控 command executor |

卸载 legacy Plugin 只解除其 contribution 和 credential-slot binding；卸载 Marketplace bundle 则由
Manager 撤销 installation，并等待 capability lease 排空。两者都不能擅自删除 auth domain 中可能被
其他 Connector 使用的 secret。反过来，revoke Connector credential 会让相关 MCP runtime 不可用，
但不会删除任何 package。

## 14. App Server API 与客户端

当前 App Server surface 与后续演进：

| 状态 | Method | Authority/effect |
| --- | --- | --- |
| ✅ 当前 | `plugin/list` | 读取 installed/enabled/granted/effective projection |
| ✅ 当前 | `plugin/enable` / `plugin/disable` | exact-package CAS 修改 profile enablement |
| ✅ 当前 | `plugin/grant` / `plugin/revokeGrant` | exact-package CAS 修改 explicit grants |
| ✅ 当前 | `plugin/uninstall` | 仅在 disabled + revoked 后移除 authority reference |
| 尚未完成 | operation read API | 长操作 progress/result |

已实现 Plugin mutation 使用 `CommandId + expectedRevision + exact package payload`。这些 mutation 不读取
Marketplace catalog，也不接受 Renderer 提交宿主文件路径。远端信任、TUF、revocation、下载、artifact
和安装状态由 [`core-plugins.md`](../ash-rs/docs/core-plugins.md) 定义的 PluginsManager 链路统一拥有。

正式 package 把只读配置和公开信任根放在
`ash-resources/product-services/{product-services.json,marketplace-root.json}`。Desktop/server、
`ash code`/TUI 与 app 通过共享 App Server client + `ash-install-context` 边界发现该资源，默认注册 `https://chogng.github.io/ash-marketplace/` 的 `ash`
Marketplace；`ASH_PRODUCT_SERVICES_PATH` 与 App Server 的 `--product-services PATH` 仍是产品宿主的
显式覆盖入口。远端 metadata、Plugin、用户配置和 Directory 都不能更换这份 root。发行源仓库仍为
private，Pages 只暴露经过 Marketplace 自身独立 validator 和 TUF verifier 复核的 `metadata/` 与
`targets/` 静态产物。Marketplace 不依赖 Ash 源码或发布状态；Ash 只是通过 pinned root 和 consumer
adapter 选择性消费它。
默认产品文件只启用官方源；第三方源只能由 host 在同一只读文件中追加，不能从 Plugin、自身远端 metadata
或普通用户设置提升为发行信任。

客户端必须展示：

- exact ID/version/digest/origin；
- signed/unsigned/revoked/quarantined 状态；
- requested 与 granted permissions diff；
- 贡献的 Skills、Connectors 和 MCP servers；
- credential slots 只显示绑定状态，不显示 secret；
- update 的 contribution/permission diff；
- blocked/broken 的稳定诊断。

CLI/TUI/Desktop 不直接扫描 Plugin 目录，不解析 manifest，也不自己启动 MCP server。

## 15. 安全

Legacy local package ingestion 必须防御以下问题；remote Marketplace ingestion 的 TUF/archive 契约由
[`core-plugins.md`](../ash-rs/docs/core-plugins.md) 单独拥有：

- archive path traversal、absolute path 和 drive/device path；
- symlink/hardlink escape；
- zip bomb、文件数/单文件/总大小/嵌套深度超限；
- duplicate normalized path 和 Unicode/path normalization collision；
- special file、socket、FIFO、device node；
- executable bit/平台 artifact 欺骗；
- manifest schema bomb、超长字符串和重复 contribution；
- TOCTOU：validation 后 object 必须不可变并按 digest 打开；
- malicious update 改写相同 version；
- unsigned local package 被 UI 伪装成 trusted registry package。

Runtime 还必须假定 package 内容含 prompt injection 或恶意程序。签名、安装和启用都不能替代
sandbox、data egress control 与 per-action approval。

## 16. 错误与诊断

至少区分：

```text
SourceUnavailable
PackageDigestMismatch
SignatureInvalid
PackageUnsafe
ManifestInvalid
CompatibilityMismatch
PermissionGrantRequired
CredentialBindingRequired
ContributionConflict
ContributionInvalid
ActivationFailed
PackageRevoked
PackageInUse
CommandConflict
```

错误中不包含 secret、完整 env 或敏感 file content。diagnostic 必须能回答：

- 哪个 exact package 被选择；
- 为什么某版本被 pin/阻止；
- 哪个 permission/credential 缺失；
- 哪个 contribution/path 冲突；
- 当前 active generation 与上一个 rollback generation；
- 哪个 MCP/Skill consumer 拒绝了 contribution。

## 17. 目标目录

Plugin 定义与产品生命周期保持两个 crate：

```text
ash-rs/plugin/src/
├── lib.rs
├── identity.rs
├── path.rs
├── error.rs
├── manifest/
│   ├── model.rs
│   ├── validation.rs
│   └── editor_extension.rs
├── package.rs
└── package/
    ├── local.rs
    └── digest.rs

ash-rs/core-plugins/src/
├── lib.rs
├── plugin_activation.rs
├── plugin_authority.rs
├── plugin_authority/persistence.rs
├── plugin_discovery.rs
├── plugin_package.rs
├── plugin_package/
│   ├── snapshot.rs
│   └── store.rs
├── manager.rs
├── marketplace_store.rs
└── marketplace_activation.rs
```

## 18. 分阶段实施

### 阶段 PL0：清单+ local validation（已完成）

- 固定 v1 schema、identity、path 和 digest；
- local development package discovery；
- filesystem path/schema 安全 fixtures；Archive source 尚未启用，因此 archive ingestion
  fixtures 随对应 source 一起加入；
- App Server `plugin/list` 与 lifecycle mutation 已接入；任意 host path install 有意不开放给 Renderer。

当前完成条件：任何 contribution path 都不能逃出已验证 local snapshot root；安装时必须复制到 staging、验证 staging digest 与复制后的 source observation 一致，再原子 promote 为 content-addressed object。mutable local root 不会被发布给 runtime。

### 阶段 PL1：权威+激活（已完成）

- ✅ local content-addressed store：stable snapshot retry、copy-time identity validation、owned-object digest revalidation、concurrent idempotence 与 atomic promote；
- ✅ install/enable/disable/grant/revoke/uninstall typed authority commands；
- ✅ exact installed package resolution 与 activation snapshot generation；
- ✅ durable install/enable/disable/uninstall authority record 与 typed command replay；
- ✅ live revision/activation subscription、App Server lifecycle RPC/reconcile 与 exact invocation drain；
- ✅ Plugin Skill contribution 的 exact immutable source projection 与 live catalog refresh；
- ✅ declarative Extension contribution 的 exact immutable source projection、precedence 与 live refresh；
- ✅ Connector contribution 的 normalized projection；
- ✅ legacy user-profile exact package reconcile；Directory request 保持只读、不能自动 grant；
- ✅ startup transient staging recovery；未引用 object 的全局配额与垃圾回收仍未完成。

完成条件：失败激活不改变上一 generation，重启可恢复唯一 active package set。

### 阶段 PL2：MCP 贡献

- ✅ package-rooted strict MCP definition 与 standalone/Connector projection；
- ✅ manifest process/network/credential ceiling 校验；
- ✅ 与 `ash-mcp` 的 prepare/publish 和 safe-point old-generation drain；
- ✅ Plugin disable/update authority 触发 live activation、safe-point replacement 与 dispatch drain。

完成条件：安装不启动进程，enable 无 grant 不启动，update 不劫持 in-flight tool binding。

### 阶段 PL3：远端分发迁移（已完成）

- ✅ `ash-core-plugins::registry` 隔离远端 catalog/TUF/download；
- ✅ `ash-core-plugins` 统一拥有 local/Marketplace artifact、install/update/uninstall、authority 与 lease；
- ✅ `ash-plugin` 只拥有共享 Plugin 定义与 package observation；
- ✅ Plugin bundle 经统一 installed/activation state 后按 capability 交给领域 consumer；
- 尚未完成：统一 UI 中跨 capability 的 permission/contribution diff。

完成条件：相同 ID/version 不可换内容，grant expansion 必须重新 consent。

### 阶段 PL4：生态扩展评审

当前已完成的窄边界：

- ✅ Plugin manifest/immutable package 对可执行 Editor Extension program 的 strict declaration；
- ✅ exact process permission、Host RPC API v1、activation/capability ceiling 与 regular-file 校验；
- 委托 `ash-editor-extension-host`：进程隔离、RPC、crash supervisor、provider lifecycle；
- ❌ generic Node/WASM loader、VS Code Extension API compatibility 与 `workspaceContains` scanner。

其余能力只有在具体需求有独立 threat model 和 stable port 后，才分别评审：

- declarative hooks；
- WASM capability component；
- provider adapter；
- 静态 UI contribution。

禁止直接加入 dynamic library 或任意 Renderer JavaScript。

## 19. 验证门

除常规 Rust workspace 检查外，必须覆盖：

- manifest unknown field、invalid ID/version、duplicate contribution；
- Editor Extension runtime API、exact executable permission、activation/capability bound 与 entrypoint file type；
- path traversal、symlink/hardlink、normalization collision 和 archive bomb；
- declarative Extension 目录、`package.json` file type、source precedence 与 activation refresh；
- digest/signature/revocation；
- install 每个 durable boundary 的 crash recovery；
- enable/grant `CommandId` replay 和 payload conflict；
- directory/user pin conflict；
- permission/credential diff；
- activation prepare 失败、publish race、generation drain；
- update/rollback/uninstall 的 reference safety；
- disabled/quarantined package不能贡献 Skill 或启动 MCP；
- logs/schema/App Server response 不泄露 secret 或内部 writable path。

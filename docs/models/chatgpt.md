# ChatGPT 订阅账户

Ash 提供两条独立的 ChatGPT 订阅连接。同一模型厂商仍为 `openai`，连接身份决定凭据所有者、请求目标和目录范围。安装 Codex 不会禁止用户选择 Ash 独立授权。

| 连接                   | 用途                                      | 凭据所有者                  | 请求目标                                          |
| ---------------------- | ----------------------------------------- | --------------------------- | ------------------------------------------------- |
| `chatgpt-subscription` | 复用本机已有且有效的 Codex 登录           | Codex；Ash 产品入口始终只读 | `https://chatgpt.com/backend-api/codex/responses` |
| `chatgpt-plan`         | 使用 ChatGPT 独立授权 Ash，无需安装 Codex | Ash profile 的 SecretStore  | `https://api.openai.com/v1/responses`             |
| `openai`               | OpenAI Platform API key                   | Ash 的 API key 存储         | Platform API                                      |

两种订阅授权不能交换 token 或只替换 base URL。它们都由 Ash Core 执行 Agent loop，不启动 Codex Agent。独立授权的公共接口见[官方模型与推理文档](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

## 职责与修改入口

连接选择和请求绑定主要由 `ash-model-provider` 负责，凭据隔离由 `ash-chatgpt` 负责。这里选择的是同一模型厂商的登录连接，不改变已选定的模型或 Agent Role。

| Crate                     | 职责                                                                                                                 | 修改入口                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ash-model-provider-info` | 定义连接身份、接入约束和自动选择的优先顺序                                                                           | [`connection.rs`](../../crates/model-provider-info/src/connection.rs) 的 `connection_priority`                                                                                    |
| `ash-model-provider`      | 比较可用连接并选择请求路径；固定模型的连接与账号，检查请求前后的身份，禁止失败后跨连接切换；按连接与账号划分目录范围 | [`provider.rs`](../../crates/model-provider/src/provider.rs) 的 `ModelProviderRuntime::preferred_connections` 和账号校验；[`catalog`](../../crates/model-provider/src/catalog.rs) |
| `ash-chatgpt`             | 只读复用 Codex 凭据，或维护 Ash 独立授权的注册、token、刷新锁和回调生命周期；两套凭据互不读写                        | 本机复用的 [`oauth.rs`](../../crates/chatgpt/src/oauth.rs)；独立授权的 [`plan.rs`](../../crates/chatgpt/src/plan.rs)                                                              |
| `ash-login`               | 统一登录、取消、登出、账户状态与通知，按连接分发给对应登录驱动                                                       | [`service.rs`](../../crates/login/src/service.rs)                                                                                                                                 |
| `ash-app-server`          | 组装两个登录驱动及模型运行时，暴露账户与连接 RPC；连接列表使用同一优先级定义                                         | [`local.rs`](../../crates/app-server/src/local.rs)；[`request_processors/providers.rs`](../../crates/app-server/src/server/request_processors/providers.rs)                       |

调整默认顺序时修改 `ash-model-provider-info`，调整可用性判断或绑定行为时修改 `ash-model-provider`，调整认证存储、刷新或登出隔离时修改 `ash-chatgpt`。

## 优先级与请求绑定

自动选择只比较当前可用的连接，顺序为本机 Codex 登录、Ash 独立登录、已配置的 Platform API key。安装探测不参与选择；过期、损坏、已断开或被拒绝的本机凭据不会阻止独立入口使用。凭据可用只证明本地认证状态，远端模型和套餐权限由实际请求确认。

调用方显式传入连接配置时，按该连接构建模型，不再应用自动优先级。模型运行时固定连接及账号身份；新登录、目录刷新和优先级变化只影响后来创建的绑定。每次请求既检查当前账号，也检查与实际 token 同时解析出的账号，拒绝切换账号的竞态。一次请求的 401、429、网络或流式失败都不能切换到另一条连接或 API key。

目录范围包含连接及账号身份，独立入口不读取 Codex 的模型缓存。发现开始后的账号切换使结果失效，不能把另一注册的模型写入原范围。两条连接可以并行使用；如果上游将它们计入同一订阅额度，客户端隔离不产生额外额度。

## 本机 Codex 登录

路径以运行 Ash 后端的主机为准。优先使用 `CODEX_HOME`，显式目录必须已存在并解析为规范路径；未设置时使用 `~/.codex`。不自动查找仓库中的 `.codex`，不修改 `config.toml`。

按 Codex 的 `cli_auth_credentials_store` 读取既有存储：`file` 读取 `auth.json`，`keyring` 读取 `Codex Auth` 条目，`auto` 在钥匙串没有条目时读取文件。钥匙串访问失败报告错误，不能转向其他账号或旧存储。加密 secrets 后端和仅进程内认证仍明确报告不支持。

只读加载不反序列化 refresh token。遵循 Codex 的 `auth_mode`、旧记录模式判定、登录方式和 workspace 限制；已有 API key 不当成订阅凭据。损坏记录不当成缺失。

本机入口不创建、刷新、替换或删除 Codex 凭据。缺失、过期或失效时，登录控制面返回 `AccountExternalLoginRequired`，需在 Codex 完成登录。重新连接已有有效凭据立即完成，不打开新的 OAuth 流。断开只保存 Ash profile 中该连接的停用标志，不影响 Codex，也不改变 `chatgpt-plan`。

每次模型请求读取当前外部凭据。明确 HTTP 401 且未交付模型事件时，最多重读一次；只有同一用户和 workspace 的外部 token 已更新才允许重试。Ash 不刷新共享 token，已开始的流不重放。账户额度查询同样使用只读身份，并拒绝返回换账号后的迟到结果。

底层显式的 Ash 管理模式保留 Codex 格式认证兼容性测试；产品的本机复用入口不选择该模式，也不因安装状态改变凭据所有者。

## Ash 独立授权

`ChatGptPlanBrowser` 通过 Sign in with ChatGPT 动态注册取得独立 `client_id`，请求身份权限及 `resource.invoke`、`chatgpt.tokens.use.direct`。PKCE、state、nonce 和经过签名验证的 ID token 绑定本次授权。回调使用随机 loopback 端口，不占用 Codex 的固定回调端口。

一个 profile 保留自己的 agent host ID；账号映射由 issuer、已签发 client ID 和验证后的 subject 确定，不能按 email 合并不同工作区注册。token 与注册保存在 `provider/chatgpt-plan/registrations-v1`，刷新使用 profile 自己的 `chatgpt-plan.lock`。这条路径不读写 Codex home 或 `Codex Auth` 条目。

同一 profile 的多实例通过锁串行刷新：锁后重新读取当前 token，成功后保存替换 refresh token。遵守 `earliest_refresh_at`；明确终止的 grant 错误清除相应 session，暂时失败保留原记录。刷新身份必须与原注册相同。

取消后的授权结果不能保存。回调线程只保留网络操作资源；profile 后端退出会取消授权并释放监听，不保留凭据所有者。成功登录和登出推进持久选择版本；在另一实例登录或登出之后到达的旧回调不能重新激活账号。登出只撤销该 Ash 注册并清除对应 token，保留 host ID 和注册映射供下次登录。远端撤销失败仍清除本地凭据并报告未确认，不操作 Codex 连接。

独立授权只向公共 Responses 发送 bearer token，要求 `store=false`、`stream=true`。模型目录从同一账号的公共 `models` 接口读取，保持服务端顺序。认证及刷新合同见[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[token 参考](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)。完整浏览器登录和真实推理尚未在本次变更中实连验收；双入口 UI 也不属于本次后端隔离修改。

## 验证

合成凭据测试覆盖双入口同时可用时的优先级、显式连接、模型绑定后的优先级变化、解析 token 时的换账号竞态、401 不跨连接重试、目录范围隔离、多实例单次刷新、取消、后端退出释放回调、迟到回调以及 Codex 文件保持不变。

使用 `just verify ash-chatgpt` 和 `just verify ash-model-provider` 验证所属包。App Server 登录方法变化须运行 `just generate-protocol`、协议测试、生成 TypeScript 严格检查和受影响客户端检查。

订阅推理的真实模型测试固定使用 `gpt-5.6-luna`、`reasoning.effort=low`。ChatGPT 会话发送验收使用当前账号聊天模型目录中的可用预设。测试不得刷新真实 Codex 凭据，默认不调用用户真实账户；已有只读验收入口为 `just test ash-chatgpt live_codex_usage_is_read_only -- --ignored --nocapture` 与 `just test ash-tui live_usage_command_through_local_app_server -- --ignored --nocapture`。原 Codex 格式实现的历史验收见[认证兼容验收](../../crates/docs/changes/chatgpt-auth/verification.md)。

## ChatGPT Web 工作区

聊天工作区的历史、附件和网页会话由 `chatgpt-web` 认证入口提供，与上面的模型订阅连接独立。在“新建”的右键菜单中选择“登录 Ash”可发起设备授权；凭据仅写入 Ash profile 的 SecretStore。共享 Rust owner 提前刷新过期凭据并持久化，401 仅对原账号恢复一次。该入口使用独立的 Codex 格式设备授权，不能使用 `chatgpt-plan` 的公共推理 token 访问网页历史接口。

“使用 Codex 登录”显式选择只读复用外部来源。刷新失败不会自动切换来源；“退出 Ash 登录”清除独立凭据并停用外部来源，保留 Codex 登录不变。切换来源、登出和账号变化撤销旧请求；各窗口共用 profile owner，登录完成仍路由回发起窗口。

### 网页侧栏缓存与刷新

以下行为来自 2026-11-06 从 [ChatGPT 网页](https://chatgpt.com/) 实际下载的前端构建。观察范围是 Chat 侧栏普通会话列表及会话历史，网页发布新构建后应重新核对。

- **先显示缓存。** 侧栏用按账号保存的 `chatgpt-sidebar-state-v2` 恢复列表占位内容。普通会话列表还可从 `localStorage` 中的 `codex.chatgpt-conversations` 读取分页快照。网络查询使用独立的查询状态，成功后用新数据更新列表和缓存。 [侧栏状态与历史查询](https://chatgpt.com/cdn/assets/956483.3c01676f85.js) · [列表缓存与查询](https://chatgpt.com/cdn/assets/87162.5d1a0f8597.js)
- **在触发时检查新鲜度。** 标签页由隐藏变为可见，或网络恢复时，普通会话列表会检查查询是否需要重查。成功数据的 `staleTime` 在这个构建是 58 分钟。数据被标记失效时可提前重查，例如收到会话更新通知。58 分钟是判断已有数据是否新鲜的阈值，这条查询没有配置周期轮询。 [列表配置](https://chatgpt.com/cdn/assets/87162.5d1a0f8597.js) · [时间常量](https://chatgpt.com/cdn/assets/353032.2edb55e631.js) · [可见性与重查条件](https://chatgpt.com/cdn/assets/807489.32eaa3bfde.js) · [会话更新处理](https://chatgpt.com/cdn/assets/956483.3c01676f85.js)
- **429 暂停对应的读取。** 最近列表用 `history-list` 记录冷却截止时间，至少等 60 秒。如果服务端给出的截止时间更晚，等到较晚的时间。冷却内返回已记录的限流错误，跳过网络请求。会话详情的首次读取和向上翻页使用独立于列表的冷却状态，遵循响应给出的截止时间。详情读到 429 时不会立即重试或改走旧接口。冷却结束后，下一次合格的触发可以重查。 [列表冷却](https://chatgpt.com/cdn/assets/87162.5d1a0f8597.js) · [详情冷却](https://chatgpt.com/cdn/assets/956483.3c01676f85.js) · [响应头解析](https://chatgpt.com/cdn/assets/637885.18b43d022e.js)

### ChatGPT 桌面 App 的侧栏缓存与刷新

2026-11-06 核对了本机 macOS ChatGPT App（应用 ID `com.openai.codex`，版本 `26.1029.61003`，构建 `24614`）安装包内的 ChatGPT 普通聊天列表。以下为构建代码的观察结果，冷却逻辑用合成 429 和模拟时钟复核。

桌面 App 的 ChatGPT 使用 `chatgpt-native` 请求配置，由桌面主进程执行带认证的请求。Ash 的 `chatgptweb` 使用自己的 Web 传输，即使选择“使用 Codex 登录”，也只是切换该入口的凭据来源。两条路径的部分 HTTP 路由相同，例如最近会话列表。

- **先显示缓存。** 普通聊天侧栏读取 `chatgpt-sidebar-state-v2`，并可用 `codex.chatgpt-conversations` 的分页快照作为占位。成功的查询会更新缓存。
- **成功列表有 5 分钟的新鲜度。** 普通聊天列表的 `staleTime` 为 `FIVE_MINUTES`，即 `300000` 毫秒。列表挂载、窗口重新可见和重连时，查询在缺少数据、数据过期或已失效时才重查。这条查询没有配置固定轮询。项目内聊天列表是独立查询，成功数据的新鲜度为 1 分钟。
- **列表 429 至少冷却 60 秒。** `history-list` 使用 60 秒下限和服务端截止时间中较晚的一个，冷却期间跳过网络读取。会话详情的首次读取及向上翻页使用单独的状态，429 不会立即重试或回退到旧接口。

### 实验性 `chatgpt` 入口

Ash 桌面 Agent 窗口默认用「ChatGPT（实验性）」新建聊天。可以在「设置 → 通用 → 默认 ChatGPT 入口」切换到「ChatGPT 网页版」。该设置保存在本机用户设置 `sessions.chatgpt.defaultBackend` 中，取值为 `chatgpt` 或 `chatgptweb`，下次点「新建」生效。也可以右键「新建」或通过命令面板打开指定入口。恢复会话时仍使用原入口，各自的草稿也分别保留。实验性入口使用本机 Codex 登录，未登录时会提示先登录。

实验入口通过独立的私有凭据连接读取 Codex 登录。最近列表和会话详情使用桌面端的读取路由。最近列表每页读取 20 个会话。打开会话先读最近 20 轮，选择「加载更早消息」时再请求上一页。选模取自账号的 ChatGPT 聊天目录。发送通过 Sentinel 校验，再提交会话请求并流式接收回复。

2026-11-06 在隔离的 Ash 桌面窗口中复用现有 Codex 登录，成功打开已有会话，并用 GPT-6 Thinking 发出一条测试消息、收到完整回复。该次最近列表请求遇到 429。中文桌面测试用合成数据复现打开入口、按需翻页、发送和切回网页版恢复草稿。

```sh
pnpm run test:smoke:desktop test/smoke/areas/sessions/chatgptNative.spec.ts \
  --grep 'opens native history, pages on demand, streams a reply'
```

#### 上游读取探测

2026-11-06 使用现有 Codex 登录和上述构建的桌面请求头实测。最近会话列表和单轮分页详情均返回 HTTP 200，响应分别包含 `items` 和 `messages`、`page_info`。探测在 Ash 测试进程中发请求，认证只读，无重试。这一探测只验证上游历史读取。

```sh
ASH_TEST_CHATGPT_DESKTOP_VERSION=26.1029.61003 just test ash-chatgpt --lib \
  live_tests::live_codex_chatgpt_native_history_is_read_only -- --ignored --exact --nocapture
```

同一探测加上 `ASH_TEST_CHATGPT_NATIVE_CHALLENGE=1`，只请求 `GET /backend-api/ios/attestation_challenge`。本机实测返回 HTTP 200 和非空挑战值。Codex App 的 macOS 原生发送会先注册 DeviceCheck Cookie，在请求挑战时附上 Apple 生成的设备令牌，再将挑战值带入发送请求。收到挑战值仅验证了这一条读取路由。安装包中可搜索 `deviceCheckCookieManager`、`x-sentinel-dc` 和 `app_attest_challenge`。 [Apple DeviceCheck](https://developer.apple.com/documentation/devicecheck)

### Ash 如何保持列表更新

Ash 先显示当前账号的缓存，限流时保留已加载的数据。网页版和实验性入口分别保存项目及置顶列表的上次成功读取时间。重开窗口或重启 Ash 后，15 分钟内直接复用对应列表。缓存到期后，在下次打开、窗口重新聚焦、页面重新可见或网络恢复时更新。实验性入口的最近会话列表单独使用 5 分钟新鲜期。手动重新加载可跳过新鲜期。网页版入口有待同步的本地操作时，每 60 秒尝试一次同步。 [Ash 刷新触发](../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTList.ts) · [刷新与缓存合并](../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTService.ts)

Ash 转发 429 的 `Retry-After`，分别记录最近列表、项目聊天列表和会话详情的冷却。最近列表至少等 60 秒。实验性入口由桌面主进程按账号保存最近列表冷却截止时间，重开窗口或重启 Ash 后仍遵守有效的截止时间。项目列表和详情按各自收到的有效服务端截止时间等待，缺少有效时间时等 60 秒。冷却到期后的下一次刷新可重新发起读取。 [传输层](../../src/ash/sessions/contrib/chatgptweb/electron-main/chatGPTTransport.ts) · [客户端冷却](../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTClient.ts)

ChatGPT 历史读取失败统一显示在一条窗口通知中，已加载的列表和消息继续显示。断网时暂停读取。收到联网事件后，连续一秒没有再次断网才恢复可见侧栏的刷新，并继续被打断的项目读取。恢复后的读取错误按实际失败类型在同一个通知入口呈现。 [连接恢复](../../src/ash/sessions/contrib/chatgptweb/electron-browser/chatGPTList.ts) · [历史通知](../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTService.ts)

### 复现

1. 在已登录的 ChatGPT 网页打开开发者工具的 Network，勾选 Preserve log，保持浏览器缓存开启。查看 Fetch/XHR，单独计数 `GET /backend-api/conversations`。把带会话 ID 的详情和翻页请求另记。让列表成功加载，记录最后一次成功时间和当前构建的脚本地址。
2. 切到另一标签页再切回原页。没有会话更新且缓存仍新鲜时，不应仅因切回而重发列表请求。保留原标签页，在列表过期后切回，观察列表重查。也可在测试会话收到更新后观察提前重查。用 Sources 搜索 `chatgpt-sidebar-state-v2` 和 `history-list` 定位缓存及冷却逻辑。这个构建的列表 `staleTime` 引用 `rvFo` 导出的 `348e4` 毫秒，可直接核对 58 分钟。
3. 核对 macOS 安装包时，先读取 `/Applications/ChatGPT.app/Contents/Info.plist` 中的 `CFBundleShortVersionString` 和 `CFBundleVersion`。用 ASAR 工具从 `Contents/Resources/app.asar` 提取下列资源。构建更新后可按搜索词重新定位分块。
   - `webview/assets/async/24191.589dcc9878.js`。在 `Ghh3` 模块找 `chatgpt-native` 请求配置，在 `QmkR` 找普通列表的 `staleTime`，在 `YCbu` 找项目聊天列表，在 `LCGF` 找列表 429 的截止时间计算，在 `gbRX` 找详情与翻页的冷却状态。
   - `.vite/build/early-bootstrap-45-628adb74a9c47df1.js`。搜索 `fetchAuthenticatedJson` 和 `chatgpt-native`，核对桌面主进程如何处理请求配置。
   - `webview/assets/async/265651.3442ea834c.js`。在 `rvFo` 核对 `FIVE_MINUTES:3e5` 和 `ONE_MINUTE:6e4`。
   - `webview/assets/async/653016.011423a601.js`。搜索 `shouldFetchOnReconnect`、`shouldFetchOnWindowFocus` 和 `isStaleByTime`，核对联网、可见和数据失效的判断。
4. 用仓库测试注入 429 和断网事件并推进时钟。以下命令验证 `Retry-After` 转发、冷却内的请求次数、合并重连刷新、单条窗口通知，以及保留列表、正文和已收到的回复。

```sh
pnpm test:unit \
  --run src/ash/sessions/contrib/chatgptweb/test/browser/chatGPTClient.test.ts \
  --run src/ash/sessions/contrib/chatgptweb/test/browser/chatGPTService.test.ts \
  --run src/ash/sessions/contrib/chatgptweb/test/browser/chatgptList.test.ts \
  --run src/ash/sessions/contrib/chatgptweb/test/electron-main/chatGPTTransport.test.ts \
  --grep 'rate-limited history reads|visible history after reconnect|loaded transcript|preserves Retry-After|post-reply read|flapping reconnects|shares one history notification'
```

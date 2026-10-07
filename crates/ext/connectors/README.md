# Connectors extension

- `ash-connectors-extension` 统一管理外部账号定义、连接状态、目录发现、持久化和认证流程；调用方通过 `connectors` 引用。
- 原 `crates/connectors` 的类型、状态机和测试已合入本 crate，公共类型从 crate 根导出。
- `connection`、`definition`、`identity`、`snapshot` 负责数据校验和状态转换；`catalog` 负责 Plugin 声明转换与目录发现。
- `authority` 负责连接状态、事件与命令回执；认证服务通过注入的 `SecretStore` 保存凭据。
- Secret backend 属于 `ash-secrets`，MCP 会话与工具组合属于 `ash-mcp-extension`，产品协议属于 App Server。
- 跨系统语义见 [`docs/connectors.md`](../../../docs/connectors.md)。

## 连接状态契约

| 类型                                                    | 职责                               |
| ------------------------------------------------------- | ---------------------------------- |
| `ConnectorId` / `ConnectorAccountId`                    | 分别标识外部服务声明和外部账号     |
| `ConnectorDefinition` / `ConnectorDefinitionDigest`     | 服务描述、运行时绑定与授权版本摘要 |
| `ConnectorRuntimeBinding`                               | 当前支持 MCP server ID；不持有会话 |
| `ConnectorAccount` / `ConnectorCredentialRef`           | 账号信息和凭据引用；不包含凭据内容 |
| `ConnectorConnection` / `ConnectorConnectionGeneration` | 连接状态与单调递增的连接代次       |
| `ConnectorSnapshot` / `ConnectorSnapshotGeneration`     | 不可变目录与单调递增的快照代次     |

- 身份和展示文本拒绝空值、控制字符、首尾空白和超长输入。
- `Begin` 使用更大的连接代次进入 `Connecting`；`Connected` 必须匹配该代次，不能跳过 `Connecting`。
- `Unavailable` 只接受当前连接代次并保留经过校验的原因；重新连接必须开始新的代次。
- `Disconnect` 推进连接代次并立即撤销可调用状态；每次状态更新还必须推进快照代次。
- 重复身份、未知 Connector、过期快照和过期连接结果均返回错误。
- 授权摘要包含 ID、运行时绑定和授权版本，不包含展示文案或凭据；Plugin 来源使用完整 package digest。
- 定义变化使已连接账号进入 `ReauthorizationRequired`，保留账号信息，但立即撤销可调用状态。
- Connector 连接不要求用户登录 Ash；云端目录和同步不能改变本地连接状态契约。

## 当前公共契约

| Symbol                                           | 职责                                                                                    | 关键失败语义                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ConnectorCatalog::from_activation`              | 从 exact activation package digest 构造授权兼容 revision                                | duplicate identity / invalid contribution fail closed                  |
| `ConnectorCatalog::from_packages`                | 用调用方提供的 package 集合构造目录                                                     | 不提供 activation generation                                           |
| `ConnectorCatalog::from_manifests`               | 从 manifest 读取服务声明                                                                | 不覆盖 MCP definition 文件内容；生产 activation 应优先使用 package API |
| `ConnectorAuthority::open_sqlite`                | 恢复 snapshot、事件和 command receipts                                                  | event + receipt 在一个 SQLite transaction 中提交                       |
| `ConnectorAuthority::apply`                      | expected-generation CAS 与 exact command replay                                         | 同 ID 不同 payload 为 `CommandConflict`                                |
| `ConnectorCredentialService::connect_api_token`  | Begin → secret store → Complete                                                         | secret store 失败时不会发布 `Connected`                                |
| `ConnectorCredentialService::disconnect`         | 先撤销 readiness，再 best-effort delete secret                                          | cleanup 失败返回 `RetryRequired`，不回滚断连                           |
| `ConnectorAuthority::with_authorized_invocation` | 把 dispatch 与 disconnect commit 线性化                                                 | stale generation/digest 不执行 closure                                 |
| `ConnectorOAuthService`                          | state + PKCE + exact redirect、one-shot callback、refresh/revoke 编排                   | provider wire protocol 与 callback host 由 adapter/产品拥有            |
| `ConnectorDeviceOAuthService`                    | device-code attempt、provider interval/slow-down、expiry/cancel 与 authority transition | device code 只驻留内存，不进入 protocol、history 或 SecretStore        |
| `ConnectorOAuthProvider`                         | 一个具体服务的授权 URL 与 code exchange 端口                                            | 不持久化 secret，不修改 authority                                      |
| `GitHubBrokeredOAuthProvider`                    | 经产品 broker 执行 PKCE exchange/refresh/revoke                                         | client 不持有 GitHub App secret；broker deployment 不属于本 crate      |
| `GitHubDeviceOAuthProvider`                      | GitHub public-client device grant 与账户读取                                            | 无 client secret；不声明 GitHub 未提供的 refresh/remote revoke         |
| `GitHubOAuthProvider`                            | confidential direct GitHub adapter                                                      | 仅供可信 host 显式注入 client secret                                   |

## 内部调用路径

```text
ConnectorCredentialService::connect_api_token
  -> phase_command_id
  -> ConnectorAuthority::apply(BeginConnect)
       -> command::command_digest
       -> authority::event_for_request
       -> SqliteAuthority::persist
  -> SecretStore::store
  -> ConnectorAuthority::apply(CompleteConnect)

ConnectorAuthority::open_sqlite
  -> SqliteAuthority::open
  -> load_latest_records + load_receipts
  -> PersistedRecord::restore
  -> ReauthorizationRequired when definition digest changed
```

`authority::event_for_request` 拥有 command 到 durable event 的绑定；`SqliteAuthority::persist` 拥有
event/receipt 原子性；`auth::credential_key` 只生成 hashed non-PII key。若这些 helper 开始读取 token bytes、
启动 MCP，或 App Server 直接写 SQLite，即表示 ownership 漂移。
`ConnectorAuthority::open_sqlite` 只定义 Connector 表和事务；文件权限、WAL、同步级别与 busy timeout
使用 `ash-state` 的 durable SQLite 打开规则。数据库路径由 App Server 注入的 `StateRuntime` 决定。

当前实现 API-token adapter、browser-code OAuth 的通用 PKCE 状态机与 device grant 状态机。`oauth::PendingOAuthAttempt`
只在内存保存 flow ID、state 和 verifier；`ConnectorOAuthService::complete` 一次性消费 callback，
并在过期、state mismatch、provider 或 credential failure 时提交 `Unavailable`。Desktop loopback
listener/browser interaction 已由 Electron main 持有。`device_oauth::PendingDeviceOAuthAttempt` 只在内存
保存 device code，并严格执行 provider interval、GitHub `slow_down + 5s`、expiry 与 cancel。

产品默认可选择 `GitHubBrokeredOAuthProvider`：client 只发送 PKCE verifier，GitHub App secret 留在发行方
broker；或选择 `GitHubDeviceOAuthProvider`：仅需 public client ID。旧的 `GitHubOAuthProvider` 继续作为可信
host 直连 adapter。OAuth secret 以 runtime token 与 lifecycle bundle 分层封装，MCP projection 只能拿到
runtime token。远端 revoke 成功后才提交本地 disconnect；失败时保留 ready connection 以便重试。
不能通过扩张 authority event payload 来保存 OAuth code、refresh token 或 raw credential。生产 profile 私有文件 backend 位于 `ash-secrets`，OS keyring adapter 位于独立 `ash-keyring-store`；两者均不属于本 crate，由 host composition 选择并注入。

验证入口：

```bash
just check ash-connectors-extension
just test ash-connectors-extension
just rust-warnings ash-connectors-extension
```

- 原状态机测试随实现迁入 `connector_tests.rs`；目录发现测试位于 `catalog_tests.rs`。
- 现有测试覆盖连接代次、授权失效、目录发现、SQLite 恢复与命令重放、凭据清理、OAuth 和 device flow。
- MCP 调用边界由 `ash-mcp-extension` 测试覆盖；产品请求与通知由 App Server 的 `connector_operations_tests` 覆盖。

- `load_connector_declaration` 通过所属执行环境的 `FileSystem` 读取有界声明；Marketplace 通过同一入口绑定服务定义。

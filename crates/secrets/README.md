# `ash-secrets`

> 本 README 解释 opaque secret value、store port 与 backend obligation。跨系统 credential ownership 和 backend policy 见 [`docs/secrets.md`](../../docs/secrets.md)；OS keyring adapter 见 [`ash-keyring-store`](../keyring-store/README.md)。

`ash-secrets` 只保存 opaque bytes。OAuth、token refresh、account metadata、credential scope、
request signing 和 Provider header materialization 均属于消费它的 domain runtime。

## 公共契约

| Symbol                   | 职责                                       | 安全语义                                                                                  |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `SecretKey`              | 非 secret 的 stable lookup identity        | 非空、最多 512 bytes、禁止 control character                                              |
| `SecretValue`            | opaque secret bytes                        | 不实现 Clone/Display/Serialize；Debug 固定 redacted；Drop zeroize                         |
| `SecretStore`            | availability、`load / store / delete` port | namespace isolation、sanitized error、完整三操作                                          |
| `DeleteSecretOutcome`    | exact delete result                        | 区分 `Deleted` 与 `NotFound`                                                              |
| `MemorySecretStore`      | process-local ephemeral backend            | replacement、delete、drop 时 zeroize stored bytes                                         |
| `UnavailableSecretStore` | explicit fail-closed backend               | 所有操作返回 `BackendUnavailable`                                                         |
| `FileSecretStore`        | profile-scoped durable backend             | hashed filenames、私有权限、有界读取、同步 staging 与 replace；所有值路径逐级拒绝 symlink |
| `ProfileSecretStore`     | profile 持久存储 backend                   | 默认加密文件、显式 file 选择、跨进程锁、可恢复迁移，无 fallback                           |
| `SecretStoreError`       | sanitized error                            | message 不能包含 secret/header/raw backend response                                       |
| `SecretStoreErrorKind`   | stable caller classification               | unavailable、access denied、backend failure、key missing、invalid data、migration failed  |

`SecretKey` 的内容会出现在 `Debug`，因此 key schema 不能包含 token、email 或其他敏感 identifier。
Key schema 由调用 domain 拥有，本 crate 只验证基本安全 shape。

## 内部接口与调用路径

| Symbol                       | 可见性                    | 当前职责                                           |
| ---------------------------- | ------------------------- | -------------------------------------------------- |
| `SecretValue::expose`        | public explicit borrow    | 唯一取得 plaintext bytes 的路径；borrow 应尽量短   |
| `MemorySecretStore::values`  | private mutex map         | 保存 owned byte copies，不保存 `SecretValue` clone |
| `lock_error`                 | private function          | poisoned mutex → sanitized `BackendFailure`        |
| `unavailable`                | private function          | 三个 unavailable operations 共用稳定错误           |
| `Drop for SecretValue`       | impl                      | zeroize caller-owned secret buffer                 |
| `Drop for MemorySecretStore` | impl                      | zeroize map 中所有 surviving values                |
| `key_filename`               | private function          | domain-separated SHA-256 key → non-PII filename    |
| `promote_file`               | private platform function | synced staging → destination replacement           |
| `cleanup_staging_files`      | private function          | open 时清理同 namespace 的 stale `.tmp-*` 文件     |

```text
store(key, SecretValue)
├─ SecretValue::expose (short borrow)
├─ copy bytes into backend
├─ replace old bytes
└─ zeroize replaced buffer

load(key)
├─ backend copies opaque bytes
└─ SecretValue::new → caller-owned zeroizing value

delete/drop
└─ zeroize backend-owned bytes before release
```

方向偏差：

- `SecretValue` 增加 `Clone`、`Display` 或 serde：secret 传播面失控；
- backend error 包含 command/header/raw response：sanitization boundary 被破坏；
- `MemorySecretStore` 被当作 production persistence：进程退出即丢失；
- unavailable host 返回空值而非 error：credential absence 与 backend failure 混淆；
- API/network layer 直接读 `SecretStore`：credential lifecycle ownership 下沉错误。

## 后端实现清单

生产后端必须实现完整 load/store/delete、隔离 Ash namespace、定义 overwrite atomicity、
sanitized errors 和 negative logging tests。只有 load 没有 delete 的 backend 不满足 trait 语义。

内存 zeroize 降低残留风险，但不保证编译器、allocator、swap、core dump 或 backend copy 中不存在
副本；系统级保护仍由 OS facility、process hardening 和 caller lifecycle 负责。

## 测试与修改路径

```text
cargo test -p ash-secrets
bazel test //crates/secrets:secrets-unit-tests
```

当前测试覆盖 memory/file round-trip、replace/delete、Debug redaction、key validation、unavailable error、Unix 0700/0600 权限、symlink 拒绝、stale staging cleanup、key filename 隐藏与 1 MiB 上限；Windows 实现 owner-only protected DACL 与 write-through atomic replacement。
新增 backend 时必须补 error/log/debug negative tests，并证明 replacement/delete/drop 的 secret
buffer 处理。

## 当前限制与演进

当前具有 memory、unavailable、私有明文文件和认证加密文件 backend。`ProfileSecretStore` 是本地产品默认，host 注入 `ash-keyring-store::KeyringSecretStore` 只保存随机主密钥。文件使用 AES-256-GCM，随机 nonce、版本头与绑定文件名的 AAD；AES key schedule 和 `SecretValue` 在释放时清理。Unix 使用 0700/0600 与原子 rename，Windows 使用 owner-only protected DACL 与 write-through atomic replacement。

`open` 不访问 keyring。第一次操作或 `check_availability` 在跨进程文件锁下初始化主密钥并迁移旧 `values/`：密文进入 `encrypted/values/`，重读校验后才删除对应明文。中断后继续迁移，冲突时保留两份；key 缺失、错误或密文损坏返回稳定分类，绝不降级到明文或静默重置。每次操作重新读取 keyring，避免缓存绕过访问撤销。`check_availability` 同时验证现有密文。

`ProfileSecretStore` 默认 encrypted，也支持用户显式选择 file：选择与迁移日志保存于 root 的
`storage-mode`。两种模式沿用同一跨进程锁和私有文件 IO，切换先验证、逐项写入并重读核对后才
清理源值；崩溃后恢复，缺失原密钥及冲突不降级。`SecretStore::storage_mode` 与
`set_storage_mode` 用于这类可配置 profile，注入 store 默认不提供选择。

`FileSecretStore` 保留作为显式 backend 和迁移源；其他平台仍明确返回 `BackendUnavailable`。密钥轮换与 profile/keyring 备份恢复尚无自动管理。后续 backend 不得扩大 `SecretValue` 的复制、序列化或日志接口。

产品入口现通过 [`ash-process-hardening`](../process-hardening/README.md) 在读取本 store 前执行进程保护；密钥存储不自行改变进程级环境或调试策略。

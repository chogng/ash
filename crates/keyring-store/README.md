# `ash-keyring-store`

> 跨系统 secret ownership 与 backend policy 由
> [`docs/secrets.md`](../../docs/secrets.md) 维护；provider-neutral value/store contract 由
> [`ash-secrets`](../secrets/README.md) 维护。

`ash-keyring-store` 把平台原生 credential facility 适配为 `ash_secrets::SecretStore`。它不建立第二套
secret trait，不解释 credential 内容，也不拥有 OAuth、refresh、revoke、Connector account 或 Plugin
credential slot lifecycle。

## 公共契约

| Symbol                                                       | 当前职责                                                   | 不承担                           |
| ------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------- |
| `KeyringSecretStore::for_profile`                            | canonical profile root → isolated native keyring namespace | profile authority、fallback 选择 |
| `SecretStore` implementation                                 | opaque binary `load/store/delete`                          | token parsing、account lookup    |
| `read_credential` / `write_credential` / `delete_credential` | 访问调用方明确指定的条目，写入授权和并发校验由认证领域负责 | 枚举、解析 token、决定是否刷新   |

`KeyringSecretStore` 的 OS-visible service 固定为 `com.ash.secret-store.v1`。Account 是 profile namespace 与 `SecretKey` 的
domain-separated SHA-256，不包含 profile path、email、Connector ID 或原始 key。Value 使用 keyring 的
binary secret API，不进行 UTF-8 转换；输入上限为 1 MiB。

## 内部调用路径

```text
KeyringSecretStore::for_profile
├─ canonicalize profile root
├─ profile_namespace
└─ SystemKeyringBackend

SecretStore::{load,store,delete}
├─ KeyringSecretStore::account
├─ keyring::Entry::new
└─ get_secret / set_secret / delete_credential
   └─ classify_keyring_error → sanitized SecretStoreError
```

`KeyringBackend` 是 private test seam；consumer 不得依赖 keyring crate types。`NoEntry` 映射为
`None`/`NotFound`，`NoStorageAccess` 映射为 `AccessDenied`，其他 backend detail 统一净化为
`BackendFailure`。错误不得包含 service、account、raw platform response 或 secret bytes。

## 平台与失败语义

- macOS：Apple native Keychain；
- Windows：Windows Credential Manager；
- Linux：native async persistent Secret Service；
- FreeBSD/OpenBSD：同步 Secret Service；
- 其他 target：构造时返回 `BackendUnavailable`。

构造成功只表示平台 adapter 已编译；实际 desktop session/keyring daemon 拒绝访问时，具体 operation
仍会 fail closed。这里不实现自动文件 fallback，避免 backend 暂时不可用时读取另一份过期 credential。

## 验证与扩展点

```text
cargo test -p ash-keyring-store
cargo clippy -p ash-keyring-store --all-targets --no-deps -- -D warnings
```

测试使用 private fake backend，不访问开发者真实 keyring，覆盖 binary round trip、replace/delete、
profile isolation、metadata hashing、error sanitization 和 size limit。新增平台 adapter 时必须继续实现
完整三操作，并同步本文与 [`docs/secrets.md`](../../docs/secrets.md)。

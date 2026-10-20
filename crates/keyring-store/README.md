# `ash-keyring-store`

> 跨系统 secret ownership 与 backend policy 由
> [`docs/secrets.md`](../../docs/secrets.md) 维护；provider-neutral value/store contract 由
> [`ash-secrets`](../secrets/README.md) 维护。

`ash-keyring-store` 把平台原生 credential facility 适配为 `ash_secrets::SecretStore`。它不建立第二套
secret trait，不解释 credential 内容，也不拥有 OAuth、refresh、revoke、Connector account 或 Plugin
credential slot lifecycle。

本地默认组合将它注入 `ProfileSecretStore`，只保存 profile 的随机主密钥；业务凭据保存在认证加密文件中。显式 host 仍可选择直接把业务凭据保存到 keyring。两种模式无自动 fallback 或双写。

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
- Linux：native sync persistent Secret Service，使用 keyring 的 libdbus 后端并静态构建 libdbus；
- FreeBSD/OpenBSD：同步 Secret Service；
- 其他 target：构造时返回 `BackendUnavailable`。

macOS 的普通读取、写入、删除及显式命名条目复用均关闭 Keychain 用户交互；需要授权的条目返回
`AccessDenied`，不会弹系统密码或授权窗口。完整 OS 操作由进程级锁串行，恢复交互状态也在锁内
完成，避免并发后台读取借用另一个请求的授权窗口。

只有显式 `secrets/authorize` 或用户选择 encrypted 存储的操作通过 `with_user_authorization` 允许
系统交互。授权范围绑定同步调用线程，返回或 unwind 后恢复；不会形成允许后台弹窗的持久设置，
也不会永久关闭进程内的系统交互。关闭交互失败时不会继续调用 keyring。

构造成功只表示平台 adapter 已编译；实际 desktop session/keyring daemon 拒绝访问时，具体 operation
仍会 fail closed。这里不实现自动文件 fallback，避免 backend 暂时不可用时读取另一份过期 credential。

Linux 从 zbus 后端切换到 libdbus 后端时，仍使用 keyring 3 的同一份条目查找和写入实现：
`service`、`username`、`target` 属性及旧默认 collection 的兼容查找保持一致，不重命名条目或轮换主密钥。
Cargo.lock 仍包含 keyring 的可选 async／OpenSSL 依赖，但所有目标和 workspace features 的活动
依赖图均不选择它们；依赖安全门禁继续检查实际依赖，不为旧 zbus 公告添加例外。

## 验证与扩展点

```text
just verify ash-keyring-store
```

普通测试使用 private fake backend，不访问开发者真实 keyring，覆盖 binary round trip、replace/delete、
profile isolation、metadata hashing、error sanitization 和 size limit。新增平台 adapter 时必须继续实现
完整三操作，并同步本文与 [`docs/secrets.md`](../../docs/secrets.md)。

Windows 的真实 keyring 验证需显式运行；Linux 也使用同一测试，但必须在隔离、已解锁的测试
Secret Service 中执行，不能连接开发者的日常 keyring：

```text
just test ash-keyring-store --test system_keyring -- --ignored --exact real_keyring_round_trip_and_process_restart
```

该测试使用独立临时 profile，通过三个独立子进程验证平台二进制读写、覆盖、删除及加密
profile 的重启恢复，并确认主密钥没有轮换。父进程在成功或失败后清理两个测试条目，再删除
临时目录；普通 App Server 单元测试的密钥则随临时目录清理，不能使用持久 OS keyring。

Linux 的 `existing_secret_service_attributes_remain_readable` 测试还使用 `secret-tool` 独立写入
带有／没有默认 `target` 的已有条目，验证 Ash 能读取、原位更新和删除它们。需要 `dbus-run-session`、
`gnome-keyring-daemon` 和 `secret-tool`；测试会访问当前 session bus，因此只能显式运行在临时 HOME
与 XDG 目录的隔离会话中。

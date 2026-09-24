# ash-utils-path

`ash-utils-path` 提供三项本机文件系统操作：检查路径是否留在指定目录内、拼接受约束的相对路径、原子替换文件。它只报告路径和文件系统事实；访问权限与具体存储策略由调用方决定。

## 公开接口

| 接口 | 行为 | 失败或边界 |
| --- | --- | --- |
| `CanonicalPathRoot::new` | 从已存在的根路径建立检查范围 | 根路径无法规范化时返回 I/O 错误 |
| `canonicalize_within` | 跟随符号链接，返回仍在范围内的实际路径 | 路径不存在或无法读取时返回 `Unavailable`；越界返回 `OutsideRoot` |
| `inspect_without_symlinks` | 从根目录逐级检查路径，不跟随符号链接 | 区分 `Existing`、`Missing`、`OutsideRoot`、`Symlink` 和 `Unavailable` |
| `join_descendant` | 在绝对根路径下拼接非空相对路径，保留操作系统路径字节 | 拒绝父级、根和平台前缀；不检查文件系统 |
| `write_atomically` | 在目标目录写入临时文件，保留已有目标的权限，同步文件后替换目标 | 替换前失败时保留旧文件；替换后的目录同步失败仍会报错，此时新内容已经可见 |

## 使用边界

- `join_descendant` 只检查路径写法。读取或写入前，调用方仍需检查实际路径和自己的访问规则。
- 只需表示不一定存在的绝对路径时，使用 [`ash-utils-absolute-path`](../absolute-path/README.md)；需要跨进程传递文件位置时，使用 [`ash-utils-path-uri`](../path-uri/README.md) 或所属协议的相对路径。
- 本 crate 不保存会话状态，也不决定 workspace 授权。

## 平台行为

- 在 WSL 的 `/mnt/<drive>` 路径上，`CanonicalPathRoot` 比较实际路径时按 ASCII 忽略大小写；返回给调用方的路径不因此改写。
- Windows 上，`write_atomically` 在文件操作期间将磁盘和 UNC 路径转为绝对扩展路径。扩展格式不会写入配置或传给子进程。

## 当前限制与扩展点

- `canonicalize_within` 要求目标已存在，且会跟随符号链接。检查尚未创建的路径或禁止符号链接时，使用 `inspect_without_symlinks`；两种检查不能互相替代。
- `inspect_without_symlinks` 只报告检查时的状态，无法阻止检查后路径被修改。需要抵抗并发修改的文件操作应由执行操作的模块使用目录句柄等平台机制，不能只增加一次路径检查。
- `write_atomically` 不提供跨进程锁。替换后会在 Unix 上同步父目录；Windows 目前不做目录同步。
- Windows 扩展路径只覆盖 `write_atomically` 的文件操作；其他文件操作需要在各自的操作入口处理长路径，单个路径组件仍受文件系统限制。

## 验证

```text
just test ash-utils-path
bazel test //ash-rs/utils/path-utils:path-utils-unit-tests
```

修改路径范围、WSL 比较或原子写入行为时，同步更新 `src/path_utils_tests.rs` 和本文档。

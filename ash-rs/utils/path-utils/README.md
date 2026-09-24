# ash-utils-path

> 本 README 是本 crate 当前实现契约的 canonical owner。跨进程文件位置 identity 的契约由
> [`ash-utils-path-uri`](../path-uri/README.md) 拥有；Session cwd 与文件系统系统语义仍由对应
> `docs/*.md` 文档拥有。

`ash-utils-path` 处理当前 host 文件系统上的 canonical containment、受约束的相对路径拼接和原子替换。
它不定义远程文件身份、workspace 授权边界或 Session 恢复策略。

## 边界与公共契约

| API | 当前职责 | Failure semantics |
| --- | --- | --- |
| `join_descendant` | 绝对根路径下拼接非空相对路径，保留操作系统路径字节 | 拒绝父级、根与平台前缀；不检查符号链接或授予访问权限 |
| `CanonicalPathRoot::new` / `canonicalize_within` | 缓存 canonical root，并验证 existing candidate 的真实 host path containment | candidate 不可用与 canonical path 逃出 root 分别返回 `Unavailable` / `OutsideRoot` |
| `CanonicalPathRoot::inspect_without_symlinks` | 从 canonical root 到 candidate 逐级读取 metadata，不跟随任何 symlink | 区分 existing、missing、越界、symlink 与 metadata failure；不执行删除或写入 |
| `write_atomically` | 同目录临时文件写入、保留已有权限、flush、rename、目录 sync；Windows 文件操作使用绝对扩展路径 | rename 前失败保留旧 destination；rename 后目录 sync 失败会在新内容已可见时返回错误 |

`CanonicalPathRoot` 只报告路径事实，不决定访问权限。`write_atomically` 不拥有上层配置 schema、revision 或 locking。

## 文件、内部所有权与调用关系

| 文件 / private symbol | Ownership |
| --- | --- |
| `canonical_root.rs::normalize_for_wsl_on` | root containment 比较时处理 WSL `/mnt/<drive>` 大小写 |
| `canonical_root.rs::is_wsl_case_insensitive_path` | 精确识别 Windows drive mount，不把普通 Linux path 当成 case-insensitive |
| `canonical_root.rs::CanonicalPathRoot::comparison_path` | root 的 host-aware comparison identity，不改变返回给 caller 的 canonical path |
| `canonical_root.rs::is_wsl` | 仅供 root containment 比较使用的 WSL 环境检测 |
| `persistence.rs::sync_parent` | rename 后 durability checkpoint |
| `persistence.rs::filesystem_path` | Windows 写入期间把 drive/UNC 路径转换为文件系统可用的扩展路径，不改变调用方保存的路径 |

```text
CanonicalPathRoot::canonicalize_within
  → canonicalize(candidate)
  → normalize canonical root + candidate for host comparison (WSL drive mounts)
  → component-aware starts_with

CanonicalPathRoot::inspect_without_symlinks
  → lexical containment
  → symlink_metadata(root..candidate)
  → Existing | Missing | OutsideRoot | Symlink | Unavailable

write_atomically
  → Windows：为本次文件操作生成绝对扩展路径
  → create parent
  → NamedTempFile + write + sync
  → persist(rename)
  → sync_parent
```

如果这里开始保存 Session 状态、解析 URI、决定 workspace grant 或决定哪个目录可以删除，表示
ownership 已经漂移。`inspect_without_symlinks` 只报告路径事实，是否允许操作仍由 caller 决定。

## 集成与测试

`ash-install-context` 的随包资源定位和 `ash-file-access::Dir` 的路径解析复用 `join_descendant`。
文件访问层仍负责后续真实路径范围与符号链接检查；词法拼接成功不代表操作已获授权。

consumer 只应依赖本 crate 的公开 API，不应依赖 private module。需要跨 RPC 序列化的路径应使用
`ash-utils-path-uri` 或所属 protocol 的 root-relative path contract。

```text
just test ash-utils-path
bazel test //ash-rs/utils/path-utils:path-utils-unit-tests
```

修改 WSL、containment 或 atomic-write failure semantics 时必须同步更新
`path_utils_tests.rs` 和本 README。`external-agent-migration` 消费 canonical containment；`ash-state`、`ash-secrets`、`ash-attachment-store` 与 `ash-core-plugins` 消费 no-follow inspection，并分别拥有索引、secret、attachment 与 package store 的操作策略。

## 当前限制与扩展点

- Current：`canonicalize_within` 要求 candidate 存在；不存在路径使用 `inspect_without_symlinks` 检查。
- Current：`canonicalize_within` 跟随 symlink；需要禁止 symlink 的 consumer 使用独立的
  `inspect_without_symlinks`，两种策略不互相替代。
- Current：no-follow 检查与后续 caller 操作之间仍存在文件系统竞态；需要抵抗同用户并发篡改的操作应使用平台级目录句柄方案。
- Current：atomic replace 不提供跨进程 locking，caller 必须自行拥有并发控制。
- Current：Windows 不尝试 sync directory handle。
- Current：Windows 扩展路径只在 `write_atomically` 的文件操作内使用，不保存到配置、协议或子进程参数；单个路径组件仍受文件系统限制。

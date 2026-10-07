# ash-utils-absolute-path

> 本 README 是 `AbsolutePathBuf` 实现契约的 canonical owner。当前 host 的 canonicalization、
> containment 与原子写入由 [`ash-utils-path`](../path-utils/README.md) 拥有；跨 host 可序列化的
> 文件位置 identity 由 [`ash-utils-path-uri`](../path-uri/README.md) 拥有；workspace 边界与
> relative path 授权由 [`ash-file-access`](../../file-access/README.md) 拥有。

`ash-utils-absolute-path` 做三件事：

1. 把任意路径写法收敛成一个类型层面保证绝对、且已折叠 `.` 与 `..` 的值 `AbsolutePathBuf`；
2. 在构造前应用当前 host 的写法规则：`~` 展开成 home，Windows verbatim 前缀还原成普通 drive 或 UNC 路径；
3. 提供线协议：serde、JSON Schema、TS 都是一个字符串，反序列化时用线程内 base directory 补齐相对路径。

规范化全部是词法的，不读文件系统，所以值可以指向不存在的路径，也保留 caller 给的 symlink 和平台别名。

## 公共契约

| API                              | 当前职责                                         | Failure semantics                                                        |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `AbsolutePathBuf::from_absolute` | 接受已经绝对的路径，先展开 `~`                   | 其余写法返回 `io::ErrorKind::InvalidInput`，不访问文件系统               |
| `resolve_against_base`           | 把任意写法锚定到 `base_directory`                | 不会失败：base 已由类型保证绝对                                          |
| `resolve_against_current_dir`    | 把任意写法锚定到进程工作目录                     | 只有真正需要工作目录时才读取它，绝对路径在工作目录被删除后仍然成功       |
| `current_dir`                    | 返回进程工作目录                                 | 工作目录不可用时返回 `io::Error`                                         |
| `join`                           | 以自身为 base 锚定；`path` 绝对时整体替换        | 不会失败                                                                 |
| `canonicalize`                   | 在文件系统上解析 symlink 与平台别名              | 路径不存在返回 `io::Error`；Windows 返回普通 drive/UNC 写法而不是 `\\?\` |
| `parent` / `ancestors`           | 词法向上遍历，元素仍然绝对                       | 根目录的 `parent` 是 `None`                                              |
| `with_base_directory`            | 在 `operation` 期间为反序列化提供 base           | 线程内生效，`operation` 必须在调用线程上完成                             |
| `with_home_directory`            | 在 `operation` 期间用显式 home 覆盖操作系统 home | 同上                                                                     |

`Deref<Target = Path>` 暴露 `file_name`、`extension`、`starts_with`、`to_string_lossy` 等只读查询，因此这里不重复定义。`Ord` 与 `Hash` 比较规范化后的写法，不比较文件系统对象；两个指向同一 inode 的路径不相等。

`~` 只展开 `~` 和 `~/rest`（Windows 上也接受 `~\rest`）。`~other/code` 保持原样，因此会被 `from_absolute` 判为非绝对路径。

## 反序列化契约

`AbsolutePathBuf` 的 `Deserialize` 是手写的，行为取决于当前线程是否处于 `with_base_directory` 作用域：

```text
with_base_directory(&base, ...)  → 相对路径锚定到 base，绝对路径忽略 base
无作用域 + 绝对路径              → 直接接受
无作用域 + 相对路径              → 报错 "path must be absolute outside with_base_directory"
```

config 文件里的相对路径应当在 `with_base_directory(&config_directory, ...)` 内读取，这样 `../` 与 `~` 的含义由加载方显式决定，而不是由进程工作目录偶然决定。作用域可以嵌套，退出内层会恢复外层的值。

## 文件与内部所有权

| 文件 / private symbol                  | Ownership                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `absolutize.rs::normalize`             | `.` / `..` 折叠，只对已绝对的路径调用                                                |
| `absolutize.rs::path_with_base`        | POSIX 与 Windows 的 base 锚定规则，包含 Windows root-relative 与 drive-relative 写法 |
| `resolution.rs::expand_home_directory` | `~` 与 `~/rest` 的展开边界                                                           |
| `resolution.rs::Restore`               | 嵌套作用域退出时恢复外层 base/home，而不是清空                                       |
| `lib.rs::prepare`                      | 构造前的写法规范化，绝对性判断之前执行                                               |

```text
from_absolute
  → prepare（expand_home_directory → dunce::simplified）
  → is_absolute 检查
  → absolutize::normalize

resolve_against_base / join
  → prepare
  → absolutize::absolutize_from
      → path_with_base
      → normalize

Deserialize
  → BASE_DIRECTORY 线程局部值
  → resolve_against_base | from_absolute
```

`absolutize.rs` 的词法实现改编自 path-absolutize 3.1.1（MIT）。保留本地实现是为了让显式 base 的解析无失败路径，只有读取进程工作目录仍然可失败。

如果这里开始做 containment 判定、跟随 symlink 决定目录授权、或解析 `file:` URI，表示 ownership 已经漂移到 `ash-utils-path`、`ash-file-access` 或 `ash-utils-path-uri`。

## 集成与测试

- [`ash-file-access`](../../file-access/README.md) 用本类型保存宿主给出的目录写法，[`ash-agent-environment`](../../agent-environment/README.md) 用它保存 cwd 与可访问目录。
- [`ash-utils-path-uri`](../path-uri/README.md) 只在当前宿主的 `PathUri` 转换边界接收和返回本类型；跨宿主文件身份使用 `PathUri`，Workspace 内 RPC 继续使用由 Rust 权限边界约束的相对 `PathBuf`。
- 持有 `AbsolutePathBuf` 不代表获得读写授权，调用方仍须验证 Workspace 或能力边界。

```text
just test ash-utils-absolute-path
bazel test //crates/utils/absolute-path:absolute-path-unit-tests
```

`absolute_path_tests.rs` 覆盖构造、base 锚定、`.`/`..` 折叠、工作目录缺失、`~` 展开与作用域嵌套、canonicalize、serde 往返，以及 Windows verbatim、root-relative 与 drive-relative 写法。工作目录被删除的用例在子进程中运行，因为它修改进程级状态。修改绝对性判定、`~` 边界或反序列化行为时必须同步更新该文件与本 README。

## 当前限制与扩展点

- Current：`ash-file-access`、`ash-agent-environment` 与 `ash-utils-path-uri` 已在各自的绝对路径边界使用本类型。
- Current：只表示当前 host 的路径写法；在 Linux 上不解析 Windows drive 写法，需要跨 host 时用 `PathUri`。
- Current：`with_base_directory` 与 `with_home_directory` 是线程局部的，跨线程或跨 `.await` 的反序列化不继承作用域。
- Current：比较大小写敏感；filesystem 的 case-folding 属于 consumer。
- Extension point：config 与 protocol 采用该类型时，应同时确定 base directory 由谁提供，否则相对路径会在无作用域时直接报错。

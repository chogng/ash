# `ash-file-search`

> 本 README 是 文件路径枚举、glob 与 fuzzy search 的实现契约。TUI `@file` 交互由
> [Ash Code README](../tui/README.md#命令与补全) 维护。Agent 与编辑器的文件内容搜索见
> [`crates/grep/README.md`](../grep/README.md)；可执行文件的
> discovery 与冻结边界见 [`crates/shell-command/README.md`](../shell-command/README.md)。

- `Service` 提供已授权目录内的 glob 查询，以及路径模糊搜索的创建入口。
- glob 读取当前磁盘路径；模糊查询用 Nucleo 匹配已发现的路径或请求持有的后台路径索引。
- Agent、CLI、TUI 和桌面消费公共能力；TS 工作区文件选择器通过 App Server 的 `file/search/fuzzy` 与 `file/search/glob` 接入。调用方负责授权、取消、交互与输出。
- 不读取候选文件内容、不注册模型 Tool、不拥有 TUI popup/token 状态。

公共路径搜索能力的职责和实现状态统一见[搜索架构](../../docs/search.md#目标依赖关系)
和[实现状态](../../docs/search.md#实现状态)。

## 文件与职责

```text
src/
├── lib.rs                    # Service、PathSearchHandle、worker 与 snapshot
├── discovery.rs              # 磁盘 walker 与引擎清单共用的目录准入
├── ranking.rs                # 无 I/O 的有界排序，磁盘服务和 tgrep 共用
├── ranking_tests.rs          # 排序、截断、Unicode、高亮与输入迭代失败
├── glob.rs                   # 有界 glob 枚举、排序、范围校验与取消
├── glob_tests.rs             # ignore/override、排序、越界与取消
├── file_search_tests.rs      # 增量 query、ignore、排序和高亮索引
├── main.rs                   # ash-file-search 的薄进程入口与 exit status
├── cli.rs                    # 参数、snapshot wait 与 stdout/stderr 输出
└── cli_tests.rs              # CLI 参数、JSON 与 plain-text output
```

## 公共契约

`Service::fuzzy(root, query, max_results, cancellation)` 在调用线程内发现当前磁盘路径，
用公共评分模块保留最高分的前 N 项，平分时按路径排序，并返回截断前的匹配总数。
查询最多 1 KiB，结果上限为 1–5,000；发现和评分期间检查取消与 30 秒期限。
发现、评分与高亮在返回前结束，目录授权覆盖整个操作；高亮只计算保留的结果。

TS 文件查询由 App Server 通过公共 grep 的同一目录注册，请求 tgrep 在自己的路径清单上评分并返回前 N 项。
[`ranking.rs`](src/ranking.rs) 是纯计算模块，只依赖固定版本的 Nucleo matcher；构建时按
[`runtime-lock.json`](../../third_party/tgrep/runtime-lock.json) 的哈希编译进引擎，避免复制另一套评分与高亮规则。
[`discovery.rs`](src/discovery.rs) 的目录排除规则同样按哈希编译进引擎；候选准入属于路径发现，评分不排除目录。
目录元数据、ignore、变更确认和索引租约由引擎管理，文件名查询不等待内容建索引；
Ash 只接收有界结果，不缓存完整目录路径。
配置关闭索引时，`Service::fuzzy` 使用当前磁盘路径搜索并等待本次查询完成；
引擎故障显式返回错误。TUI 与 CLI 的流式 handle 仍按下述方式持有自己的路径扫描。

`Service::start(root, options)` 验证 root 是目录，返回后台搜索 handle 和
`Receiver<PathSearchSnapshot>`：

```text
ignore::WalkBuilder worker
  └─ directory-relative file path → Nucleo injector

Nucleo matcher worker
  ├─ QueryChanged → incremental pattern reparse
  ├─ injected path notification → tick
  └─ PathSearchSnapshot → caller-owned receiver
```

`PathSearchHandle::update_query` 只更新 matcher pattern，不重启目录遍历。丢弃 handle 会设置
shutdown 并唤醒 matcher；walker 在遍历 callback 中观察 shutdown。交互式调用方丢弃 handle
时不等待 join，worker 结束后释放共享状态。一次性 `Service::fuzzy` 不创建后台 handle。

`PathSearchSnapshot` 携带单调递增的 `query_revision`、query、按 score 降序且按 path 升序打破
平局的前 N 项、匹配字符索引、扫描文件数以及 scan/search completion 状态。调用方必须同时检查
revision 和 query，避免输入从 A 变成 B 再回到 A 时接受第一次 A 的过期结果。
增量 matcher 的全部匹配先按公共前 N 项选择规则筛选，再计算高亮；同分结果不依赖扫描顺序。

路径 walker：

- 尊重 `.gitignore`/ignore，普通非 Git 目录也应用 `.gitignore`；
- 不跟随 symlink；
- 按共同准入规则跳过根目录下的 `.git`、`.ash`、`node_modules` 与 `target` 子目录；根本身不按名称排除；
- 跳过非 UTF-8 relative path；
- 只注入普通文件，不返回目录。

## Glob 与文件枚举

- `Service::glob(dir, query, cancellation)` 接收已授权 `Dir`、相对 scope、include/exclude 和结果上限。
- include 为空时枚举符合规则的文件；正向 glob 使用 rg 的 override 语义，可以重新包含被忽略的文件，exclude 最后应用。
- 保留 Git 作用域内的 ignore 规则与默认隐藏文件过滤；调用方通过 exclude 声明额外排除目录。
- scope 必须规范化在授权 root 内；不跟随 symlink，不返回目录或非 UTF-8 路径。
- 返回 root-relative 路径，按修改时间从新到旧排序，同时间按路径排序；同时返回匹配总数。
- 单次最多保留 5,000 个结果，遍历期间检查取消与 30 秒期限；不启动 rg 子进程。
- Agent glob 在工具适配中选择 100 条结果与工具的排除规则；引擎和遍历细节留在本 crate 内。

## `ash-file-search` CLI

独立 binary 是 `PathSearchHandle` 的开发者/脚本入口，不是 TUI 启动的子进程：

```bash
cargo run --manifest-path Cargo.toml -p ash-file-search -- src -C .
cargo run --manifest-path Cargo.toml -p ash-file-search -- \
  --json --compute-indices --limit 20 mention -C crates
```

| 参数                | 语义                                               |
| ------------------- | -------------------------------------------------- |
| `[PATTERN]`         | fuzzy pattern；省略时列出 directory 文件           |
| `-C, --cwd <DIR>`   | 搜索 root；默认当前目录                            |
| `-l, --limit <N>`   | 输出上限；默认 64                                  |
| `--threads <N>`     | walker 和 Nucleo worker 数；默认 2                 |
| `--json`            | 每个 match 输出一行 JSON                           |
| `--compute-indices` | JSON 包含 indices；TTY plain output 对命中字符加粗 |

CLI 等待当前 `query_revision` 的 `search_complete` snapshot 后输出，因此不会显示中间结果。结果被
limit 截断时，warning 写入 stderr；JSON match 仍写入 stdout，方便逐行消费。省略 pattern 时仍
通过 `PathSearchHandle` 列出文件，不回退执行 `ls` 或其他 shell 命令。

## 内部接口地图

| Symbol           | 职责                                                | 不承担                 |
| ---------------- | --------------------------------------------------- | ---------------------- |
| `SearchInner`    | 搜索 root、worker 配置、shutdown 与进度共享状态     | popup/query 生命周期   |
| `walker_worker`  | 遍历并向 Nucleo 注入 relative file path             | 读取文件内容、排序结果 |
| `matcher_worker` | 合并 query/walker/notify signal，驱动增量 tick      | UI stale-result policy |
| `build_snapshot` | 生成有界、稳定排序且带高亮索引的 immutable snapshot | 发送 UI event          |
| `cli::execute`   | 等待 final snapshot 并选择 stdout/stderr 编码       | 扫描或 fuzzy matching  |

如果该 crate 开始读取候选文件内容、实现模型 Tool binding，或保存 TUI popup state，说明 ownership
已经漂移；这些职责分别属于公共 grep、Tool registry 和 `ash-tui`。

## 失败与取消

- root 不存在或不是目录：`Service::start` 返回 `std::io::Error`，不启动 worker；
- CLI 参数非法、root 不可用或 worker 在 completion 前退出：binary 输出带
  `ash-file-search:` 前缀的错误并返回非零状态；
- 单个 walker entry 错误或非 UTF-8 path：跳过该 entry，搜索继续；
- snapshot receiver 被丢弃：matcher 停止发送并退出；
- handle 被丢弃：matcher 立即收到 shutdown，walker 在下一次 entry callback 停止。

## 验证

```bash
just verify ash-file-search --profile ci-test
just run ash-file-search -- --help
bazel test //crates/file-search:file-search-unit-tests
bazel build //crates/file-search:ash-file-search
```

修改 Nucleo 配置、ignore 规则、排序或 snapshot completion 语义时，必须同步检查
`file_search_tests.rs`、TUI file-search manager、mention renderer 和两层文档。

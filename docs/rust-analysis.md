# Rust 分析桥接

`ash-rust-analysis` 是独立的开发分析进程，直接链接 crates.io 发布的 `ra_ap_* = 0.0.358`，支持仓库固定的 Rust 1.98。没有使用 ra-jit 的 rust-analyzer 分支，没有修改上游源码，也没有启用 `rustc_private`。与上游 Rust API 的耦合集中在 `crates/rust-analysis/src/analysis.rs` 和 `lower.rs`；调用方通过自有版本化 JSON 接口访问，不传递 RA 的数据库引用、内部 ID 或 Rust 类型。

`ash-build` 的常驻构建会话已接入此桥接：每次候选函数保存先更新源码及依赖，再查询当前修订的类型和绑定身份，降为自有标量 MIR，经 rustc 检查后由 Cranelift 生成机器码。简单独立函数使用 metadata 检查；涉及模块、常量及受限可见性的图检查原 Cargo library，符合条件时复用 Cargo 确定的完整 crate 检查命令。Electron、App Server 和 CLI 产品宿主都不依赖分析库或 Cranelift；运行时只拥有镜像装载器。完整模块和不支持的函数仍使用 Cargo/rustc。

## 使用

在仓库根目录查询源函数，例如 PowerShell：

```powershell
$offset = .\scripts\.venv\Scripts\python.exe -B -c "from pathlib import Path; print(Path('crates/app-server-diff/src/lib.rs').read_bytes().index(b'fn zero_based_line_index(') + 3)"
just analyze-rust crates/app-server-diff/src/lib.rs $offset
```

该入口通过现有 Cargo 包装器构建桥接器，并在缓存租约内运行，使用与回归相同的 `ci-test` 配置。stdout 输出工作区加载情况及函数报告，Cargo 和加载进度写到 stderr。位置是 UTF-8 字节偏移；不是 UTF-16 编辑器列号。

工作区加载使用 `--locked --offline`；首次分析前，锁文件和依赖须已由正常构建入口准备好。

默认读取 Cargo metadata、源码和 sysroot，不执行工作区 build scripts，不启动过程宏 helper。声明宏仍可展开。显式 `--build-scripts` 会收集所选工作区的 build-script／过程宏产物，并使用 Rust 工具链自带的 `rust-analyzer-proc-macro-srv`；这一模式可能运行工作区构建任务。当前真实 Ash 验证只使用默认模式，过程宏和 `OUT_DIR` 验证使用三个本地小包组成的 fixture。

上游在产物收集阶段可能跳过普通编译，因此 `build_script_error = null` 只表示该收集阶段没有报告错误，不能据此认定代码通过 rustc 检查。

## 进程协议

直接启动 `.build/cargo/ci-test/ash-rust-analysis.exe <workspace>`，可选 `--build-scripts`。每行一个 JSON 对象，stdout 首先发送 `id: null` 的 `ready` 响应，包含加载文件数、上游版本、加载模式及能力限制；然后串行处理 stdin 请求，EOF 结束进程。此桥接器拥有自己的 RA 增量数据库，不共享编辑器中另一个 rust-analyzer 进程的缓存。

自定义进程调用方负责构建缓存租约；Python 入口同时保护桥接二进制的 `ci-test` 缓存，以及启用产物收集时所选工作区的 `dev-small` 缓存，直至子进程结束。

请求包含协议版本、调用方 ID、所基于的分析修订号和查询。例如当前源码中行号转换函数的名称起点为 5188：

```json
{"protocol_version":1,"id":1,"revision":0,"query":{"method":"function","path":"crates/app-server-diff/src/lib.rs","byte_offset":5188}}
```

| `query.method` | 输入                                          | 返回内容                                                                                                  |
| -------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `function`     | `path`、`byte_offset`                         | 所在源函数、签名、参数／返回及表达式类型、类型布局估算、语法中的调用、结构化 MIR 摘要及单独标记的调试文本 |
| `lower`        | `path`、`byte_offset`                         | `available` 及自有标量 MIR，或带原因的 `unsupported`；包含同 crate 跨文件直接调用闭包及准确源码来源       |
| `references`   | `path`、`byte_offset`、可选 `exclude_imports` | 符号引用的源路径与字节范围；编译器排除导入位置以判断真实调用者                                            |
| `expand_macro` | `path`、`byte_offset`                         | 宏名称及递归展开文本；宏加载不完整时明确报错                                                              |
| `change_file`  | `path`、完整 `text`                           | 事务性更新已加载文件的内存内容，修订号加一，不写磁盘                                                      |
| `change_files` | `files: [{path,text}]`                        | 最多 64 个文件整体校验后一次更新，修订号只加一；无效路径、重复文件或超预算不会部分应用                    |

成功响应包含 `protocol_version`、`id`、当前 `revision` 和 `result`；失败响应以 `error.code`、`error.message` 替换 `result`。旧修订请求返回 `stale_revision`，未知字段／版本或非法偏移返回 `invalid_request`。调用方必须在源码更新后使用新的修订号；不能把前一修订的函数范围或查询结果视为当前事实。

输入文件须位于工作区内，已被 VFS 加载，且不超过 2 MiB。请求上限 4 MiB，响应上限 8 MiB，表达式／引用／调用／MIR block 列表各有 2048 项上限并返回截断标志，MIR 调试文本最多 256 KiB。过大的帧使进程退出，过大结果返回 `budget_exceeded`。分析 panic 会报告 `analysis_failed` 后退出，调用方应重新加载进程，不继续复用可能已损坏的数据库。

现阶段文件新增／删除、Cargo 或 build-script 配置变化需要重启加载。按工作区默认 features 和本机目标分析，同一文件属于多个 crate 实例时使用上游首先选中的上下文；尚无编译产物级的 target／feature／cfg 选择协议。返回的类型 display 和 MIR debug text 是展示资料，不作为编译器 IR 或 ABI 契约。

## ash-build 构建会话

正常开发准备仍建立完整 diff 模块。启用 `ASH_RUST_LIVE_DIRECTORY` 后，Electron watcher 的适配器保存启动一次 `build/desktop/live.py --protocol-prepared --serve`，随后复用其 `ash-build` 进程和独立 RA 数据库。首次保存包含工具准备及工作区加载，后续保存复用分析状态和 rustc 身份；每次都向桥接提交本次磁盘快照并校验响应 ID、协议版本及修订。不是共享编辑器的 RA 缓存。

内部编译器入口为 `ash-build <repository> <module-directory> --serve <analysis-executable>`。stdout 仅传送 JSON 行，日志写到 stderr；首先返回版本 1、`id: null` 的 `result.event: ready`，然后处理：

```json
{"protocol_version":1,"id":1,"mode":"functions","backend":"cranelift"}
```

成功返回同一 `id` 和 `result.kind`（`function` 或 `module`）、`elapsed_ms`、`analysis_ms`；失败返回 `error` 字符串，上一发布指针保持不变。请求上限 4096 字节；调用方串行请求。`mode: module` 显式建立完整基线；`functions` 表示先尝试函数路径，调用方必须保证该批次仅含适配器保存。一次性 `live.py --functions-only` 也通过同一桥接会话处理请求，但包含每次重新加载 RA 的成本，watcher 使用常驻入口。

函数路径同时要求签名、模块代次、原生配置及工具链匹配。每次尝试将分析修订、源码摘要和自有 MIR 保存到对应函数目录的 `analysis.json`。`backend` 默认 `cranelift`，显式 `rustc` 保留原有受限叶函数编译作为配对基线；ready 同时公布两个 backend。

Cranelift 分析前同步适配器的全部 Rust 文件，依靠 RA 的函数身份解析跨文件调用、别名和不同模块中的同名函数。当前图的函数体可以变化；跨文件 helper 必须没有图外调用者且没有公开外部可见性。引用截断、其他原生调用者、签名、文件集合或其他上下文变化均退回完整模块。掩去函数体时保留行列占位，避免未重编译部分的 `line!`／`column!` 悄然变化。共享常量属于上下文，修改时注册入口走完整模块；不能只更新一条调用路径。

跨模块图首先在原 owner 上执行 `cargo check --locked --offline --package <owner> --lib --profile dev-small`，保留模块路径、可见性和常量的检查上下文。符合下方复用边界时，后续仍用同一上下文运行 rustc，检查完整原 crate；可独立检查的闭合函数图保留单独的 `rustc --emit=metadata` 路径。分析得到的 library 根必须与 Cargo 目标一致。所有依赖源码须逐字匹配磁盘快照，发布前再次验证，避免旧 helper 与新入口混合。

缺少类型／MIR、布局不符或桥接故障会回到完整模块构建。完整模块发布后废弃旧分析库；下一次函数尝试重新加载。依赖／协议保存由 watcher 先关闭会话，再走正常后端准备与重启。函数编译错误只拒绝本次请求，会话可继续处理下一次保存。桥接加载等待上限 60 秒、单次查询 30 秒，超时或错误后丢弃该进程，不接受旧结果。EOF 使当前构建结束后退出并释放 RA 子进程和两种 profile 的共享缓存租约；租约阻止缓存回收，不阻止其他 Cargo 构建。

当前默认机器码路径是 **未修改 RA 公开语义 → 自有标量 MIR → Cranelift → 原子发布 → 运行中请求选择可执行镜像**。这不是直接导出上游 RA MIR：0.0.358 的 `Operand.kind` 没有公开读取接口，已核对的 0.0.300／320／340／350 也一样。没有解析调试文本、读取私有内存布局或维护 RA 分支。构建性能、首次加载成本及 ra-jit 对照范围见 [构建测量](build.md#历史测量与适用范围)。

## 标量 MIR 与本机代码边界

`ash-rust-build-ir` 拥有版本 2 的标量控制流 IR。支持 `bool`、8／16／32／64 位有符号和无符号整数、`usize`／`isize`、unit；支持局部变量与遮蔽、赋值、整数算术／比较／转换、短路逻辑、`if`、`while`、无标签 break／continue、return、同 crate 跨文件普通函数调用、模块级字面量标量常量、整数 wrapping／saturating add／sub／mul，以及无符号 `div_ceil`。RA 的绑定身份用于解析变量、常量和直接被调用函数，读取局部变量时立即复制值以保留 Rust 求值顺序。单个程序最多 32 个函数，每函数 256 个 locals、512 个 blocks、8 个参数，总计 8192 条赋值；校验类型、跳转、调用签名、确定初始化和无递归调用图。

IR 带 library 根、检查模式、每个函数的源路径／名称／函数体字节范围，以及函数、常量和模块声明的完整源码快照。路径统一为工作区相对的正斜杠路径，拒绝路径穿越、重复和不匹配的源范围；单图最多 64 个源文件、每个 2 MiB、总计 4 MiB。同名函数按 RA 身份区分，不按函数名合并图。进程协议仍为 1，ready 另行公布 `scalar_ir_version: 2`；版本不同的编译器拒绝消费图。

当前不支持引用／指针、堆对象和结构体、浮点、宏、泛型与单态化、闭包／间接调用、跨 crate 调用、drop／unwind、async、unsafe 或函数属性。普通函数执行验证可使用开发工具：

```text
ash-build --evaluate <workspace> <analysis-executable> <source.rs> <UTF-8-byte-offset> [u64-bits ...]
```

参数和结果使用标量的低位比特；有符号值采用相应位宽的二进制补码，bool 只接受 0／1。偏移必须从实际落盘字节计算，Windows CRLF 也占字节。此入口保存 `lowered.json` 和独立 rustc 校验源，执行一次后退出；其新建 RA 时间不代表热更新成本。跨模块图检查原 Cargo library，不生成扁平化的替代检查 crate。

Cranelift 只生成闭合的标量函数图，COFF／ELF 内部相对重定位合并成代码镜像；外部符号或其他重定位回退 Cargo。当前实现允许 x64 MSVC Windows 和 x64 GNU Linux，实测仅覆盖 Windows。宿主用 `memmap2` 从可写内存切换为只读可执行内存，装载前检查目标、版本、大小、入口和 SHA-256。缓存不要求断电持久化；当前指针原子替换，每次请求持有旧映射的 Arc，跨越新镜像发布也可继续运行。既有 Rustc DLL 可与新 `usize_code` 镜像互换。

本机调用使用 C ABI、标量参数及输出指针／状态码，不传递 Rust 对象或分配器所有权。除零、带检查的溢出和无效移位返回失败状态，宿主重新执行整份完整模块投影。每次生成新代码仍执行 rustc 检查；没有将 RA 推断当作 rustc 正确性检查。Cranelift 使用快速无优化代码生成，完整模块保持现有 `dev-small` 优化；构建加速不能解释为运行速度相同。

App Server 热更新入口仍只有显式注册的 `zero_based_line_index(usize) -> usize`，其闭合标量图可以跨文件，满足独占条件的 helper 本体修改可直接更新函数镜像。尚无一般函数自动插桩或布局迁移。新增注册项需有实际宿主调用者和明确 ABI，不能仅凭分析器能读 MIR 宣称任意函数可热替换。

编译器在包源码中发现 `cfg`／`cfg_attr` 时保守拒绝本机函数路径，注册入口退回 Cargo；非 test library 中必定失活的 `#[cfg(test)] mod tests` 整体除外。这也覆盖条件导入、类型别名和其他条件调用者，避免 RA 工作区 feature 合并与 Cargo owner 默认 features 不同而错误选择定义。准确产物配置绑定尚未实现，不能只以 Cargo 检查成功掩盖此差异。

## 多入口依赖失效与执行验证

开发工具提供常驻标量执行宿主，用于真实源码的依赖与性能验证：

```text
ash-build --serve-functions <workspace> <image-directory> <analysis-executable>
```

调用方负责共享 Cargo 缓存租约，并串行发送 JSON 行：

```json
{"protocol_version":1,"id":1,"method":"build","entries":[{"path":"crates/utils/string/src/truncate.rs","function":"approx_bytes_for_tokens"},{"path":"crates/utils/string/src/truncate.rs","function":"approx_tokens_from_byte_count"}]}
{"protocol_version":1,"id":2,"method":"call","entry":0,"arguments":[100]}
```

最多注册同一个 Cargo library package 的 8 个源文件顶层函数。每次 build 先快照整个包的 `src/**/*.rs`、build script 和构建配置，再同步 RA、解析每个入口、比较包含源码依赖的图摘要。共享依赖变化重编所有受影响入口，其他图复用；源码粒度是整个文件，尚无一般反向语义索引。完全无关的文件变更可以重新分析后直接命中缓存。文件集合或构建配置变化会重建 RA，并使全部入口失效。

所有待更新图共用一次原 owner 完整 crate 检查后，生成不可变的 `objects/<sha256>.json` 机器码与 `objects/<sha256>.mir.json`，再次核对整个包快照，原子替换一份 `current.json`，最后一起切换内存中的入口集合。源码图命中缓存时也执行完整检查，避免图外代码错误或外部依赖变化被缓存掩盖。清单记录代码／MIR 摘要、源码快照摘要和依赖；失败保留整组旧入口及发布指针。包快照最多 2048 个文件、单文件 2 MiB、总计 16 MiB，拒绝符号链接。EOF 结束宿主和 RA 子进程。

这是编译器内的执行宿主；真实 token 估算函数在这里验证，没有自动替换 App Server 内所有 token 预算调用。App Server 的运行中更新由上方注册 diff 入口单独验证。测量必须区分 Cargo 编译时间、普通消费者进程重启和本机图生成成本，不能将少一次消费者启动全部算为编译器提速。

## 完整 crate 检查与 Cargo 上下文复用

`check` 模块通过 Cargo 的 [`RUSTC_WRAPPER` 接口](https://doc.rust-lang.org/cargo/reference/environment-variables.html)记录成功的 owner library 检查命令，包括真实 rustc 路径、工作目录、edition、extern、cfg、lint、profile 和 Cargo 增补的环境变量。包装器总是执行 rustc，不伪造检查成功。父进程环境只保存摘要，命令记录保存 Cargo 增补／覆盖的环境；不复制父进程的整份环境值。jobserver 句柄属于 Cargo 那次进程，不带入后续检查。

预热后每次仍启动 rustc 检查完整的原始 library，包含注册图外函数的类型／借用检查。保留 Cargo 参数，仅把 metadata 输出和既有 incremental 目录重定向到会话私有目录，避免污染正常 Cargo 产物或与 Cargo 争写缓存。检查命令只在当前进程内复用；磁盘捕获文件用于诊断，不作为后续会话可信命令直接装载。若 Cargo 判断 owner 已 fresh、没有实际调用 rustc，就没有新命令可捕获，保持 Cargo 路径，直到一次真正的 owner 检查建立命令。

复用支持 registry、路径及 Git 依赖，owner 仍须无 build script。路径／Git 包的完整文件集合和内容均纳入守卫，新增模块或 build script 也会失效；registry 保留 Cargo 的发布源码不可变模型，并额外核对 rustc 文本 dep-info 列出的实际源码／include 输入。依赖 metadata、rlib、过程宏动态库、build-script 可执行文件及 dep-info 均按内容核对，调试数据库不属于 metadata 检查输入。每个依赖包及其祖先的 manifest／锁文件、Cargo 配置也在守卫内。

依赖 build script 按 [Cargo 的 rerun 契约](https://doc.rust-lang.org/cargo/reference/build-scripts.html#rerun-if-changed)跟踪：支持相对路径、`../`、绝对路径、目录及尚不存在的文件，未声明 rerun 输入时核对整个包；核对生成目录、脚本输出和声明的 native search 目录。环境变化由父进程环境摘要与原 Cargo 环境差异共同失效。App Server 协议包读取仓库级 `.build/protocol/metadata.json` 的真实构建输入已纳入此链路；不能用仅核对包内 Rust 文件代替它。过程宏／build script 未声明的任意外部 I/O 仍受 Cargo 自身的跟踪契约限制。

检查前后都核对依赖；同一请求在 RA 分析前形成的检查票据可复用一次，避免重复扫描。最多四个线程交错分配文件元数据读取和内容摘要，避免排序后的大产物集中在单个线程；每个线程复用 256 KiB 读取缓冲区，逐字节计算 SHA-256，并拒绝读取期间长度变化；不缓存内容摘要或以 mtime 代替源码／产物内容核对。工具链安装以路径、文件长度和修改时间核对，不在每次保存时读取全部标准库二进制。变更或无法验证时重新交给 Cargo；上下文失效或 Cargo 实际重编依赖时，旧 RA 上下文不能授权发布，App Server 退回完整模块后重新启动未修改的分析桥。owner build script、符号链接、未知依赖来源／产物、无法读取的 dep-info 或预算超限继续走 Cargo。

依赖内容读取上限为 16384 文件／512 MiB；工具链与依赖合计条目上限 16384。owner 文件集合、manifest、锁文件、profile、配置或父进程环境变化会使检查上下文失效。分析期间依赖变化使本次请求失败，旧发布指针不变；后续请求重新加载。现有 cfg／类型／ABI 限制继续生效，不能将命令复用视为通用 Rust JIT 的正确性证明。

多入口 `build` 请求可带 `"check":"cargo"` 或默认的 `"check":"reuse"`。前者用于同链路强制 Cargo 对照，后者在守卫满足时复用命令；响应 `check_backend` 为实际执行的 `cargo` 或 `rustc`。两个策略均执行完整 crate 检查，不存在 unchecked 策略。`ash-utils-string` 和 App Server diff 的实际路径／Git 依赖图均可建立复用上下文。普通多入口业务配对数据见 [检查优化测量](build.md#2026-10-21复用-cargo-检查上下文的百毫秒业务热更新)，真实 App Server 保存至 RPC 的数据见 [路径依赖与真实热更新测量](build.md#2026-10-21路径依赖检查复用与-app-server-真实热更新)。

App Server watcher 在 Windows 上忽略只有访问时间变化的通知：比较文件身份、长度、修改及状态变更时间，源码写入即使保留长度和 mtime，ctime 变化仍触发构建；rename、删除和读取失败保守交给构建。此处只去除重复／访问通知，每次实际 JIT 请求仍执行上述完整内容守卫及 rustc 检查。消费已经排队的保存批次时同时清除其剩余 debounce，避免空批次升级成整后端构建。完整模块先验证可加载镜像并保存经源码复核的函数基线，最后原子切换发布指针；RPC 不会先看到新模块、随后才收到基线检查失败。

## 已验证能力和缺口

2026-10-21 在 Windows x64、Rust 1.98.0 上通过真实 JSON 子进程边界验证，依赖全部来自上游 registry 包。真实 Ash 工作区加载 26085 个文件，查询 `zero_based_line_index`、`utf16_columns` 和 `compute`，三者均取得类型、布局及结构化 MIR；未执行 Ash 全工作区 build scripts。

| 能力                 | 观察结果                                                                                               | 对函数编译的含义                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 名称、类型、调用定位 | Ash 三个函数的返回类型均无 unknown；`utf16_columns` 得到 50 个表达式类型及 11 个语法调用               | 可以建立语义桥接，语法调用列表仍不是完整依赖图                                |
| 引用查询、cfg        | 找到当前行号函数的一个真实引用；fixture 的失活 `#[cfg(any())]` 函数不可解析                            | 可查询引用，编译器仍须绑定准确的 crate／cfg 上下文                            |
| 类型布局             | Ash 的 `usize` 为 8／8 字节大小／对齐；fixture 跨包 `repr(C)` 结构为 8／4                              | 上游已有布局 API；仍须验证与目标 rustc 的 ABI 一致性                          |
| 结构化 MIR           | 直接调用 `hir::db::HirDatabase::mir_body` 并读取 `MirBody` 的 blocks、locals 和参数信息                | 无需为取得 MIR 先修改 RA；该深层 API 不承诺稳定，桥接目前只输出摘要和调试文本 |
| 声明宏               | fixture `plus!` 和 Ash `assert_eq!` 展开成功                                                           | 已有能力，不是必须 fork 的原因                                                |
| 过程宏、生成源码     | 启用构建产物加载后，本地 proc macro 生成函数可展开并解析调用，`OUT_DIR` 的 `include!` 函数取得 MIR     | 需要正确的构建产物及工具链 helper，单靠 metadata 不够                         |
| 增量分析             | fixture 的返回类型 `usize → bool`；真实 Ash 内存覆盖中 `usize → u32`、布局 `8 → 4`；恢复后回到 `usize` | 已验证 RA 增量数据库和桥接修订，磁盘源码保持原摘要                            |
| 泛型                 | 可查询泛型签名；未实例化 `T` 的布局返回 unavailable；上游另有公开单态化查询                            | 完整单态化产物、替换参数和符号桥接尚未实现／验证，不能把它写成上游无 API      |
| 借用检查             | fixture 的 use-after-move 函数仍可得到 RA MIR，真实 `cargo check` 则报 E0382                           | RA MIR 不是代码已通过 Rust 编译检查的证明，必须保留 rustc 验证边界            |

上述初期分析观察没有证明必须维护 RA 分支。当前已用公开语义 API 补上标量 MIR、Cranelift 代码生成与注册入口更新；完整上游 MIR 的操作数访问、非标量类型／实例协议、一般跨 crate 语义依赖与布局失效、单态化与间接调用／drop 仍有缺口。应逐项验证接口覆盖，不能把深层 MIR 摘要可读取等同于完整 IR 可用于代码生成。

真实工作区记录与逐请求响应位于 `.build/build-health/ra-bridge-final-20261021/`；早期探测保留在 `.build/build-health/ra-bridge-20261021/`，其中引用数量断言按旧版适配器误写为四处，当前原生调用只有一处，修正实验断言后完整场景通过。文件数与耗时只是本轮加载观察，没有冷／热性能、RSS 或编译加速结论。

## 维护与验证

RA 库按同一发布版本精确锁定，上游升级时集中检查适配层、MIR API 和过程宏 helper 的兼容性。新增依赖带入独立的 TOML 1.1 API，并要求共享 `serde_spanned`、`toml_datetime`、`toml_parser`、`toml_writer` 的补丁版本更新；既有 TOML 0.9 的直接 API 声明未升级。多版本原因已逐项记录在 `.cargo/dependencies.toml`，没有修改上游 Cargo 清单。

验证入口：`just verify ash-rust-analysis` 包含帧预算／协议回归及三个真实 Cargo workspace 的进程场景，并执行 check 和全目标 warnings；`just verify ash-rust-build-ir --lib` 校验 IR 边界，`just verify ash-dev-build --features compiler --lib` 验证本机整数运算、直接调用、rustc gate 和镜像替换。普通二进制通过 `scripts/cargo.py build --locked -p ash-rust-analysis --profile ci-test` 构建。Python 客户端运行 `python -B -m unittest build.desktop.test_analyze`；依赖检查、脚本测试和既有构建器回归按 Rust 开发规则执行。当前仅验证 Windows，本轮不包含其他系统、Bazel 构建或 Electron UI。

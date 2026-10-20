---
name: rust-hot-reload-optimize
description: 优化或扩展 Ash 的 Rust 函数级增量编译与 App Server 热更新，定位分析桥、Cargo 正确性检查、依赖失效、Cranelift 和运行中发布的成本。普通 Cargo 编译慢使用 rust-build-perf。
---

# Rust 函数级编译与热更新

从已经验证的真实链路继续工作：未修改的上游 rust-analyzer 分析库 → Ash 标量 IR → Cranelift → 注册入口的运行中替换。先读[当前能力和正确性边界](../../../docs/rust-analysis.md)及[最近的 App Server 实测](../../../docs/build.md#2026-10-21路径依赖检查复用与-app-server-真实热更新)。实现、协议版本、支持范围与历史数字由这些文档维护，不把历史预热结果当作本次基线。

默认保持上游 rust-analyzer 不变；能力缺口先在桥接和自有 IR 中验证。路径／Git 依赖的**检查上下文复用**不代表已经支持跨 crate JIT；标量执行宿主的业务调用也不代表整个 App Server 已自动插桩。

## 找到实际成本的 owner

| 观察到的成本或行为 | 优先入口 |
| --- | --- |
| 首次加载、覆盖同步、名称／类型／调用图、MIR 子集不足 | `crates/rust-analysis/src/`、`crates/dev-build/src/analysis.rs`；IR 契约在 `crates/rust-build-ir/src/` |
| Cargo 每次调度、捕获命令未建立、完整检查或依赖摘要慢 | `crates/dev-build/src/check.rs`、`workspace.rs`，以及 `jit.rs` 的检查调用 |
| 图失效、共享调用者、配置变化或普通入口缓存 | `crates/dev-build/src/function.rs`、`session.rs` |
| 机器码、重定位、ABI、映射、旧调用存活 | `crates/dev-build/src/codegen.rs`、`machine.rs`、`reload.rs` |
| 保存事件、重复构建、常驻进程与缓存租约 | `build/desktop/appServer.ts`、`liveBuild.ts`、`live.py`、`analyze.py` |
| 完整模块回退、基线与指针发布、真实 diff 消费 | `crates/dev-build/src/build.rs`、`server.rs`、`crates/app-server-diff-live/`、`crates/app-server-host/src/live_diff.rs` |

按日志拆开文件监听等待、RA 分析、完整检查与两遍依赖守卫、代码生成、发布及 RPC 消费。`Check inputs` 的读取／摘要时间包含 I/O，不等于 SHA 运算时间；`rustc-check` 也包含守卫，不能全部归因于 rustc。

## 优化或扩大能力

1. 确定用户要改善的真实编辑和消费者。性能任务先留匹配基线；能力任务先选一个实际函数、调用者和应拒绝的反例。普通构建命令、依赖与验证规则沿用 [rust-build-perf](../rust-build-perf/SKILL.md) 和 [rust-development](../rust-development/SKILL.md)。不要为函数热更新的主张无差别重跑冷 Cargo 基准。
2. 保留当前正确性与发布边界。普通跨模块业务图检查原 owner 的完整 crate，图缓存命中也检查；不要改成仅检查提取函数、相信 RA MIR 或跳过借用检查。复用 Cargo 的真实成功命令及环境，metadata／incremental 输出留在会话私有目录。捕获尚未建立、依赖或配置无法验证时继续用 Cargo。
3. 改依赖守卫时核对源码／文件集合、实际产物、manifest／锁文件、配置／环境、build-script 声明输入和生成目录。分析／检查期间变化必须拒绝发布；上下文失效不得继续使用旧 RA 结果。完整跟踪契约和预算见上述实现文档，不凭速度目标删减输入或换成仅检查 mtime。
4. 根据证据只改当前瓶颈。大产物集中在排序后的连续分片时，检查任务分配是否真正并行；Windows 上逐文件大 Vec 分配昂贵时，可复用读取缓冲区，同时摘要全部内容并检测长度变化。先量化目录枚举、metadata I/O、读取与摘要，再决定是否优化哈希算法。
5. 遇到 Windows 构建风暴，记录实际文件事件并对照身份、mtime、ctime 和内容。读取触发的访问通知不能升级成整后端源码修改；等长且恢复 mtime 的真实编辑、rename、删除和读取失败仍须到达构建边界。排队批次消费后不能留下再次触发空批次的 debounce。
6. 扩大图或 ABI 时先闭合类型、实例、artifact target／feature／cfg、依赖及所有原生调用者。独占 helper 可以随图更新，共享原生调用者需要完整模块回退。先验证新镜像可加载、源码／基线一致，再原子切换指针；失败保留整组旧入口，旧调用持有旧映射至结束。

## 用真实链路复测

准备入口使用现有构建器，例如在设置绝对路径 `ASH_RUST_LIVE_DIRECTORY` 后执行 `just live-build`。常驻构建入口为：

```powershell
./scripts/.venv/Scripts/python.exe -B build/desktop/live.py --protocol-prepared --serve
```

先读取 ready 帧，再串行发送 JSON 行，例如：

```json
{"protocol_version":1,"id":1,"mode":"functions"}
```

这个直接请求只能测编译器路径。要声称开发时热更新加速，必须再运行生产 `watchAppServer → LiveBuilder` 和真实 App Server，保留正常 debounce，计时从源码保存到 RPC 返回全部预期新结果。当前 diff 场景可用多行完全不同的文本，修改独占行号 helper 的减数，核对每一行索引而非只验证请求成功。

- 工具、目标、features、profile、编辑内容、依赖及缓存条件保持匹配；不清空共享 Cargo 缓存。预热到捕获检查命令已建立、模块回退和 RA 重载结束，再采集至少三次、通常五次真实函数体编辑。保存全部样本及中位数，冷加载／回退另报。
- 每次计时到 RPC 新结果后，等待该构建请求完成再进行下次编辑。核对实际 backend、模块／函数指针、编译器／RA／App Server PID，确认预热样本没有重启或混入完整构建。工具准备、首次分析和消费者重启不能算作纯代码生成收益。
- 对普通多入口执行宿主，可用 `check: cargo` 与 `check: reuse` 在同链路交替对照；它与真实 App Server 的注册入口是不同测量范围，不混算。不从 watcher 总耗时直接减去 debounce 来冒充独立测量。
- 实验前保存原字节；每次修改及最终恢复都确认文件仍是实验拥有的版本。保留失败日志、输入、工具版本、二进制摘要、PID 和结果到 `.build/build-health/`。完成后恢复源码／协议输入、移除自己创建的 helper、重建正常模块，并关闭实验子进程；不停止用户的运行实例来解除产物占用。

## 验收与交接

选与改动对应的回归：helper 类型／借用错误、图外 crate 错误、路径依赖错误须保留旧结果；合法依赖与外部 build-script 输入变化须回退、退休旧分析上下文并能恢复；分析期间输入变化、共享调用者、cfg 不匹配、坏镜像及在途旧调用按涉及的边界验证。用正常 Cargo 业务实现或明确的全输入预期核对运行结果。

按改动运行相应的 `just verify`／runtime warnings、构建工具单测及类型检查，并实际执行改变的命令。复用仍覆盖当前改动的通过结果；不要为结束任务重跑无变化的整套测量。更新实现边界与构建文档中的匹配样本、失败和未验证平台；将具体未完成能力或验证阻塞留在根 TODO。用户要求收尾时完成整理和提交，不自行继续扩大优化范围。

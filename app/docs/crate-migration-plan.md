# 前端 crate 迁移计划

本计划把前端持有的编辑、文件状态和终端交互能力迁入所属产品，分批验证。crate 继续负责能力与依赖隔离；移动目录不改变公开 API，也不增加跨进程调用。

## 最终边界

| 能力 | 归属 | 执行方式 |
| --- | --- | --- |
| 文本、选区、撤销、IME、视口 | 各前端 | 本端同步提交编辑事务 |
| 基础语法高亮、编辑器实时 Diff | 各前端 | 本端算法或前端拥有的 Worker，结果绑定文本版本 |
| 文件保存基线、dirty、reload、冲突提示 | 各前端 | 由文件编辑生命周期持有，实际读写委托文件能力 |
| 终端网格、光标、滚动和输入编码 | 各前端 | 在终端所在进程处理字节与交互 |
| Composer 路由、Shell 输入补全 | App 输入能力 | 本端调度，推理不阻塞绘制 |
| Git、Agent Patch、后台 Diff、索引、监听、进程执行 | `ash-rs` | 领域 crate 执行，App Server 提供业务接口 |
| LSP、语义 token、异步语言查询 | 语言服务与前端分别负责 | 服务消费带版本的分析副本，前端检查版本并应用结果 |

分析副本不拥有编辑事务、选区或撤销历史。纯算法可以被多个 Rust 消费者分别链接；复用算法不意味着复用运行状态或统一经过 App Server。

## 迁移批次

| 批次 | 范围 | 完成条件 | 状态 |
| --- | --- | --- | --- |
| 1 | `editor-core`、`text-file`、`terminal` 从 `ash-rs/` 移到 `app/` | 路径、Cargo/Bazel、文档与消费者同步，定向验证通过 | 已完成，macOS 定向验证通过 |
| 2 | `input-classifier`、`shell-completion` 移到 `app/` | 模型、词典、嵌入资源和相对路径完整迁移，输入分类与补全测试通过 | 待执行 |
| 3 | `terminal-detection` 移到 `ash-code/` | TUI 终端识别、主题调用与包构建验证通过 | 待执行 |
| 4 | TS 编辑器实时 Diff 改由前端计算 | 双栏、行内、Quick Diff、取消与版本检查验证通过；后台业务 Diff 独立保留 | 待执行 |
| 5 | TS 基础语法高亮解除对后台 parser 的依赖 | TextMate/前端 Worker 覆盖现有语言，token 与异步语言结果边界明确 | 待执行 |

每批独立交付验证结果，再推进下一批。后两批涉及行为变化，不与目录移动混在一起。

## 第一批执行清单

1. 完整移动三个 crate，保留 package 名、Rust API、依赖特性、测试与 fixtures。
2. 更新根 Cargo workspace 的成员和依赖路径；保留随 crate 移动的 `BUILD.bazel`。
3. 检查全部生产与测试消费者，尤其 CLI 使用终端模型的测试支持代码。
4. 更新职责说明、README 链接和构建命令，删除旧目录引用与后端归属说明。
5. 验证新目录与原实现一致、依赖方向正确、锁文件有效、文档链接可达。
6. 运行所属包的 check、现有测试与 warning 检查，并验证 App 和 CLI 测试的编译调用链。

### 验证范围

- `ash-editor-core`：文本事务、Unicode offset、选区、revision、undo/redo。
- `ash-text-file`：dirty/save、reload、外部修改冲突、乐观覆盖和只读状态。
- `ash-terminal`：ANSI/VT、跨块解析、Unicode、光标、屏幕切换、滚动、resize 和输入编码。
- App 消费者：`ash-editor`、`ash-editor-host`、`ash-terminal-runtime`、`ash-workbench` 与 `app`。
- CLI 测试消费者：`ash-cli` 的 PTY 测试支持与远程交互测试。
- 构建与依赖：`just dependencies`、根 Cargo manifest、锁文件与三个新 Bazel target。

第一批保持行为不变，复用既有行为测试；不增加只断言目录或重复实现的测试。完整 workspace 检查不属于本计划的默认验证范围。

## 共享库与后续边界

- `ash-syntax` 保留后台索引需要的解析能力；App 在本进程持有编辑器解析实例。
- `ash-diff` 保留纯文本差异算法；编辑器的请求、版本、取消和调度由前端负责，Git 与 Agent 业务调用由后端负责。
- `ash-keybinding` 保留 GUI/TUI 共用的规则算法；各端分别管理焦点、连续按键状态、配置与命令执行。
- LSP、Git、Patch、文件监听、文件 I/O 和 PTY 执行不随交互 crate 移入 App。
- 目录移动不增加第二份文本权威，不改变 TypeScript TextModel 的归属，也不引入 Rust WASM 统一编辑内核。

## 执行记录

- 2026-09-22：第一批三个 crate 已移入 App；根 workspace、Bazel 源码清单、现有边界检查与职责文档同步更新。
- 25 个 Rust 实现、测试文件及 package manifest 与迁移前逐字节一致；行为未修改，原有测试继续覆盖相同调用契约。
- Cargo 与 Bazel 锁文件保持不变；Cargo 的 `--locked` 检查通过。

| 第一批验证 | 结果 |
| --- | --- |
| `just check ash-editor-core -p ash-text-file -p ash-terminal --locked` | 通过 |
| `just test ash-editor-core -p ash-text-file -p ash-terminal --locked` | 61 个测试通过：编辑核心 10、文件生命周期 6、终端 45 |
| `just rust-warnings ash-editor-core -p ash-text-file -p ash-terminal --locked` | 通过 |
| `just dependencies` | 通过，194 个 workspace member；报告既有 ScrollView 文件未链接提示 |
| App 边界脚本、修改文档的本地链接与 `git diff --check` | 通过 |
| App 打包与签名 Python 测试 | 16 个测试通过；使用测试 fixtures，不表示实际发布或签名 |
| `just check app --locked` | 通过，包含编辑器、EditorHost、终端运行层和 Workbench 生产依赖 |
| `just test ash-editor --lib core --locked` | 4 个事务与历史衔接测试通过 |
| `just rust-warnings app -p ash-editor -p ash-editor-host -p ash-terminal-runtime -p ash-workbench -p ash-cli --locked` | 通过，包含这些包的全部测试目标编译 |
| 三个新 Bazel 单测 target 与 App 边界 target | 4 个 target 全部通过；源码输入包含三个新目录 |

Bazel 仍输出已有第三方 crate annotation 建议和测试 size 提示；本次未更改相关依赖或测试大小。

第一批共运行 65 个 Rust 行为测试和 16 个 Python 打包/签名测试；Bazel 的 4 个测试 target 另行通过。
CLI 的 PTY 场景完成编译检查，未执行真实交互场景；没有变更 UI 行为或启动窗口验收。此次验证平台为 macOS，未进行跨平台构建。

下一批从输入分类与 Shell 补全开始，迁移前检查内嵌模型、词典、测试资源和资源打包路径。

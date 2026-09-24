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
| 宿主终端识别、颜色能力、背景明暗解析 | Ash Code | 本端读取环境与终端查询结果；输入查询由 TUI 协调 |
| Git、Agent Patch、后台 Diff、索引、监听、进程执行 | `ash-rs` | 领域 crate 执行，App Server 提供业务接口 |
| LSP、语义 token、异步语言查询 | 语言服务与前端分别负责 | 服务消费带版本的分析副本，前端检查版本并应用结果 |

分析副本不拥有编辑事务、选区或撤销历史。纯算法可以被多个 Rust 消费者分别链接；复用算法不意味着复用运行状态或统一经过 App Server。

## 迁移批次

| 批次 | 范围 | 完成条件 | 状态 |
| --- | --- | --- | --- |
| 1 | `editor-core`、`text-file`、`terminal` 从 `ash-rs/` 移到 `app-rs/` | 路径、Cargo/Bazel、文档与消费者同步，定向验证通过 | 已完成，macOS 定向验证通过 |
| 2 | `input-classifier`、`shell-completion` 移到 `app-rs/` | 模型、词典、嵌入资源和相对路径完整迁移，输入分类与补全测试通过 | 已完成，macOS 定向验证通过 |
| 3 | `terminal-detection` 移到 `code/` | TUI 终端识别、主题调用与包构建验证通过 | 已完成，macOS Cargo 验证与 crate Bazel 单测通过；产品 Bazel 图限制见记录 |
| 4 | TS 编辑器实时 Diff 改由前端计算 | 双栏、行内、Quick Diff、取消与版本检查验证通过；后台业务 Diff 独立保留 | 已完成，定向行为、浏览器与构建通过；既有架构检查问题见记录 |
| 5 | TS 基础语法高亮解除对后台 parser 的依赖 | TextMate/前端 Worker 覆盖现有语言，token 与异步语言结果边界明确 | 已完成，八种语言、浏览器交互、Electron 产品场景与构建通过 |

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

## 第二批执行清单

1. 将输入分类和 Shell 补全一起移到 `app-rs/`；保留 package 名、公开 API、现有实现与测试。
2. 完整迁移模型、tokenizer、metadata、词典和第三方许可，保留资源字节与 crate 内相对路径。
3. 更新 Cargo、Bazel、App 发布输入清单和 `.gitattributes`；保留 JSON/词典的 LF 与 ONNX 的二进制属性。
4. 同步 App 边界检查和职责文档，检查 Session 输入框的生产与测试消费者。
5. 验证模型摘要与概率基线、Shell parser 与补全，以及输入框的分类、版本失效、IME 和提交行为。
6. 运行所属包与 App 消费者的定向构建、测试和 warning 检查，验证依赖方向与 Bazel 资源输入。

本批不调整分类算法与公开 API，沿用现有行为测试。推理继续由 App 在进程内后台执行；输入 revision、候选展示与编辑提交仍由 Session/Editor 持有。资源校验和实际构建暴露的问题随本批修复，见执行记录。

## 第三批执行清单

1. 将 `terminal-detection` 完整移入 `code/`，保留 package 名、公开 API、实现、测试与 Bazel 定义。
2. 更新根 workspace 的成员与依赖路径、crate README 和产品职责说明。
3. 检查 TUI 的终端探测、启动错误、主题和调色板消费者；终端输入流仍由 TUI 独占。
4. 运行环境识别、颜色解析与 TUI 消费者测试，检查 CLI/TUI 正常构建和 warning。
5. 验证 Cargo/Bazel 依赖图、锁文件与新 target，确认共享后端没有反向依赖。

本批保持运行行为和终端输出不变，复用现有语义测试与 snapshot，不新增重复测试。

## 第四批执行清单

- 行为链：打开对比或编辑未保存文本 → DiffEditorPane / MultiDiffEditorPane / QuickDiffModel → IDiffService → 前端 Worker → DiffModel 检查版本 → 现有行与行内差异展示。
- TextModel 继续独占文本、事务和历史；DiffModel 继续负责版本与过期结果；Worker 只执行一次性快照计算，不维护文本镜像。
- 算法使用线性空间 Myers 分割和字素边界，计算期间处理取消；复用现有 WebWorkerClient/Server 的请求、失败和释放机制。
- 本批保留 Ash 已有的 LineDiff 契约。VS Code 的 linesDiffComputer/documentDiffProvider 用于核对职责与插入、删除、空行、行内差异场景，不复制其实现或扩展本批公开功能。

| 准入路径（相对 app-ts/） | 对应关系与动作 | 验证 |
| --- | --- | --- |
| `src/ash/editor/common/diff/lineDiff.ts` | Ash 现有契约，加入前端纯算法 | 行对齐、hunk、字素与随机编辑 |
| `src/ash/editor/common/diff/diffWorker.ts`、`diffWorkerMain.ts` | Ash 本批计算运行入口，复用通用 Worker 通道 | 取消、并发、失败与释放 |
| `src/ash/editor/browser/services/workerDiffComputationService.ts` | 从旧后台适配器迁移为前端 Worker 客户端 | 实际 Worker 与版本更新 |
| `src/ash/workbench/services/diff/browser/diffService.ts`、`src/ash/workbench/browser/workbench.ts` | 替换旧 AppServerDiffService 装配 | 所有交互消费者使用前端计算 |
| `src/ash/workbench/services/diff/test/browser/appServerDiffComputationService.test.ts` | 旧适配器测试迁到 Editor 的 Worker 与算法测试 | 保留 Unicode、末尾空行覆盖 |
| `src/ash/editor/test/common/models/diff/lineDiff.test.ts`、`src/ash/editor/test/browser/services/workerDiffComputationService.test.ts`、`diffTestPort.ts` | 本地行为测试与测试专用通道 | 精确结果、取消、资源释放 |
| `src/ash/workbench/contrib/scm/test/browser/quickDiff.test.ts` | 使用真实前端计算替换返回固定 Diff 的 fixture | dirty buffer、基线复用、装饰释放 |
| `test/integration/browser/diff.html`、`diff.integration.ts`、`diff.integration.spec.ts`、`vite.config.ts` | 独立 Playwright 场景接入既有入口 | 双栏、行内、Multi Diff、键盘、并发与取消 |
| `test/architecture/editor-architecture.test.ts` | 既有归属检查同步新计算入口，继续禁止 Editor 导入后台 DTO | 依赖边界检查 |
| `src/ash/editor/text-engine.md`、`src/ash/editor/browser/README.md`、`src/ash/platform/diff/common/diffApi.ts` | 同步当前职责说明 | 后台业务 API 保留，旧交互入口退出 |

旧 `appServerDiffService.ts`、`appServerDiffComputationService.ts` 及适配器测试随本批替换退出；不保留双计算入口。

## 第五批执行清单

- 行为链：扩展 grammar 资源 → `BrowserTextMateService` → 前端 TextMate Worker → TextModel 版本检查 → 行与视口着色；打字、预览和撤销不等待后台 parser。
- `AppServerSyntaxProviders` 退出基础 token 注册，仅提供异步诊断、符号、折叠和结构选择；保留现有请求取消与版本检查。LSP Semantic Tokens 继续独立合成。
- 复用 `extensions/` 中 JavaScript/JSX、TypeScript/TSX、JSON/JSONC、Rust 和 Shell 的真实 grammar，不新增算法、依赖或资源副本。
- Shell 前端语言标识统一为 grammar 与 LSP 使用的 `shellscript`；后台 `shell` 领域标识只在 Workbench 适配边界转换。

| 准入路径（相对 app-ts/） | 动作与验证 |
| --- | --- |
| `src/ash/workbench/services/language/browser/appServerSyntaxProviders.ts` 及对应测试 | 删除后台基础 token 提供与映射；验证异步语言能力独立工作 |
| `src/ash/workbench/services/language/browser/appServerLanguageSupport.ts` 及现有 provider/diagnostic 测试 | 将服务目录中的 Shell 标识映射为前端标识，覆盖注册、请求与诊断支持判断 |
| `src/ash/editor/standalone/common/builtinLanguages.ts`、`src/ash/platform/language/common/textResourceLanguage.ts` 及现有测试 | 文件识别返回唯一的 `shellscript`，与扩展声明一致 |
| `test/integration/browser/tokenization.html`、`tokenization.integration.ts`、`tokenization.integration.spec.ts`、`vite.config.ts` | 真实扩展装载与 TextMate Worker，覆盖八种语言、后台分析未完成时编辑/撤销与 token 更新 |
| `test/architecture/editor-architecture.test.ts`、`test/smoke/areas/editor/editor-open.spec.ts` | 更新基础 token 归属断言，保留后端 parser 与符号能力验证 |
| `src/ash/editor/text-engine.md`、`docs/editor-architecture.md` | 同步词法高亮与后台语言能力边界 |

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

### 第二批执行记录

- 2026-09-22：输入分类与 Shell 补全已从 `ash-rs/` 移到当时的 `app/`（现 `app-rs/`），模型、词典、第三方许可、Cargo/Bazel 清单与 App 边界同步迁移。
- 迁移中发现既有全库重命名误改 tokenizer 的 `zeta` 词条。已从重命名前的 Git 版本恢复精确资源字节，保留既有摘要 `b43e3d508ae9fe2c557ac2e0fb82f3487d59193a58f5328dc042ebf31ba1f72c` 和 token ID；没有修改摘要断言或模型权重。
- Bazel 暴露的工作区补全测试依赖本机安装命令问题，改为显式提供临时 PATH fixture；保留原有行为断言。
- Bazel 为模型构建显式提供已锁定的 `protoc` 工具，按执行平台选择，并传入当前沙箱路径；避免复用上一次编译沙箱中已失效的绝对路径。
- 两个迁移 crate 的生产 Rust 实现和 package manifest 保持不变；34 个实现、测试和资源文件逐字节一致。差异限于恢复 tokenizer、三个测试文件中的 PATH fixture，以及职责说明和构建清单。
- Cargo 与 Bazel 锁文件保持不变；Bazel query 确认 App 发布输入包含全部 38 个迁移实现、测试、manifest 和资源文件，其中 7 个为模型、词典与许可资源。

| 第二批验证 | 结果 |
| --- | --- |
| `just check ash-input-classifier -p ash-shell-completion --locked` | 通过 |
| `just test ash-input-classifier --lib --locked` | 31 个测试通过；手动性能比较保持 ignored |
| `just test ash-shell-completion --lib --locked` | 22 个测试通过 |
| `just test ash-session --lib chat_input --locked` | 56 个测试通过，覆盖分类、版本失效、IME、补全和提交 |
| `just check app --locked` | 通过，包含 Session 和 Workbench 生产调用链及模型构建脚本 |
| `just rust-warnings ash-input-classifier -p ash-shell-completion -p ash-session -p ash-workbench -p app --locked` | 通过 |
| `just dependencies` | 通过，194 个 workspace member；仍报告既有 ScrollView 文件未链接提示 |
| 两个新 Bazel 单测 target 与 App 边界 target | 3 个 target 全部通过；使用 `--lockfile_mode=off`，保留既有依赖事实记录 |
| App 发布输入 query、资源摘要、Git 属性、本地文档链接和 `git diff --check` | 通过 |
| 修改的 Rust 文件格式检查、边界脚本 Ruff 检查 | 通过 |

本批共运行 109 个 Rust 行为测试，Bazel 的 3 个测试 target 另行通过。既有模型摘要和概率基线覆盖资源修复；PATH fixture 保留原行为断言，没有新增重复测试。Bazel 仍有第三方 crate annotation 建议与测试 size 提示，本批未更改相关依赖或测试大小。

此次验证平台为 macOS；未进行跨平台构建、运行窗口或实际打包发布。

### 第三批执行记录

- 2026-09-22：`terminal-detection` 已从 `ash-rs/` 移到 `code/`，同步根 Cargo workspace、依赖路径、README 和产品职责说明。
- 7 个实现、测试、Cargo manifest 和 Bazel 定义逐字节一致；公开 API、运行行为与终端输出未变。Cargo metadata 确认唯一直接消费者为 `ash-tui`。
- 新 Bazel 单测 target 已通过。额外的 CLI/TUI 依赖图查询分别被既有的 `app-server-protocol-noop-macros`、`sprite` 缺失 `BUILD.bazel` 阻塞；这两个目录在本批前就没有对应文件，不属于本次迁移。

| 第三批验证 | 结果 |
| --- | --- |
| `just check ash-terminal-detection --locked` | 通过 |
| `just test ash-terminal-detection --locked` | 11 个终端身份、复用器、颜色能力和背景解析测试通过 |
| `just rust-warnings ash-terminal-detection --locked` | 通过 |
| `just check ash-cli --locked` | 通过，覆盖 CLI 与 TUI 的正常构建检查 |
| `just test ash-tui --lib terminal:: --locked` | 29 个终端探测、恢复和输出测试通过 |
| `just test ash-tui --lib theme::resource:: --locked` | 6 个主题解析与切换测试通过 |
| `just test ash-tui --lib render::palette:: --locked` | 4 个颜色能力与调色板测试通过 |
| `just rust-warnings ash-tui -p ash-cli --locked` | 通过 |
| `just dependencies` | 通过，196 个 workspace member；仍报告既有 ScrollView 文件未链接提示 |
| `//code/terminal-detection:terminal-detection-unit-tests` | Bazel 通过，使用 `--lockfile_mode=off` |
| CLI/TUI Bazel 依赖图查询 | 被上述两处既有缺失 `BUILD.bazel` 阻塞，不视为产品 Bazel 构建通过 |
| 文件逐字节对照、Cargo metadata、锁文件、本地文档链接与 `git diff --check` | 通过；旧目录引用已清除，本批未修改锁文件 |

本批共运行 50 个 Rust 行为测试，迁移 crate 的 Bazel 单测另行通过。实现和测试未改写，现有行为断言足以覆盖此次目录移动；没有 snapshot 变更或待接受文件。

此次验证平台为 macOS，未执行 Windows/Linux 构建、真实 PTY 交互或实际打包发布。Bazel 仍输出既有第三方 annotation 与测试 size 提示。

### 第四批执行记录

- 2026-09-22：Workbench 改为创建 `DiffService`；双栏、Multi Diff 和 Quick Diff 统一使用 Editor 的 `WorkerDiffComputationService`，旧 App Server 交互适配器及其测试已退出。
- `lineDiff.ts` 在前端计算精确行对齐、连续 hunk 和字素级 UTF-16 范围，使用线性空间 Myers 分割。Worker 在长计算中让出执行权处理取消；释放计算服务会终止其 Worker。
- 保留 `DiffModel` 的请求代次、双侧版本检查和源模型生命周期。Worker 只消费一次性快照，没有远程编辑对象、文本镜像或撤销状态。
- Quick Diff 仍从 Git provider 获取基线；未保存文本变化直接在前端重新计算，不重新请求 Git 基线。后台 `ash-diff`、`diff/compute` 和 Git/Agent 业务接口保持原有实现。
- 未增加依赖，未修改锁文件、Rust 实现或生成协议。没有变更编辑器 DOM、主题或快捷键。

| 第四批验证 | 结果 |
| --- | --- |
| `pnpm --dir app-ts test:unit`，用 `--run` 选择 8 个 Diff 行为测试文件 | 26 个测试通过；覆盖算法、300 组重复行/重排对齐、Unicode、空行、2 万行编辑、取消、并发、版本、释放及现有窗格行为 |
| 同一命令追加 `test/architecture/editor-architecture.test.ts` | 23 个检查通过，1 个既有检查失败；整个合并命令退出 1，不记为全套通过 |
| `pnpm --dir app-ts test:editor:browser diff.integration.spec.ts` | Chromium 下 3 个 Playwright 场景通过：真实 Worker、双栏/行内/Multi Diff、F7 与朗读状态、dirty buffer/Quick Diff、大计算取消 |
| `pnpm --dir app-ts build:renderer` | 通过，生产产物包含独立 Diff Worker |
| `pnpm --dir app-ts test:smoke:ui areas/windows/home.spec.ts` | main/preload/renderer 完整构建与自动化类型检查通过；Electron UI 的实际产品启动场景通过 |
| 旧交互入口检索、锁文件检查、文档与 `git diff --check` | 通过；后台 Diff API 仍独立保留 |

8 个行为测试文件为 `lineDiff`、`diffModel`、`workerDiffComputationService`、`diffEditorWidget`、`multiDiffEditorWidget`、`quickDiff`、`diffEditorPane` 和 `multiDiffEditorPane`。

既有架构检查 `Flat editor layout keeps one TextModel owner and both mode bundles` 仍要求不存在的 `contrib/smartSelect/common/selectionRanges.ts`。本批前的 Git 版本已同时存在该断言与文件缺失；本批未修改 Smart Select，也没有削弱该断言。

验证平台为 macOS。Electron 场景验证产品启动与装配，Diff 行为由 Chromium 真实 Worker 场景覆盖；未执行 Electron 后端完整业务场景、跨平台构建或帧率基准。Electron 测试输出环境已有的 `NO_COLOR`/`FORCE_COLOR` 冲突提示，产品构建没有新增 warning。

### 第五批执行记录

- 2026-09-22：`AppServerSyntaxProviders` 已退出基础 token 注册，删除后台 token 的前端映射。Code 使用现有 `BrowserTextMateService` 和前端 Worker 计算词法高亮与假设文本预览；后台继续提供诊断、符号、折叠和结构选择。
- 内置 JavaScript/JSX、TypeScript/TSX、JSON/JSONC、Rust 与 Shell 的真实扩展 manifest、grammar、注入规则和语言配置通过现有扩展装载链验证，没有复制 grammar 或增加依赖。
- Shell 前端标识统一为 `shellscript`。文件识别、grammar、LSP provider 注册与诊断同步使用同一标识；后台语法接口和服务目录中的 `shell` 在 Workbench 适配处转换。
- 浏览器场景让后台分析请求保持未完成，验证输入中文和 emoji、撤销注释结束符后的重新着色、预览着色和模型版本；释放后台请求后，诊断结果仍对应当前版本。
- 未修改 Rust、协议、扩展资源或锁文件。TextModel 仍独占编辑事务、选区与历史；静态 grammar 资源仍由扩展资源服务提供。

| 第五批验证 | 结果 |
| --- | --- |
| `pnpm --dir app-ts test:unit`，用 `--run` 选择 `appServerSyntaxProviders`、`appServerLanguageProviders`、`appServerLanguageDiagnosticsService`、`textMateTokenizationService` 四个文件 | 32 个行为测试通过，包含异步能力分离、Shell 注册与同步、增量行状态、取消及预览 |
| `pnpm --dir app-ts test:unit --run test/architecture/editor-architecture.test.ts --grep 'Frontend lexical tokens'` | 本批受影响的 1 个归属检查通过；没有重跑全套架构检查，第四批记录的既有问题不在本批修改范围 |
| `pnpm --dir app-ts test:editor:browser tokenization.integration.spec.ts` | Chromium 下 2 个 Playwright 场景通过；真实扩展装载与 Worker 覆盖全部八种语言和编辑期间的异步边界 |
| `pnpm --dir app-ts build` | main/preload/renderer 完整构建通过，包含生产 TextMate Worker 与 Oniguruma WASM |
| `pnpm --dir app-ts exec tsc -p test/automation/tsconfig.json`；`pnpm --dir app-ts exec playwright test --project=electron-editor-app-server --grep 'Code highlights Rust locally'` | 自动化类型检查通过；使用本机已有开发后台包，实际 Electron 产品中的 Rust 高亮与文档符号查询通过 |
| 旧 token 入口检索、锁文件与资源检查、`git diff --check` | 通过，无新增依赖或生产构建 warning |

验证平台为 macOS，未执行跨平台构建或帧率基准。Playwright 仍输出环境已有的 `NO_COLOR` / `FORCE_COLOR` 冲突提示。没有截图基线变更。

本计划列出的五批迁移均已完成定向验证。后台业务 Diff、Git、Agent Patch、文件 I/O 和异步语言服务继续留在各自后端 owner。

## 第五批补充：语言声明与 VS Code 职责对齐

此前第五批只完成高亮计算归属，语言声明仍由扩展与内置表重复提供；此补充项已修正该缺口并完成下述定向验证。

- 行为链：打开文件或 standalone 创建模型 → LanguageService → 扩展/宿主注册的语言关联与配置 → 同一 TextModel 和前端 TextMate Worker → 识别、编辑与高亮；卸载扩展时注册一同退出。
- 上游参照：Editor 的 LanguageService/LanguagesRegistry、standaloneServices、Workbench 的 languageService 与 TextMate 扩展入口。只核对公开职责与行为，不复制实现。
- 保留 Ash 的实例级注册表、扩展资源适配与 JSON provider；不引入全局第二份语言状态。

| 准入路径（相对 app-ts/） | 对应关系、动作与验证 |
| --- | --- |
| `src/ash/editor/common/services/languageService.ts`、`src/ash/editor/standalone/browser/standaloneServices.ts` | 双方都有；核心只注册纯文本，standalone 宿主显式注册其他语言；验证注册、撤销和模型语言 |
| `src/ash/editor/standalone/common/builtinLanguages.ts` | 仅 Ash；按本轮 fix 清除重复生产定义，全部调用方同步退出，测试规则归测试目录 |
| `src/ash/platform/language/common/textResourceLanguage.ts` | 仅 Ash 资源适配；删除硬编码 MIME/后缀表，识别委托注入的语言注册表 |
| `src/ash/workbench/browser/parts/editor/editorPane.ts`、`editorRegistry.ts`、`src/ash/workbench/contrib/codeEditor/browser/codeEditorInput.ts` | Ash 现有文件选择链；补充低于专用编辑器、高于可选编辑器的内置优先级，让文件打开不依赖扩展加载时机；通过真实 descriptor 排序与 Electron 打开/保存验证 |
| `src/ash/workbench/services/language/browser/workbenchLanguageFeatures.ts`、`src/ash/workbench/browser/workbench.ts` | 现有 Ash 装配；退出内置语言身份/编辑规则注册，保留现有 JSON provider |
| `src/ash/editor/test/common/modes/testLanguageConfigurationService.ts`、`src/ash/editor/test/common/cursor/languagePairEditing.test.ts`、`languageEnter.test.ts`、`languageAutoClosingTracker.test.ts` | 迁移测试规则与导入，保留既有行为断言 |
| `src/ash/editor/test/common/languageFeaturesService.test.ts`、`src/ash/editor/test/browser/standaloneEditor.test.ts` | 验证默认纯文本、宿主注册与资源释放 |
| `src/ash/workbench/contrib/codeEditor/test/common/editorInput.test.ts`、`src/ash/workbench/contrib/codeEditor/test/browser/codeEditorPane.test.ts`、`src/ash/workbench/services/language/test/common/languageFeaturesService.test.ts` | 显式注册测试语言，验证文件选择、语言解析与既有 provider |
| `test/integration/browser/languageExtensions.ts`、`tokenization.integration.ts`、`tokenization.integration.spec.ts`、`textModel.integration.ts`、`textModel.integration.spec.ts`、`language.integration.ts` | 复用真实扩展资源 fixture，等待实际注册完成，验证 grammar/配置/关联一起加载与退出、输入和文件模型 |
| `src/ash/workbench/services/language/README.md`、`src/ash/editor/api-alignment-status.md`、`src/ash/editor/browser/README.md`、`docs/editor-architecture.md` | 修正重复内置表的旧职责说明，记录验证范围 |

### 补充项执行结果

- 核心仅保留纯文本；生产中的语言声明、编辑规则、grammar 从扩展装载，standalone 由宿主显式注册。删除重复内置语言文件和平台 MIME/后缀表，原规则仅保留为编辑算法的测试 fixture。
- Electron 验证发现扩展异步装载前，文本与二进制编辑器的可选优先级相同，导致错误打开为二进制。现有 EditorPaneRegistry 增加内置优先级，普通文件由文本编辑器接管，专用类型与显式 Open With 保留优先权。
- 文件编辑器浏览器 fixture 改为装载真实扩展，等待注册完成；辅助阅读选区场景还等待首轮着色，避免把异步初始化当作用户选区操作。

| 补充项验证 | 结果 |
| --- | --- |
| `test:unit --run` 定向选择语言身份、standalone、三个 Cursor 文件、Code pane/input、扩展、Workbench provider、EditorPart | 10 个文件共 116 个测试通过；首次 standalone 断言修正为显式宿主注册后重跑通过 |
| `test:editor:browser language.integration.spec.ts tokenization.integration.spec.ts` | 4 个 Chromium 场景通过，覆盖八种语言、后台分析未完成时编辑、扩展卸载 |
| `test:editor:browser textModel.integration.spec.ts` | 首次 25 个场景通过；调整服务构造后的复验为 24 个通过、1 个辅助阅读选区时序失败；修正后两个相关场景各重复三次通过 |
| `pnpm --dir app-ts build`、`build:stanza` | 桌面 main/preload/renderer 与独立 Stanza 构建通过，无新增生产 warning |
| 自动化 TypeScript 检查、Electron `App Server workspace files open` 与 `Code highlights Rust locally` | 类型检查通过；修正编辑器选择后两个真实产品场景通过，覆盖文件打开/编辑/保存、Rust 本地高亮及异步文档符号 |
| `check-editor-alignment.mjs --structure-only`、旧生产入口检索与 `git diff --check` | 通过；结构报告仍有本批以外的未完成 API，不视为整体对齐完成 |

验证平台为 macOS，使用已有开发后台包；未执行跨平台构建或帧率基准。没有修改 Rust、扩展资源、协议、依赖或锁文件，也没有截图基线变更。JSDOM Canvas 和 Playwright 颜色环境提示为既有输出。

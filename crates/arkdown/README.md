# Arkdown

Arkdown 是 Ash 的 Rust 文档核心，Cargo 包名为 `ash-arkdown`。原生库与浏览器 WASM 绑定使用同一份模型和编辑实现，宿主持有文件、网络和界面生命周期。

## 当前能力

- CommonMark 与表格、任务列表、删除线、脚注、数学语法的解析投影。
- 每个节点附带原文 UTF-8 字节区间和 UTF-16 区间；源码保留原有换行、空白、转义及 Markdown 定界符。
- 带预期版本的原子多段文本事务；拒绝重叠区间、重复插入点及拆开代理对的坐标。
- 按事务撤销、重做；版本单调递增，空操作不创建历史，新的编辑使重做失效。
- 按 Unicode 字素移动，包括组合音符、emoji、ZWJ 序列和 CRLF。
- 预览 HTML 转义原始 HTML，移除不受支持的链接与图片 URL scheme；资源加载、导航和 CSP 仍归宿主。
- 原生 JSON 示例及 WASM 接口，包含跨目标行为一致性测试。

源码是唯一可写文档状态，解析树与 HTML 是只读投影。节点区间覆盖原文语法，不能直接作为 DOM 文本选区：实体、转义与隐藏的定界符仍需要呈现层做位置映射。事务各区间均指向同一个输入版本，不按数组顺序逐步重新定位。

当前解析使用完整解析。IDE 的可选“Markdown document”编辑器与 Docs 共用 Arkdown WASM，支持正文直接编辑、加粗、斜体和 Markdown 源码切换；DOM、选区、剪贴板与 IME 由 Workbench Markdown 基座的 `ArkdownEditor` 持有，源码模式复用 `CodeEditorWidget`。增量解析、表格结构命令、协作及 `.ash-doc` 格式适配尚未提供。

输入限制为 16 MiB 源码、每事务 4096 个编辑、每次解析 100000 个节点和 128 层容器。历史按删除与插入文本的合计字节计量，最多保留 256 个事务或 16 MiB；超过历史预算会淘汰最早事务，包括单次超出预算的事务。撤销历史只在当前模型存活期间有效。

## 接口与所有权

`Document` 持有源码、版本和历史；`Transaction` 使用 `expected_revision` 及 UTF-16 `TextEdit`。失败的事务不修改源码、版本或历史。`Snapshot` 暂时是进程间和测试使用的解析投影，不是新的持久化文件格式。Rust 数据 JSON 使用 `snake_case`，JS 方法使用 `camelCase`。

`ArkdownDocument` WASM 接口提供 `source`、`revision`、`canUndo`、`canRedo`、`snapshotJson()`、`applyTransactionJson()`、`undo()`、`redo()`、`renderHtml()`、`previousGrapheme()` 和 `nextGrapheme()`。宿主在模型关闭后调用 `free()` 释放实例；错误以包含 `code` 的 JSON 字符串抛出。事务 JSON 的单次输入上限同为 16 MiB。

`parseMarkdownJson(source)` 提供只读语法投影，`validateMarkdownEditsJson(source, edits)` 返回校验后的编辑。Docs 使用这两个无状态接口，将编辑提交到现有 `TextModel`；`EditorWorkingCopy` 继续持有 dirty、保存、外部修改和备份契约，撤销重做使用文本模型的同一份历史。Docs 不保留独立可写的 `ArkdownDocument`。

原生与 WASM 是同一核心的运行目标，不应在一个编辑会话中各维护一份可独立覆盖的源码。原生宿主可使用 `Document` 持有独立文档会话；与现有工作副本集成时，由宿主选择唯一状态和历史 owner。

常规构建准备与 Vite 启动通过 `build/arkdown.py` 编译 WASM 并生成浏览器绑定。生成器版本与 workspace 的 `wasm-bindgen` 一致，源码、Cargo 输入和生成产物哈希共同校验缓存；产物位于 `.build/arkdown/web`，不提交二进制。

`yrs` 尚未引入。现有 `ash-collab` 持有有序结构化事务和重放协议，接入 CRDT 前需要明确文档表示、协议及历史迁移；Arkdown 不直接替换现有事务载荷。

## 验证

在仓库根目录运行：

```sh
just verify ash-arkdown --lib
just dependencies
rustup target add wasm32-unknown-unknown
just check ash-arkdown --target wasm32-unknown-unknown --features wasm --lib
just rust-warnings ash-arkdown --target wasm32-unknown-unknown --features wasm
```

跨原生/WASM 验证使用仓库的 `ci-test` profile；绑定生成器版本与根 workspace 的 `wasm-bindgen` 一致：

```sh
cargo install wasm-bindgen-cli --version 0.2.126 --locked --root .build/tools/arkdown
./scripts/.venv/bin/python -B scripts/cargo.py build -p ash-arkdown --profile ci-test --example inspect
./scripts/.venv/bin/python -B scripts/cargo.py build -p ash-arkdown --profile ci-test --target wasm32-unknown-unknown --features wasm --lib
.build/tools/arkdown/bin/wasm-bindgen .build/cargo/wasm32-unknown-unknown/ci-test/ash_arkdown.wasm --target web --out-dir .build/arkdown/web
node --test crates/arkdown/tests/wasm.test.mjs
```

Windows 使用 `scripts/.venv/Scripts/python.exe` 和生成器 `.exe`。Node 测试可通过 `ARKDOWN_WASM_BINDINGS`、`ARKDOWN_NATIVE_EXAMPLE` 指定构建产物。

`examples/inspect.rs` 从 stdin 读取 `{"source":"# Arkdown","transactions":[]}`，输出最终 `snapshot`、`html` 和 `changes`。它是实际使用原生核心的验证宿主，不注册额外的产品 CLI 命令。

## 实现来源

以 Claude 中可观察到的文档能力和公开标准作为行为参考，使用开源依赖自主实现；源码和构建不包含 Claude 的 JS/WASM 产物。依赖版本继承 Ash workspace，项目许可证继承仓库。Claude 依赖取证见 [Docs 文档](../../src/ash/sessions/contrib/docs/README.md#clarkdown-的-rust-依赖证据)。

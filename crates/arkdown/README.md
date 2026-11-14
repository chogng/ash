# Arkdown

Arkdown 是 Ash 的 Rust 文档核心，Cargo 包名为 `ash-arkdown`。原生库与浏览器 WASM 绑定使用同一份模型和编辑实现，宿主持有文件、网络和界面生命周期。

## 当前能力

- CommonMark 与表格、任务列表、删除线、脚注、数学语法的解析投影。
- 每个节点附带原文 UTF-8 字节区间和 UTF-16 区间；源码保留原有换行、空白、转义及 Markdown 定界符。
- 带预期版本的原子多段文本事务；拒绝重叠区间、重复插入点及拆开代理对的坐标。
- 按事务撤销、重做；版本单调递增，空操作不创建历史，新的编辑使重做失效。
- 按 Unicode 字素移动，包括组合音符、emoji、ZWJ 序列和 CRLF。
- 预览 HTML 转义原始 HTML，移除不受支持的链接与图片 URL scheme；资源加载、导航和 CSP 仍归宿主。
- 标题／段落、无序／有序／任务列表转换和顶层表格加行；额外保留任务勾选与正文行删除。结构操作生成保真文本编辑，沿用宿主事务与撤销。
- 顶层区块窗口增量解析覆盖行内格式、列表、表格、代码块和段落拆分。包含 `[` 或 `<` 的文档保守完整解析，避免引用和 HTML 的远距离影响。
- Yrs CRDT 会话支持状态向量、差量更新、乱序与重复投递、并发收敛及保留远端编辑的本地撤销／重做。
- 原生 JSON 示例及 WASM 接口，包含跨目标行为一致性测试。

源码是唯一可写文档状态，解析树与 HTML 是只读投影。节点区间覆盖原文语法，不能直接作为 DOM 文本选区：实体、转义与隐藏的定界符仍需要呈现层做位置映射。事务各区间均指向同一个输入版本，不按数组顺序逐步重新定位。

Agent Window 的 Chat 模式中，Docs 使用 Arkdown WASM，支持正文直接编辑、加粗、斜体和 Markdown 源码切换。DOM、选区、剪贴板与 IME 由 Sessions Docs 的 [`ArkdownEditor`](../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownEditor.ts) 持有，源码模式复用 `CodeEditorWidget`。IDE 和 Agent Window 的 Code 模式使用 Markdown 扩展的源码编辑与预览。正文渲染使用随编辑器释放的只读增量投影缓存，缓存不能提交编辑。标题和列表转换已接入正文快捷键，表格支持 Tab／Shift+Tab 导航及末尾 Tab 加行。CRDT 会话已通过 `ash-collab` 接入 Workbench 在线房间。Sessions 的迁移器将旧 `.ash-doc` 单向转为 Markdown，保留原文件。

输入限制为 16 MiB 源码、每事务 4096 个编辑、每次解析 100000 个节点和 128 层容器。本地 `Document` 的历史按删除与插入文本的合计字节计量，最多保留 256 个事务或 16 MiB；超过历史预算会淘汰最早事务，包括单次超出预算的事务。撤销历史只在当前模型存活期间有效。

## 接口与所有权

`Document` 持有源码、版本和历史；`Transaction` 使用 `expected_revision` 及 UTF-16 `TextEdit`。失败的事务不修改源码、版本或历史。`Snapshot` 暂时是进程间和测试使用的解析投影，不是新的持久化文件格式。Rust 数据 JSON 使用 `snake_case`，JS 方法使用 `camelCase`。

`ArkdownDocument` WASM 接口提供 `source`、`revision`、`canUndo`、`canRedo`、`snapshotJson()`、`applyTransactionJson()`、`undo()`、`redo()`、`renderHtml()`、`previousGrapheme()` 和 `nextGrapheme()`。宿主在模型关闭后调用 `free()` 释放实例；错误以包含 `code` 的 JSON 字符串抛出。事务 JSON 的单次输入上限同为 16 MiB。

`ArkdownProjection.parseJson(source)` 缓存上次权威源码的只读投影；重复源码直接复用解析树，区块窗口内的编辑局部解析，稳定后缀收敛后停止，并移动后续节点的 UTF-8 与 UTF-16 区间。缓存失效时完整解析；解析失败保留上次有效缓存。正文比较语法与原文，只替换变更区块，保留未变 DOM 并更新源码坐标。

`markdownOperationEditsJson(source, operation)` 返回结构编辑；`ArkdownDocument.applyOperationJson(expectedRevision, operation)` 在独立文档会话中直接提交同一操作。任务操作的偏移指向 `[ ]` 标记；表格操作偏移指向标题或正文行，删除只支持正文行，嵌套表格拒绝修改。

`parseMarkdownJson(source)` 提供无缓存只读语法投影，`validateMarkdownEditsJson(source, edits)` 返回校验后的编辑。正文视图使用 `ArkdownProjection`，编辑校验使用无状态接口，最终将编辑提交到现有 `TextModel`；`EditorWorkingCopy` 继续持有 dirty、保存、外部修改和备份契约，撤销重做使用文本模型的同一份历史。Docs 不保留独立可写的 `ArkdownDocument`。

原生与 WASM 是同一核心的运行目标，不应在一个编辑会话中各维护一份可独立覆盖的源码。原生宿主可使用 `Document` 持有独立文档会话；与现有工作副本集成时，由宿主选择唯一状态和历史 owner。

常规构建准备与 Vite 启动通过 `build/arkdown.py` 编译 WASM 并生成浏览器绑定。生成器版本与 workspace 的 `wasm-bindgen` 一致，源码、Cargo 输入和生成产物哈希共同校验缓存；产物位于 `.build/arkdown/web`，不提交二进制。

`Buffer` / `ArkdownBuffer` 持有协作操作日志与选择性历史；独立宿主可直接读取源码。Workbench 使用 `TextModel` 的编辑参与者先提交操作，再更新唯一可编辑缓冲区；远端更新和撤销也通过该缓冲区发布。语法投影不参与协作状态写入。旧的外部事务清空历史接口已移除。

协作使用 Yrs 0.26 的 UTF-16 Y.Text，根键为 `markdown`。宿主分配非零、53 位安全且唯一的 client ID；创建者写入初始源码，加入者从空会话应用创建者更新，不能各自插入相同初始文本。`stateVector()` 返回 Yjs v1 状态向量；`encodeUpdate(vector)` 编码对方缺少的更新，空向量请求完整状态。`applyUpdate(bytes)` 返回 UTF-16 文本变化，重复或待依赖更新没有可见变化时不推进本地 revision。

更新先在临时副本校验，失败不修改源码或历史；撤销也预先检查恢复后的源码大小。源码上限 16 MiB，单个更新和状态向量输入上限 32 MiB。协作历史按 256 次操作或 16 MiB 分段建立检查点，释放此前撤销内容；单次超过预算的操作不保留历史。每次更新回收窗口外的删除内容，保留 CRDT 时钟和操作身份以兼容离线更新。`previewJson(action, vector)` 在隔离副本上预检源码与编码大小，不改变当前历史。`applyTransactionJson`、`applyOperationJson`、`undo`、`redo` 校验本地 revision，远端更新保留本地历史。

身份、授权、房间和持久化由 `ash-collab` 持有，Workbench 会话持有重连与文件绑定。`arkdown-markdown-v1` 使用独立的版本化 JSON／Base64 Yjs v1 载荷；原 Document Engine 房间保持原 Schema。服务端合并并持久化权威更新，继续执行版本、幂等、事务大小和成员权限校验。

正文快捷键：Control／Command+Alt+0 至 6 设置段落或标题；Control／Command+Shift+7、8、9 设置有序、无序或任务列表。表格 Tab／Shift+Tab 切换单元格，末尾 Tab 加行。当前转换针对顶层 ATX 标题、段落或列表；嵌套容器和 Setext 标题使用源码编辑。任务勾选与表格删行保留为额外核心操作，不作为已确认的 Clarkdown 对齐项，也不新增界面入口。

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

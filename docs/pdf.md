# `ash-pdf`：PDF 文档入库、系统边界与演进

> 当前 crate 接口、PDFium binding 与 native smoke test 见
> [`ash-rs/utils/pdf/README.md`](../ash-rs/utils/pdf/README.md)。本文拥有 PDF ingestion、OCR、
> retrieval 与 citation 的跨系统边界和演进方向。

## 快速理解

`ash-pdf` 是 Ash 的 **PDF 原生处理边界**：它通过随安装包发布的
PDFium 读取页面并提取原生文字。页面渲染是为 OCR 准备的 Proposed extension，当前尚未实现。

它不是 PDF 知识库、RAG 或 Agent Memory。持久化的文档、chunk、索引和检索
策略应由上层 document-library / app-server 领域服务拥有；`ash-pdf` 只提供
可测试、可替换的 PDF 解析能力。

```text
Desktop 预览                   Agent 知识库
───────────                   ─────────────
Chromium PDF Viewer            document-library / App Server
（用户查看）                         │
                                      ▼
                         ash-pdf（PDFium 原生边界）
                           ├─ 原生文字提取
                           └─ 页面渲染（仅 OCR 需要时）
                                      │
                                      ▼
                          OCR / chunk / FTS / 向量索引 / RAG
```

Electron/Chromium 的 PDF Viewer 可以负责普通预览，不需要由 `ash-pdf`
渲染页面。只有 Agent 入库、文字定位、扫描页 OCR 或生成缩略图等后端工作才
使用 PDFium。

| 用户需求 | 当前路径 | 当前状态 |
| --- | --- | --- |
| 在 Desktop 的 Code Workbench 中查看 workspace PDF | Chromium PDF Viewer | 已实现：Explorer 打开 `.pdf`，受限读取后以 Blob URL 交给浏览器阅读器 |
| 让 Agent 读取原生文字 | PDF 处理边界提取逐页文字 | 已实现 |
| 识别扫描版 PDF | 渲染页面后交给 OCR | 计划设计 |
| 建立可搜索知识库 | 文档库负责身份、切片和索引 | 尚未实现 |
| 从回答跳回原页 | 文档库保存页码和来源范围 | 计划设计 |

## 2. 当前基础与发布契约

当前 crate 位于 [`ash-rs/utils/pdf`](../ash-rs/utils/pdf)，包名为
`ash-pdf`，Rust crate 名为 `ash_pdf`。它已经提供：

- `PdfiumRuntime::from_bundled_root()`：从发布目录解析当前平台的动态库；
- `PdfTextExtractor::bind()`：进程启动时显式绑定 PDFium；
- `PdfTextExtractor::extract_file()`：按页、按原顺序提取原生文字；
- `ExtractedPdfPage::page_number`：稳定的 **一基页码**，可直接用于引用和
  Desktop 跳页；空白页也会保留，供上层判定是否需要 OCR。

PDFium 由 [`build/download/fetchPdfium.ts`](../build/download/fetchPdfium.ts) 在 CI / 发布
构建时按 [`third_party/pdfium/runtime-lock.json`](../third_party/pdfium/runtime-lock.json)
锁定的版本下载、校验并 stage 到：

```text
resources/native/pdfium/
├── macOS:   lib/libpdfium.dylib
├── Windows: bin/pdfium.dll
└── Linux:   lib/libpdfium.so
```

运行时不搜索系统 PDFium，也不要求最终用户另行安装。App Server 启动时绑定一次，
将 `PdfTextExtractor` 作为进程内共享服务复用；不能每个导入请求重新装载动态库。

## 3. 明确的职责边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `ash-pdf` | Current：PDFium 绑定、原生文字、PDF 错误；Proposed：页级几何与渲染 | 文件持久化、OCR 模型、chunk、embedding、检索、Memory |
| document-library（新增领域服务） | 文档身份、内容哈希、版本、页面记录、导入状态、chunk 与引用 | PDFium 动态库加载、浏览器预览 UI |
| OCR worker | 仅对需要识别的渲染页做 OCR，返回文字与置信度 | 判断文档归属、写检索索引 |
| 检索服务 | FTS / 向量检索、融合、rerank、过滤 | 修改源 PDF 或 Agent 记忆 |
| Desktop | 导入入口、进度、引用跳转、Chromium PDF 预览 | 直接保存本地绝对路径、解析不可信 PDF |

特别地，PDF 知识库和 Agent Memory 必须分开：PDF chunk 是可复现、可引用的
客观文档证据；Memory 是用户偏好、确认的决策和会变化的项目状态。回答时可以
分别检索两者，但不得把 PDF 片段写成用户 Memory。

### 3.1 当前 Workbench 阅读器

`app-ts/src/ash/workbench/contrib/pdf` 是一个 Workbench contribution，不属于
`editor` 的文本或结构化文档 engine。它匹配 `application/pdf` 和 `.pdf` resource；通过
`IFileService.readFileBytes` 请求 App Server 的 workspace-relative `fs/readBinaryFile`，
再创建 `application/pdf` Blob URL 并嵌入 Chromium 的原生 PDF Viewer。

这条路径的边界是刻意的：Renderer 不会收到主机绝对路径，`file:` URL 也不会进入
PDF 阅读器；后端将预览读取限制为 16 MiB，并经连接所有的 ResourceStore 以 256 KiB
分块读取，避免二进制内容超过 JSONL 帧上限。页面、缩放、搜索、打印与下载由 Chromium
PDF Viewer 自己负责，贡献只拥有匹配、加载、可见性和 Blob URL 生命周期。

## 4. 身份、所有权与引用

内部接口使用下列三个层次的身份，避免把临时上传资源泄漏到持久知识库。

```text
ResourceId（连接所有、短暂）
        │  导入期间 materialize
        ▼
DocumentId（持久、面向用户的文档） ── DocumentRevisionId / SHA-256（不可变内容）
        │
        ├─ PageNumber（NonZeroU32；一基）
        └─ PdfChunkId（持久 chunk） ── SourceSpan { revision, page range, offsets }
```

- `ResourceId` 是 App Server `ResourceStore` 的 connection-owned 临时资源。断开
  连接或 `resource/release` 后便不再有效；它绝不能写入 `documents`、citation 或
  vector metadata。
- `DocumentId` 表示用户看到的一份逻辑文档；`DocumentRevisionId` 或内容
  SHA-256 表示一份不可变的源文件内容。内容哈希用于去重、重新索引和审计。
- `PageNumber` 以 `NonZeroU32` 表示，一律一基。任何 PDFium 零基索引转换只能
  留在 `ash-pdf` 内部。
- 引用只记录 durable source span，例如
  `{ document_id, revision_id, page_start, page_end, char_start, char_end }`；不要
  记录桌面文件路径或临时资源 ID。

源文件在导入开始时必须复制或原子移动到应用拥有的不可变存储，再开始耗时解析。
这也允许连接结束后继续执行 job、断点恢复和可靠地重新索引。

## 5. 导入生命周期

当前 App Server 只有临时 Resource API，下面的 `document/import` 和 job/progress
接口均为 **Proposed**；实现前不得把它们伪装成当前 JSON-RPC 方法。

```text
选择本地 PDF / Resource 上传
          │
          ▼
materialize 到 app-owned staging（仍可读取 Resource 时完成）
          │
          ▼
计算 SHA-256 → 去重 / 创建 DocumentRevision
          │
          ▼
原子写入不可变 source store
          │
          ▼
native extract（ash-pdf）→ PageRecord
          │                         │
          │                  仅空白/低质量页
          │                         ▼
          │                    render + OCR
          ▼
结构恢复 → chunk → FTS / embedding → 索引发布
          │
          ▼
DocumentIngestionJob 完成；Desktop 收到进度与可引用 revision
```

解析、OCR 与 embedding 都是可长时间运行且可能重试的工作，不能阻塞一条 JSON-RPC
request。`document/import` 应立即返回 durable `DocumentImportReceipt { document_id,
revision_id, job_id }`，进度经 server notification / subscription 报告。只有索引
完整发布后，该 revision 才对检索可见。

建议状态为：

```text
staging → hashing → extracting → ocr_pending? → chunking → indexing → ready
                                                  └────────→ failed | cancelled
```

`failed` 仍保留已持久化 source、失败阶段和可诊断的错误码；其未完成 chunk 不得混入
检索结果。重试创建新的 job，不覆盖已有的可用 revision。

## 6. 内部接口

### 6.1 `ash-pdf` 保持窄接口

现有的 `PdfTextExtractor` 是 PDFium adapter。后续扩展应该围绕页面事实，而不是
暴露 PDFium 的对象、FFI handle 或底层页索引给上层：

```rust
/// Extracts page-level PDF facts from an application-owned immutable source.
///
/// Implementations must preserve source page order and return one-based page
/// numbers. They do not persist data or decide retrieval policy.
pub trait PdfPageExtractor: Send + Sync {
    fn extract(&self, source: &PdfSource) -> Result<ExtractedPdfDocument, PdfError>;
}

pub struct PdfSource {
    pub revision_id: DocumentRevisionId,
    pub path: OwnedPdfPath,
    pub content_digest: ContentDigest,
}

pub struct ExtractedPdfPage {
    pub page_number: PageNumber,
    pub text: String,
    pub extraction: NativeTextExtraction,
}
```

这是目标形状，不要求当前立刻引入 trait。当前 `PdfTextExtractor` 可先作为唯一
PDFium 实现；在确实需要 fixture/fake 或第二个解析后端时，再以该 trait 收口。
`PdfSource` 只接受应用拥有的文件，不能接受 `ResourceId` 或 Desktop 路径。

渲染单独使用显式请求类型，避免 `render_page(page, true)` 这类难读的布尔参数：

```rust
pub enum PdfRenderPurpose {
    Ocr,
    Thumbnail,
}

pub struct PdfPageRenderRequest {
    pub page_number: PageNumber,
    pub purpose: PdfRenderPurpose,
    pub max_pixel_size: PixelSize,
}
```

### 6.2 document-library 拥有持久化与编排

将导入服务放在上层 crate（建议 `ash-document-library`），依赖 `ash_pdf`，而非
反向让工具 crate 依赖 App Server、数据库或向量库：

```rust
/// Coordinates durable PDF ingestion without exposing storage implementation
/// details to callers.
pub trait PdfImportService: Send + Sync {
    fn import(&self, request: PdfImportRequest) -> Result<DocumentImportReceipt, ImportError>;
}

pub struct PdfImportRequest {
    pub source: ImportSource,
    pub duplicate_policy: DuplicatePolicy,
    pub extraction_mode: TextExtractionMode,
}

pub enum ImportSource {
    OwnedStagingFile { path: StagedPdfPath },
}

pub enum DuplicatePolicy {
    ReuseReadyRevision,
    ReindexExistingRevision,
}

pub enum TextExtractionMode {
    NativeTextOnly,
    NativeTextThenOcrWhenNeeded,
}
```

App Server 的 Resource adapter 负责在调用此接口前把临时 resource materialize 成
`StagedPdfPath`。如此 `ash-pdf` 和 document-library 不依赖 connection lifecycle，
也不会在 public API 中出现难以理解的 `Option<ResourceId>` 或行为不明的 bool。

持久化记录至少应包含：

```text
Document              逻辑身份、标题、当前可用 revision
DocumentRevision      digest、原始文件位置、页数、导入版本、状态
PageRecord            revision、PageNumber、文字、Native/OCR 来源、质量与错误
PdfChunk              content、heading path、token 数、SourceSpan
IndexPublication      FTS/vector generation、可见状态与失败原因
```

### 6.3 OCR、chunk 与检索接口

OCR 是页级 fallback，不是默认路径：原生文字为空、乱码或质量低于显式阈值的页才进入
`ocr_pending`。OCR 返回的 `ExtractionProvenance::Ocr { engine, confidence }` 必须写入
`PageRecord`，使引用和调试能区分原生文字与识别文字。

chunk 以标题、段落、列表和页面边界优先，保留 `SourceSpan`；第一版可采用目标 token
范围与明确重叠策略，但不得按字符切断标题与正文。双栏、表格和公式应标记已知限制，
而不是伪造结构化结果。

检索层接受 `RetrievalQuery`（文本、document scope、revision filter、结果数），返回
带 `SourceSpan` 的 `RetrievedChunk`。它可以内部组合 FTS/BM25、dense vector、RRF 和
rerank；这些索引实现不能泄漏为 Agent tool 的稳定参数。Agent 最终只接收证据与引用，
并与单独检索到的用户 Memory 分栏放入 prompt。

## 7. 错误、安全与资源限制

错误需要结构化而非仅保存 PDFium 文本。最少区分：

```text
pdfium_unavailable   固定运行时缺失、校验或装载失败
invalid_pdf          损坏或不支持的 PDF
password_required    需要密码；不持久化明文密码
extraction_failed    原生文字阶段失败
render_failed        OCR 前的页面渲染失败
ocr_unavailable      OCR worker/模型不可用
storage_failed        source/page/chunk 持久化失败
index_failed          FTS/vector 索引发布失败
cancelled             job 被明确取消
```

PDF 是不可信输入。导入层应限制文件大小、页数、单页像素和总渲染预算；记录 digest
与解析器版本；不把调用者本地绝对路径返给 renderer；并尽快把原生解析/OCR 放入可重启
的隔离 worker，避免畸形 PDF 的 native crash 影响 App Server。密码仅在一次导入操作的
受保护内存中使用，绝不进入日志、job payload 或检索索引。

## 8. Desktop 与引用跳转

Desktop 只用 `DocumentId + DocumentRevisionId + PageNumber` 请求受控的应用协议 URL，
再交给 Chromium PDF Viewer 打开。Renderer 不直接获得 source store 路径。

RAG 回答携带的 citation 至少有文档标题、document/revision ID 和一基页码范围；点击
引用即可打开指定 revision 并跳到该页。文字矩形高亮需要以后补充页级坐标/span 映射，
它不应阻塞第一版的可靠页码引用。

## 9. 实施顺序与验收

1. **运行时基础（已开始）**：固定 PDFium 下载、SHA-256 校验、发布 stage，及真实
   PDF 的 bind/extract smoke test。
2. **持久导入**：materialize Resource、内容哈希、immutable source、revision/job
   状态及页级原生文字；断开上传连接后 job 仍可完成。
3. **OCR 与渲染**：仅 fallback 页面渲染；覆盖扫描件、密码、超限与 worker 崩溃重试。
4. **知识库**：结构化 chunk、FTS/vector 的原子发布、带 source span 的检索与 citation。
5. **体验**：Desktop 受控预览 URL、进度订阅、引用跳页；后续再考虑坐标高亮。

每一阶段都需要：固定版本 fixture、损坏/密码/空白扫描页 fixture、重试与取消测试，
以及验证未 ready revision 永远不会出现在检索结果中的集成测试。

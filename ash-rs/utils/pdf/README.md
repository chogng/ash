# `ash-pdf`

> 本 README 解释当前 PDFium binding 与 page-text extraction。PDF ingestion、OCR、chunk、
> retrieval 与 citation 的系统方向见 [`docs/pdf.md`](../../../docs/pdf.md)。

`ash-pdf` 是 native PDF parsing boundary。它从 release-staged PDFium 动态库建立 process-local
binding，并按源文档顺序返回每页原生文字与一基页码。

当前 crate 不实现 page rendering、OCR、document identity、持久化、chunk、embedding、retrieval
或 Agent memory。

## 公共契约

| Symbol | 职责 | 关键语义 |
| --- | --- | --- |
| `PdfiumRuntime` | 保存 exact bundled library path | 不搜索系统 library path |
| `PdfiumRuntime::from_bundled_root` | root → platform-specific library path | root 应为 `resources/native/pdfium` |
| `PdfiumRuntime::library_path` | 供 composition/preflight 检查 exact path | path 不是 document source |
| `PdfTextExtractor::bind` | 检查 file 并绑定 PDFium | 启动时创建、跨 extraction 复用 |
| `PdfTextExtractor::extract_file` | local PDF → ordered page text | 不持久化、不 OCR、不跳过 blank page |
| `ExtractedPdfDocument` | ordered `pages` | `page_count()` 等于 vector length |
| `ExtractedPdfPage` | `page_number + text` | page number 永远一基 |
| `DocumentError` | missing bundled library 或 PDFium failure | caller 决定 external error redaction |

`PdfTextExtractor` 持有 `pdfium_render::Pdfium`，但 PDFium handle/page/document types 不进入 public
result。上层只依赖 owned Rust values。

## 内置运行时布局

`platform_library_relative_path` 当前固定：

```text
macOS    lib/libpdfium.dylib
Windows  bin/pdfium.dll
Linux    lib/libpdfium.so
other    unsupported-platform
```

Release build 先 stage runtime：

```text
uv run --frozen --project scripts python -B build/ash_rs/pdfium.py --target darwin-arm64 \
  --output "$STAGING/resources/native/pdfium"
```

Composition root 显式绑定：

```rust
let runtime =
    PdfiumRuntime::from_bundled_root(resources_root.join("native/pdfium"));
let extractor = PdfTextExtractor::bind(runtime)?;
```

`bind` 先用 `Path::is_file` 检查 exact library path，再调用
`Pdfium::bind_to_library`。它不会 fallback 到 system-installed PDFium 或 ambient dynamic-library
search path。Unsupported platform 当前也只会得到 missing-library error，没有独立
UnsupportedPlatform variant。

## 内部接口地图与调用图

| Symbol | 可见性 | 当前职责 | 方向约束 |
| --- | --- | --- | --- |
| `PdfTextExtractor::pdfium` | private field | process-local native binding | 不把 binding handle 交给 caller |
| `platform_library_relative_path` | private function | compile-target → staged relative path | 与 fetch/staging layout lockstep |
| page `enumerate` conversion | private path | zero-based PDFium index → one-based `u32` | conversion 只在 native boundary 出现 |

```text
PdfiumRuntime::from_bundled_root(root)
└─ root.join(platform_library_relative_path())

PdfTextExtractor::bind(runtime)
├─ runtime.library_path.is_file
├─ Pdfium::bind_to_library(exact path)
└─ Pdfium::new(bindings)

PdfTextExtractor::extract_file(path)
├─ Pdfium::load_pdf_from_file(path, password=None)
├─ document.pages().iter().enumerate()
│  ├─ page_number = index + 1
│  └─ page.text()?.all()
└─ ExtractedPdfDocument { pages }
```

Page count 超过 `u32::MAX` 时，一基页码 conversion 会 panic；这被视为超出当前支持范围，而不是
可恢复 `DocumentError`。

## 输入、输出与失败

`extract_file` 接受 caller 提供的 filesystem path，并以 `None` password 打开。它不会先复制文件、
验证 ownership、限制大小、设置 deadline 或 sandbox PDFium。调用方必须确保 source 是
application-owned immutable file，并在更高层处理 untrusted document isolation、resource limit 与
cancellation。

Blank/image-only page 会保留为 `ExtractedPdfPage { text: "" }`，使上层明确决定是否进入 OCR。
不要在本 crate 静默删除空页，否则 citation page number 会与源 PDF 漂移。

`DocumentError::PdfiumLibraryMissing` 的 Display 包含 library path，`DocumentError::Pdfium` 委托
PDFium error display。它们是 diagnostic error，不保证适合直接暴露给 external client。

## 方向偏差检查

- 使用 `Pdfium::bind_to_system_library` 或 ambient search：release runtime 不再 reproducible；
- 每个 document 重新 `bind`：native lifecycle 与 composition ownership 漂移；
- 返回 zero-based page index：citation/viewer contract 被破坏；
- 过滤 blank page：源页码不再稳定；
- Public API 暴露 PDFium page/handle：native backend 泄漏；
- Crate 开始写 document DB、chunk 或 vector index：ingestion domain 下沉到 utility；
- 把 future rendering/OCR 写成当前能力：实现状态失真。

修改 staging layout 时同步检查 `platform_library_relative_path`、fetch script、runtime lock、release
packaging 和 layout test。修改 page result 时同步检查 ingestion/citation consumer 与 native smoke
test。

## 测试、限制与演进

```text
cargo test -p ash-pdf
bazel test //ash-rs/utils/pdf:document-unit-tests
```

普通 tests 不加载 native library，只验证 platform staging path 与 missing-library preflight。
Opt-in smoke test 需要：

```text
ASH_PDFIUM_ROOT="$STAGING/resources/native/pdfium" \
ASH_PDFIUM_TEST_DOCUMENT=/absolute/path/to/fixture.pdf \
cargo test -p ash-pdf
```

如果任一 env 缺失，native extraction test 会直接 skip。CI 若要宣称 native extraction 可用，必须
显式提供两者并检查至少一页包含文字。

当前只有 synchronous native text extraction。Page rendering、password input、structured error、
page geometry、OCR hook、bounded execution 与 isolation 都是潜在扩展；它们应保持 native facts
与 document-library orchestration 分离。

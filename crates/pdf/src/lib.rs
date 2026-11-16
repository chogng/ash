//! aspdf's native PDF domain. PDFium is loaded only in an expendable helper process.

mod annotations;
mod engine;
mod service;
mod worker;

pub use ash_pdf_contract::PdfAnnotation;
pub use ash_pdf_contract::PdfAnnotationEdit;
pub use ash_pdf_contract::PdfCharacter;
pub use ash_pdf_contract::PdfPage;
pub use ash_pdf_contract::PdfPoint;
pub use ash_pdf_contract::PdfRect;
pub use service::PdfService;

use serde::Deserialize;
use serde::Serialize;

pub const WORKER_ARGUMENT: &str = "--ash-pdf-worker";
pub const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 192 * 1024;

#[derive(Debug)]
pub enum PdfError {
    Invalid,
    NotFound,
    Conflict,
    Capacity,
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(message) => f.write_str(message),
            error => write!(f, "PDF operation failed: {error:?}"),
        }
    }
}

impl std::error::Error for PdfError {}

/// Selects whether an Agent needs visual evidence or text and annotations only.
#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum PdfOutput {
    Text,
    Image,
}

#[derive(Deserialize, Serialize)]
struct EngineRequest {
    source: std::path::PathBuf,
    image: std::path::PathBuf,
    modified: Option<std::path::PathBuf>,
    page: u32,
    dimension: u32,
    output: PdfOutput,
    edit: Option<PdfAnnotationEdit>,
}

#[derive(Deserialize, Serialize)]
struct EngineResult {
    page: PdfPage,
}

/// Keeps one PDFium document in an expendable helper. The parent owns timeouts,
/// cancellation and the private directory; binary artifacts never cross JSON pipes.
pub fn run_worker() -> Result<(), String> {
    engine::serve()
}

#[cfg(test)]
#[path = "pdf_tests.rs"]
mod tests;

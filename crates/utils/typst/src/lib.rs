//! Sandboxed in-memory Typst-to-PDF compilation.

mod compiler;

pub use compiler::{
    MAX_TYPST_SOURCE_BYTES, TypstCompileError, TypstCompileOutcome, TypstCompileSuccess,
    TypstCompiler, TypstDiagnostic, TypstDiagnosticSeverity, TypstSourceRange,
};

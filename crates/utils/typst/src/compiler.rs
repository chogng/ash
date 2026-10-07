use std::fmt;

use typst::World;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, WorldExt};
use typst_pdf::PdfOptions;

/// Maximum UTF-8 source size accepted by the compiler boundary.
pub const MAX_TYPST_SOURCE_BYTES: usize = 1024 * 1024;

/// Reusable compiler state containing Typst's standard library and bundled fonts.
pub struct TypstCompiler {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
}

/// Successful Typst compilation output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TypstCompileSuccess {
    pub pdf: Vec<u8>,
    pub warnings: Vec<TypstDiagnostic>,
}

/// A completed compilation, including expected source-level failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TypstCompileOutcome {
    Success(TypstCompileSuccess),
    Failed { diagnostics: Vec<TypstDiagnostic> },
}

/// A stable, renderer-safe Typst diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TypstDiagnostic {
    pub severity: TypstDiagnosticSeverity,
    pub message: String,
    pub hints: Vec<String>,
    pub range: Option<TypstSourceRange>,
}

/// Diagnostic severity independent of Typst's internal enum.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TypstDiagnosticSeverity {
    Error,
    Warning,
}

/// Half-open UTF-8 byte offsets into the submitted source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TypstSourceRange {
    pub start: usize,
    pub end: usize,
}

/// Failure to accept or run a compilation request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TypstCompileError {
    SourceTooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
}

impl TypstCompiler {
    /// Builds reusable compiler state from Typst's bundled, redistribution-safe fonts.
    pub fn new() -> Self {
        let fonts = typst_assets::fonts()
            .flat_map(|bytes| Font::iter(Bytes::new(bytes)))
            .collect::<Vec<_>>();
        let book = FontBook::from_fonts(fonts.iter());
        Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            fonts,
        }
    }

    /// Compiles one in-memory source document without host file, package, network, or date access.
    pub fn compile(&self, source: &str) -> Result<TypstCompileOutcome, TypstCompileError> {
        let actual_bytes = source.len();
        if actual_bytes > MAX_TYPST_SOURCE_BYTES {
            return Err(TypstCompileError::SourceTooLarge {
                actual_bytes,
                max_bytes: MAX_TYPST_SOURCE_BYTES,
            });
        }

        let world = InMemoryWorld::new(self, source);
        let compiled = typst::compile(&world);
        let warnings = map_diagnostics(&world, compiled.warnings);
        let document = match compiled.output {
            Ok(document) => document,
            Err(errors) => {
                let mut diagnostics = warnings;
                diagnostics.extend(map_diagnostics(&world, errors));
                return Ok(TypstCompileOutcome::Failed { diagnostics });
            }
        };

        match typst_pdf::pdf(&document, &PdfOptions::default()) {
            Ok(pdf) => Ok(TypstCompileOutcome::Success(TypstCompileSuccess {
                pdf,
                warnings,
            })),
            Err(errors) => {
                let mut diagnostics = warnings;
                diagnostics.extend(map_diagnostics(&world, errors));
                Ok(TypstCompileOutcome::Failed { diagnostics })
            }
        }
    }
}

impl Default for TypstCompiler {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for TypstCompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "Typst source is {actual_bytes} bytes; the limit is {max_bytes} bytes"
            ),
        }
    }
}

impl std::error::Error for TypstCompileError {}

struct InMemoryWorld<'a> {
    compiler: &'a TypstCompiler,
    main_id: FileId,
    source: Source,
    source_bytes: Bytes,
}

impl<'a> InMemoryWorld<'a> {
    fn new(compiler: &'a TypstCompiler, text: &str) -> Self {
        let main_id = RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("/main.typ").expect("static Typst main path must be valid"),
        )
        .intern();
        Self {
            compiler,
            main_id,
            source: Source::new(main_id, text.to_owned()),
            source_bytes: Bytes::from_string(text.to_owned()),
        }
    }
}

impl World for InMemoryWorld<'_> {
    fn library(&self) -> &LazyHash<Library> {
        &self.compiler.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.compiler.book
    }

    fn main(&self) -> FileId {
        self.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main_id {
            Ok(self.source.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main_id {
            Ok(self.source_bytes.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.compiler.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

fn map_diagnostics(
    world: &InMemoryWorld<'_>,
    values: impl IntoIterator<Item = SourceDiagnostic>,
) -> Vec<TypstDiagnostic> {
    values
        .into_iter()
        .map(|diagnostic| TypstDiagnostic {
            severity: match diagnostic.severity {
                Severity::Error => TypstDiagnosticSeverity::Error,
                Severity::Warning => TypstDiagnosticSeverity::Warning,
            },
            message: diagnostic.message.to_string(),
            hints: diagnostic
                .hints
                .into_iter()
                .map(|hint| hint.v.to_string())
                .collect(),
            range: world.range(diagnostic.span).map(|range| TypstSourceRange {
                start: range.start,
                end: range.end,
            }),
        })
        .collect()
}

#[cfg(test)]
#[path = "compiler_tests.rs"]
mod tests;

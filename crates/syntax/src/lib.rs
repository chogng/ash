//! Incremental, presentation-independent source syntax analysis.

#[cfg(ash_desktop_native_grammars)]
#[allow(unsafe_code)]
mod desktop_grammars;
mod document;
mod error;
mod language;
mod snapshot;

pub use document::{
    DocumentRevision, EditorBracket, EditorDiagnostic, EditorFacts, EditorFactsDelta,
    EditorFactsSplice, EditorFold, EditorRow, EditorSymbol, EditorToken, SyntaxDocument,
    SyntaxEdit,
};
pub use error::SyntaxError;
pub use language::SyntaxLanguage;
pub use snapshot::{
    AnalysisLimits, DocumentSymbol, DocumentSymbolKind, FoldingRange, SelectionRange,
    SyntaxDiagnostic, SyntaxDiagnosticKind, SyntaxPoint, SyntaxRange, SyntaxSnapshot, SyntaxToken,
    SyntaxTokenKind,
};

/// Identity of the persisted syntax-fact contract consumed by rebuildable projections.
///
/// Grammar or structural-query changes that can alter document symbols, folding ranges, or other
/// stored facts must change this value so consumers do not reuse incompatible projections.
pub const SYNTAX_FACTS_VERSION: &str = "ash-syntax-facts-v2";

/// Binds the process's Desktop grammar acquisitions to its verified product and profile.
pub fn install_native_grammar_resolver(
    resolver: impl Fn(&str) -> Result<(), String> + Send + Sync + 'static,
) {
    #[cfg(ash_desktop_native_grammars)]
    desktop_grammars::install_resolver(Box::new(resolver));
    #[cfg(not(ash_desktop_native_grammars))]
    let _ = resolver;
}

/// Registers a verified product grammar and keeps the downloaded generation alive for the process.
pub fn load_native_grammar(
    grammar: &str,
    path: &std::path::Path,
    lease: impl Send + Sync + 'static,
) -> Result<(), String> {
    #[cfg(ash_desktop_native_grammars)]
    return desktop_grammars::load(grammar, path, lease);
    #[cfg(not(ash_desktop_native_grammars))]
    {
        let _ = (grammar, path, lease);
        Err("This build uses linked native grammars".into())
    }
}

#[cfg(test)]
#[path = "syntax_tests.rs"]
mod tests;

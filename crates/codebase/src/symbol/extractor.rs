use crate::IndexedLanguage;
use crate::MaterializedSource;
use ash_syntax::AnalysisLimits;
use ash_syntax::DocumentRevision;
use ash_syntax::DocumentSymbolKind;
use ash_syntax::SyntaxDocument;
use ash_syntax::SyntaxLanguage;
use ash_syntax::SyntaxRange;

use crate::IndexedSymbol;
use crate::SymbolIndexError;
use crate::SymbolKind;
use crate::SymbolRange;
use crate::SymbolReference;

pub(crate) struct ExtractedSource {
    pub symbols: Vec<IndexedSymbol>,
    pub symbol_limit_hit: bool,
}

pub(crate) fn extract_source(
    source: &MaterializedSource,
    max_symbols: usize,
) -> Result<ExtractedSource, SymbolIndexError> {
    let Some(language) = syntax_language(source.reference.language) else {
        return Ok(ExtractedSource {
            symbols: Vec::new(),
            symbol_limit_hit: false,
        });
    };
    let requested_symbols = max_symbols.saturating_add(1);
    let document = SyntaxDocument::open_with_limits(
        language,
        DocumentRevision::new(1),
        &source.content,
        AnalysisLimits {
            max_document_bytes: source.content.len().max(1),
            max_tokens: 0,
            max_folding_ranges: 0,
            max_selection_ranges: 0,
            max_symbols: requested_symbols,
            max_diagnostics: 0,
        },
    )
    .map_err(|syntax| SymbolIndexError::Syntax {
        path: source.reference.relative_path.clone(),
        source: syntax,
    })?;
    let snapshot = document.snapshot();
    let symbol_limit_hit = snapshot.symbols().len() > max_symbols;
    let symbols = snapshot
        .symbols()
        .iter()
        .take(max_symbols)
        .enumerate()
        .map(|(ordinal, symbol)| IndexedSymbol {
            reference: SymbolReference {
                root_id: source.reference.root_id.clone(),
                relative_path: source.reference.relative_path.clone(),
                source_revision: source.reference.source_revision.clone(),
                language: source.reference.language,
                source_bytes: source.reference.source_bytes,
                ordinal,
                declaration_range: symbol_range(&symbol.range),
                selection_range: symbol_range(&symbol.selection_range),
            },
            name: symbol.name.clone(),
            kind: symbol_kind(symbol.kind),
            container_name: None,
        })
        .collect();
    Ok(ExtractedSource {
        symbols,
        symbol_limit_hit,
    })
}

fn syntax_language(language: IndexedLanguage) -> Option<SyntaxLanguage> {
    match language {
        IndexedLanguage::Javascript => Some(SyntaxLanguage::Javascript),
        IndexedLanguage::JavascriptReact => Some(SyntaxLanguage::Javascriptreact),
        IndexedLanguage::Json => Some(SyntaxLanguage::Json),
        IndexedLanguage::Jsonc => Some(SyntaxLanguage::Jsonc),
        IndexedLanguage::Rust => Some(SyntaxLanguage::Rust),
        IndexedLanguage::Shell => Some(SyntaxLanguage::Shell),
        IndexedLanguage::TypeScript => Some(SyntaxLanguage::Typescript),
        IndexedLanguage::TypeScriptReact => Some(SyntaxLanguage::Typescriptreact),
        IndexedLanguage::PlainText => None,
    }
}

fn symbol_range(range: &SyntaxRange) -> SymbolRange {
    SymbolRange {
        start_byte: range.bytes.start,
        end_byte: range.bytes.end,
        start_line: range.start.row,
        start_column: range.start.column,
        end_line: range.end.row,
        end_column: range.end.column,
    }
}

fn symbol_kind(kind: DocumentSymbolKind) -> SymbolKind {
    match kind {
        DocumentSymbolKind::Constant => SymbolKind::Constant,
        DocumentSymbolKind::Enum => SymbolKind::Enum,
        DocumentSymbolKind::Field => SymbolKind::Field,
        DocumentSymbolKind::Function => SymbolKind::Function,
        DocumentSymbolKind::Macro => SymbolKind::Macro,
        DocumentSymbolKind::Method => SymbolKind::Method,
        DocumentSymbolKind::Module => SymbolKind::Module,
        DocumentSymbolKind::Static => SymbolKind::Static,
        DocumentSymbolKind::Struct => SymbolKind::Struct,
        DocumentSymbolKind::Trait => SymbolKind::Trait,
        DocumentSymbolKind::Type => SymbolKind::Type,
        DocumentSymbolKind::Variable => SymbolKind::Variable,
    }
}

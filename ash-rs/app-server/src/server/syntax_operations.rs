use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeParams;
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeResult;
use ash_app_server_protocol::protocol::syntax::SyntaxDiagnosticDto;
use ash_app_server_protocol::protocol::syntax::SyntaxDiagnosticKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxFoldingRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::syntax::SyntaxPositionDto;
use ash_app_server_protocol::protocol::syntax::SyntaxRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSelectionRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSelectionRangesParams;
use ash_app_server_protocol::protocol::syntax::SyntaxSelectionRangesResult;
use ash_app_server_protocol::protocol::syntax::SyntaxSymbolDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSymbolKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxTokenDto;
use ash_app_server_protocol::protocol::syntax::SyntaxTokenKindDto;
use ash_syntax::DocumentRevision;
use ash_syntax::DocumentSymbolKind;
use ash_syntax::SyntaxDiagnosticKind;
use ash_syntax::SyntaxDocument;
use ash_syntax::SyntaxError;
use ash_syntax::SyntaxLanguage;
use ash_syntax::SyntaxRange;
use ash_syntax::SyntaxSnapshot;
use ash_syntax::SyntaxTokenKind;
use serde_json::Value;

impl AppServer {
    pub(super) fn syntax_analyze(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SyntaxAnalyzeParams = decode(params)?;
        let document = SyntaxDocument::open(
            syntax_language(params.language),
            DocumentRevision::new(params.revision),
            &params.text,
        )
        .map_err(syntax_error)?;
        result(&project(&params.text, document.snapshot()))
    }

    pub(super) fn syntax_selection_ranges(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SyntaxSelectionRangesParams = decode(params)?;
        let document = SyntaxDocument::open(
            syntax_language(params.language),
            DocumentRevision::new(params.revision),
            &params.text,
        )
        .map_err(syntax_error)?;
        let mut ranges = Vec::new();
        for requested in params.ranges {
            let requested = byte_range_for_utf16(&params.text, requested)
                .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
            ranges.extend(document.selection_ranges(requested).map_err(syntax_error)?);
        }
        ranges.sort_by_key(|selection| {
            (
                selection.range.bytes.start,
                std::cmp::Reverse(selection.range.bytes.end),
            )
        });
        ranges.dedup_by(|left, right| left.range.bytes == right.range.bytes);
        let positions = Utf16PositionIndex::for_selection_ranges(&params.text, &ranges);
        result(&SyntaxSelectionRangesResult {
            revision: params.revision,
            ranges: ranges
                .iter()
                .map(|selection| SyntaxSelectionRangeDto {
                    range: positions.project_range(&selection.range),
                })
                .collect(),
        })
    }
}

fn syntax_language(language: SyntaxLanguageDto) -> SyntaxLanguage {
    match language {
        SyntaxLanguageDto::Javascript => SyntaxLanguage::Javascript,
        SyntaxLanguageDto::Javascriptreact => SyntaxLanguage::Javascriptreact,
        SyntaxLanguageDto::Json => SyntaxLanguage::Json,
        SyntaxLanguageDto::Jsonc => SyntaxLanguage::Jsonc,
        SyntaxLanguageDto::Rust => SyntaxLanguage::Rust,
        SyntaxLanguageDto::Shell => SyntaxLanguage::Shell,
        SyntaxLanguageDto::Typescript => SyntaxLanguage::Typescript,
        SyntaxLanguageDto::Typescriptreact => SyntaxLanguage::Typescriptreact,
    }
}

fn project(text: &str, snapshot: SyntaxSnapshot) -> SyntaxAnalyzeResult {
    let positions = Utf16PositionIndex::for_snapshot(text, &snapshot);
    SyntaxAnalyzeResult {
        revision: snapshot.revision().value(),
        has_errors: snapshot.has_errors(),
        tokens: snapshot
            .tokens()
            .iter()
            .map(|token| SyntaxTokenDto {
                range: positions.project_range(&token.range),
                kind: token_kind(token.kind),
            })
            .collect(),
        folding_ranges: snapshot
            .folding_ranges()
            .iter()
            .map(|fold| SyntaxFoldingRangeDto {
                range: positions.project_range(&fold.range),
            })
            .collect(),
        symbols: snapshot
            .symbols()
            .iter()
            .map(|symbol| SyntaxSymbolDto {
                name: symbol.name.clone(),
                kind: symbol_kind(symbol.kind),
                range: positions.project_range(&symbol.range),
                selection_range: positions.project_range(&symbol.selection_range),
            })
            .collect(),
        diagnostics: snapshot
            .diagnostics()
            .iter()
            .map(|diagnostic| SyntaxDiagnosticDto {
                range: positions.project_range(&diagnostic.range),
                kind: diagnostic_kind(diagnostic.kind),
            })
            .collect(),
    }
}

fn token_kind(kind: SyntaxTokenKind) -> SyntaxTokenKindDto {
    match kind {
        SyntaxTokenKind::Attribute => SyntaxTokenKindDto::Attribute,
        SyntaxTokenKind::Comment => SyntaxTokenKindDto::Comment,
        SyntaxTokenKind::Constant => SyntaxTokenKindDto::Constant,
        SyntaxTokenKind::Constructor => SyntaxTokenKindDto::Constructor,
        SyntaxTokenKind::Embedded => SyntaxTokenKindDto::Embedded,
        SyntaxTokenKind::Function => SyntaxTokenKindDto::Function,
        SyntaxTokenKind::Keyword => SyntaxTokenKindDto::Keyword,
        SyntaxTokenKind::Label => SyntaxTokenKindDto::Label,
        SyntaxTokenKind::Module => SyntaxTokenKindDto::Module,
        SyntaxTokenKind::Number => SyntaxTokenKindDto::Number,
        SyntaxTokenKind::Operator => SyntaxTokenKindDto::Operator,
        SyntaxTokenKind::Property => SyntaxTokenKindDto::Property,
        SyntaxTokenKind::Punctuation => SyntaxTokenKindDto::Punctuation,
        SyntaxTokenKind::String => SyntaxTokenKindDto::String,
        SyntaxTokenKind::Type => SyntaxTokenKindDto::Type,
        SyntaxTokenKind::Variable => SyntaxTokenKindDto::Variable,
    }
}

fn symbol_kind(kind: DocumentSymbolKind) -> SyntaxSymbolKindDto {
    match kind {
        DocumentSymbolKind::Constant => SyntaxSymbolKindDto::Constant,
        DocumentSymbolKind::Enum => SyntaxSymbolKindDto::Enum,
        DocumentSymbolKind::Field => SyntaxSymbolKindDto::Field,
        DocumentSymbolKind::Function => SyntaxSymbolKindDto::Function,
        DocumentSymbolKind::Macro => SyntaxSymbolKindDto::Macro,
        DocumentSymbolKind::Method => SyntaxSymbolKindDto::Method,
        DocumentSymbolKind::Module => SyntaxSymbolKindDto::Module,
        DocumentSymbolKind::Static => SyntaxSymbolKindDto::Static,
        DocumentSymbolKind::Struct => SyntaxSymbolKindDto::Struct,
        DocumentSymbolKind::Trait => SyntaxSymbolKindDto::Trait,
        DocumentSymbolKind::Type => SyntaxSymbolKindDto::Type,
        DocumentSymbolKind::Variable => SyntaxSymbolKindDto::Variable,
    }
}

fn diagnostic_kind(kind: SyntaxDiagnosticKind) -> SyntaxDiagnosticKindDto {
    match kind {
        SyntaxDiagnosticKind::Error => SyntaxDiagnosticKindDto::Error,
        SyntaxDiagnosticKind::Missing => SyntaxDiagnosticKindDto::Missing,
    }
}

fn syntax_error(error: SyntaxError) -> RpcError {
    match error {
        SyntaxError::DocumentTooLarge { .. } => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        SyntaxError::Language { .. }
        | SyntaxError::Query { .. }
        | SyntaxError::ParseCancelled
        | SyntaxError::NonIncreasingRevision { .. }
        | SyntaxError::InvalidEditRange { .. }
        | SyntaxError::InvalidEditBoundary { .. }
        | SyntaxError::InvalidSelectionRange { .. }
        | SyntaxError::InvalidSelectionBoundary { .. }
        | SyntaxError::OverlappingEdits => {
            RpcError::new(-32071, AppServerErrorName::SyntaxAnalysisFailed)
        }
    }
}

struct Utf16PositionIndex {
    byte_offsets: Vec<usize>,
    positions: Vec<SyntaxPositionDto>,
}

impl Utf16PositionIndex {
    fn for_snapshot(text: &str, snapshot: &SyntaxSnapshot) -> Self {
        let mut byte_offsets = Vec::with_capacity(
            snapshot.tokens().len() * 2
                + snapshot.folding_ranges().len() * 2
                + snapshot.symbols().len() * 4
                + snapshot.diagnostics().len() * 2,
        );
        for token in snapshot.tokens() {
            push_range_offsets(&mut byte_offsets, &token.range);
        }
        for folding_range in snapshot.folding_ranges() {
            push_range_offsets(&mut byte_offsets, &folding_range.range);
        }
        for symbol in snapshot.symbols() {
            push_range_offsets(&mut byte_offsets, &symbol.range);
            push_range_offsets(&mut byte_offsets, &symbol.selection_range);
        }
        for diagnostic in snapshot.diagnostics() {
            push_range_offsets(&mut byte_offsets, &diagnostic.range);
        }
        Self::for_offsets(text, byte_offsets)
    }

    fn for_selection_ranges(text: &str, ranges: &[ash_syntax::SelectionRange]) -> Self {
        let mut byte_offsets = Vec::with_capacity(ranges.len() * 2);
        for selection in ranges {
            push_range_offsets(&mut byte_offsets, &selection.range);
        }
        Self::for_offsets(text, byte_offsets)
    }

    fn for_offsets(text: &str, mut byte_offsets: Vec<usize>) -> Self {
        byte_offsets.sort_unstable();
        byte_offsets.dedup();

        let mut positions = Vec::with_capacity(byte_offsets.len());
        let mut next_offset = 0;
        let mut line_index = 0;
        let mut column_index = 0;
        for (byte_offset, character) in text.char_indices() {
            while byte_offsets.get(next_offset) == Some(&byte_offset) {
                positions.push(SyntaxPositionDto {
                    line_index,
                    column_index,
                });
                next_offset += 1;
            }
            if character == '\n' {
                line_index += 1;
                column_index = 0;
            } else {
                column_index += character.len_utf16();
            }
        }
        while byte_offsets.get(next_offset) == Some(&text.len()) {
            positions.push(SyntaxPositionDto {
                line_index,
                column_index,
            });
            next_offset += 1;
        }
        assert_eq!(
            next_offset,
            byte_offsets.len(),
            "syntax ranges must contain only UTF-8 boundaries"
        );
        Self {
            byte_offsets,
            positions,
        }
    }

    fn project_range(&self, range: &SyntaxRange) -> SyntaxRangeDto {
        SyntaxRangeDto {
            start: self.position(range.bytes.start),
            end: self.position(range.bytes.end),
        }
    }

    fn position(&self, byte_offset: usize) -> SyntaxPositionDto {
        let index = self
            .byte_offsets
            .binary_search(&byte_offset)
            .expect("syntax range boundary must be indexed");
        self.positions[index]
    }
}

fn byte_range_for_utf16(text: &str, range: SyntaxRangeDto) -> Option<std::ops::Range<usize>> {
    let start = byte_offset_for_utf16(text, range.start)?;
    let end = byte_offset_for_utf16(text, range.end)?;
    (start <= end).then_some(start..end)
}

fn byte_offset_for_utf16(text: &str, requested: SyntaxPositionDto) -> Option<usize> {
    let mut line_index = 0;
    let mut column_index = 0;
    for (byte_offset, character) in text.char_indices() {
        if line_index == requested.line_index && column_index == requested.column_index {
            return Some(byte_offset);
        }
        if character == '\n' {
            if line_index == requested.line_index {
                return None;
            }
            line_index += 1;
            column_index = 0;
            continue;
        }
        let next_column = column_index + character.len_utf16();
        if line_index == requested.line_index && requested.column_index < next_column {
            return None;
        }
        column_index = next_column;
    }
    (line_index == requested.line_index && column_index == requested.column_index)
        .then_some(text.len())
}

fn push_range_offsets(offsets: &mut Vec<usize>, range: &SyntaxRange) {
    offsets.push(range.bytes.start);
    offsets.push(range.bytes.end);
}

#[cfg(test)]
#[path = "syntax_operations_tests.rs"]
mod tests;

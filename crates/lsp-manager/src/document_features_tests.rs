use std::path::PathBuf;

use ash_lsp::lsp_types::Color;
use ash_lsp::lsp_types::ColorInformation;
use ash_lsp::lsp_types::DocumentSymbol;
use ash_lsp::lsp_types::DocumentSymbolResponse;
use ash_lsp::lsp_types::FoldingRange;
use ash_lsp::lsp_types::FoldingRangeKind;
use ash_lsp::lsp_types::Position;
use ash_lsp::lsp_types::PositionEncodingKind;
use ash_lsp::lsp_types::Range;
use ash_lsp::lsp_types::SymbolKind;

use super::LanguageFoldingRangeKind;
use super::project_document_colors;
use super::project_document_symbols;
use super::project_folding_ranges;
use crate::LanguageDocumentRevision;
use crate::LanguageRequestId;

#[test]
#[allow(deprecated)]
fn projects_nested_utf16_symbols_and_bounded_colors() {
    let text = "fn 变量() {\n  1\n}";
    let uri = "file:///workspace/main.rs".parse().expect("uri");
    let symbols = project_document_symbols(
        LanguageRequestId::new(1),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(7),
        text,
        &uri,
        &PositionEncodingKind::UTF16,
        Some(DocumentSymbolResponse::Nested(vec![DocumentSymbol {
            name: "变量".into(),
            detail: Some("function".into()),
            kind: SymbolKind::FUNCTION,
            tags: None,
            deprecated: None,
            range: Range::new(Position::new(0, 0), Position::new(2, 1)),
            selection_range: Range::new(Position::new(0, 3), Position::new(0, 5)),
            children: None,
        }])),
    );
    assert_eq!(symbols.symbols[0].selection_range.byte_range(), 3..9);

    let colors = project_document_colors(
        LanguageRequestId::new(2),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(7),
        text,
        &PositionEncodingKind::UTF16,
        vec![
            ColorInformation {
                range: Range::new(Position::new(1, 2), Position::new(1, 3)),
                color: Color {
                    red: 1.0,
                    green: 0.5,
                    blue: 0.0,
                    alpha: 1.0,
                },
            },
            ColorInformation {
                range: Range::new(Position::new(1, 2), Position::new(1, 3)),
                color: Color {
                    red: 2.0,
                    green: 0.0,
                    blue: 0.0,
                    alpha: 1.0,
                },
            },
        ],
    );
    assert_eq!(colors.colors.len(), 1);
    assert_eq!(colors.colors[0].color.green, 128);
}

#[test]
fn folding_projection_keeps_only_valid_complete_line_ranges() {
    let ranges = project_folding_ranges(
        LanguageRequestId::new(1),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(1),
        "a\nb\nc",
        vec![
            FoldingRange {
                start_line: 0,
                end_line: 2,
                kind: Some(FoldingRangeKind::Region),
                collapsed_text: Some("body".into()),
                ..Default::default()
            },
            FoldingRange {
                start_line: 2,
                end_line: 2,
                ..Default::default()
            },
        ],
    );
    assert_eq!(ranges.ranges.len(), 1);
    assert_eq!(
        ranges.ranges[0].kind,
        Some(LanguageFoldingRangeKind::Region)
    );
}

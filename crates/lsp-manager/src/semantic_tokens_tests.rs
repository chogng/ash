use std::path::PathBuf;

use ash_lsp::lsp_types::PositionEncodingKind;
use ash_lsp::lsp_types::SemanticToken;
use ash_lsp::lsp_types::SemanticTokenModifier;
use ash_lsp::lsp_types::SemanticTokenType;
use ash_lsp::lsp_types::SemanticTokens;
use ash_lsp::lsp_types::SemanticTokensFullOptions;
use ash_lsp::lsp_types::SemanticTokensLegend;
use ash_lsp::lsp_types::SemanticTokensOptions;
use ash_lsp::lsp_types::SemanticTokensResult;
use ash_lsp::lsp_types::WorkDoneProgressOptions;

use super::*;

#[test]
fn projects_relative_utf16_tokens_through_the_negotiated_legend() {
    let result = project_semantic_tokens(
        LanguageRequestId::new(7),
        PathBuf::from("src/main.rs"),
        LanguageDocumentRevision::new(3),
        "let 变量 = 1;",
        &PositionEncodingKind::UTF16,
        &options(),
        Some(SemanticTokensResult::Tokens(SemanticTokens {
            result_id: Some("result-1".into()),
            data: vec![
                SemanticToken {
                    delta_line: 0,
                    delta_start: 0,
                    length: 3,
                    token_type: 0,
                    token_modifiers_bitset: 0,
                },
                SemanticToken {
                    delta_line: 0,
                    delta_start: 4,
                    length: 2,
                    token_type: 1,
                    token_modifiers_bitset: 1,
                },
                SemanticToken {
                    delta_line: 0,
                    delta_start: 5,
                    length: 1,
                    token_type: 2,
                    token_modifiers_bitset: 0,
                },
            ],
        })),
    )
    .expect("semantic tokens");

    assert_eq!(result.result_id.as_deref(), Some("result-1"));
    assert_eq!(result.tokens[0].range.byte_range(), 0..3);
    assert_eq!(result.tokens[0].token_type, "keyword");
    assert_eq!(result.tokens[1].range.byte_range(), 4..10);
    assert_eq!(result.tokens[1].token_type, "variable");
    assert_eq!(result.tokens[1].modifiers, ["declaration"]);
    assert_eq!(result.tokens[2].range.byte_range(), 13..14);
    assert_eq!(result.tokens[2].token_type, "number");
}

#[test]
fn rejects_tokens_outside_the_legend_or_snapshot() {
    let error = project_semantic_tokens(
        LanguageRequestId::new(1),
        PathBuf::from("src/main.rs"),
        LanguageDocumentRevision::new(1),
        "x",
        &PositionEncodingKind::UTF8,
        &options(),
        Some(SemanticTokensResult::Tokens(SemanticTokens {
            result_id: None,
            data: vec![SemanticToken {
                delta_line: 0,
                delta_start: 0,
                length: 1,
                token_type: 99,
                token_modifiers_bitset: 0,
            }],
        })),
    )
    .expect_err("unknown legend entry");
    assert!(error.contains("legend"));
}

fn options() -> SemanticTokensOptions {
    SemanticTokensOptions {
        work_done_progress_options: WorkDoneProgressOptions::default(),
        legend: SemanticTokensLegend {
            token_types: vec![
                SemanticTokenType::KEYWORD,
                SemanticTokenType::VARIABLE,
                SemanticTokenType::NUMBER,
            ],
            token_modifiers: vec![SemanticTokenModifier::DECLARATION],
        },
        range: Some(false),
        full: Some(SemanticTokensFullOptions::Bool(true)),
    }
}

use std::path::PathBuf;

use ash_app_server_protocol::protocol::language::LanguageCodeActionDiagnosticDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionInsertTextFormatDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionItemDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionItemKindDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionsResult;
use ash_app_server_protocol::protocol::language::LanguageDiagnosticSeverityDto;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;
use ash_app_server_protocol::protocol::language::LanguageRangeDto;
use ash_lsp_manager::LanguageDocumentPosition;

use super::project_completions;
use super::project_diagnostics;
use super::protocol_position;

#[test]
fn remote_request_positions_convert_editor_bytes_to_utf16() {
    let text = "let 😀value = 1;\n";

    let position = protocol_position(text, LanguageDocumentPosition::new(0, 8)).unwrap();

    assert_eq!(position.line_index, 0);
    assert_eq!(position.column_index, 6);
    assert!(protocol_position(text, LanguageDocumentPosition::new(0, 6)).is_none());
}

#[test]
fn remote_completion_and_diagnostic_ranges_project_back_to_utf8_bytes() {
    let text = "let 😀value = 1;\n";
    let range = LanguageRangeDto {
        start: LanguagePositionDto {
            line_index: 0,
            column_index: 4,
        },
        end: LanguagePositionDto {
            line_index: 0,
            column_index: 11,
        },
    };
    let completions = project_completions(
        9,
        PathBuf::from("/dir/src/main.rs"),
        text,
        LanguageCompletionsResult {
            revision: 3,
            is_incomplete: false,
            can_resolve: false,
            items: vec![LanguageCompletionItemDto {
                label: "value".into(),
                kind: LanguageCompletionItemKindDto::Variable,
                detail: None,
                documentation: None,
                filter_text: None,
                sort_text: None,
                preselect: None,
                commit_characters: Vec::new(),
                insert_text_format: LanguageCompletionInsertTextFormatDto::PlainText,
                range,
                insert_text: "value".into(),
                additional_text_edits: Vec::new(),
                command: None,
                provider_data: None,
            }],
        },
    )
    .unwrap();
    let diagnostics = project_diagnostics(
        text,
        vec![LanguageCodeActionDiagnosticDto {
            range,
            severity: LanguageDiagnosticSeverityDto::Warning,
            message: "sample".into(),
            code: None,
            source: None,
        }],
    );

    assert_eq!(completions.request_id.value(), 9);
    assert_eq!(
        completions.items[0]
            .edit
            .as_ref()
            .unwrap()
            .range
            .byte_range(),
        4..13
    );
    assert_eq!(diagnostics[0].range.byte_range(), 4..13);
}

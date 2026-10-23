use ash_app_server_protocol::protocol::language::LanguageCompletionInsertTextFormatDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionTriggerKindDto;
use ash_lsp_manager::LanguageCompletionInsertTextFormat;
use ash_lsp_manager::LanguageCompletionItem;
use ash_lsp_manager::LanguageCompletionItemKind;
use ash_lsp_manager::LanguageCompletionTrigger;
use ash_lsp_manager::LanguageTextEdit;
use ash_lsp_manager::LanguageTextRange;

use super::completion_item_to_dto;
use super::completion_trigger;

#[test]
fn empty_document_edit_range_round_trips_through_utf16() {
    let range = super::byte_range_to_utf16("", 0..0).unwrap();
    assert_eq!(super::utf8_byte_range("", range), Some(0..0));
    assert!(
        super::utf8_byte_range(
            "",
            super::LanguageRangeDto {
                start: super::LanguagePositionDto {
                    line_index: 0,
                    column_index: 0
                },
                end: super::LanguagePositionDto {
                    line_index: 0,
                    column_index: 1
                },
            },
        )
        .is_none()
    );
}

#[test]
fn on_type_formatting_processor_rejects_invalid_character_and_position_before_resolving_the_directory()
 {
    let server = crate::tests::server();
    let mut connection = server.connection();
    crate::tests::initialize(&server, &mut connection);
    for (character, column) in [("", 0), (";;", 0), ("\0", 0), (";", 1)] {
        let cancellation = ash_async_utils::CancellationSource::new();
        let error = server.language_processor(connection.connection_id).language_on_type_formatting(
            &serde_json::json!({
                "operationId":"typing", "request":{
                    "document":{"path":"missing.rs", "languageId":"rust", "revision":1, "text":"🦀;"},
                    "position":{"lineIndex":0, "columnIndex":column}, "character":character,
                    "options":{"tabSize":2, "insertSpaces":true, "trimTrailingWhitespace":null}
                }
            }),
            &cancellation.token(),
        ).unwrap_err();
        assert_eq!(error.code, -32072);
        assert_eq!(
            error.message,
            ash_app_server_protocol::protocol::error::AppServerErrorName::LanguageRequestFailed
        );
    }
    server.close_connection(connection);
}

#[test]
fn language_save_rejects_oversized_utf8_content_before_resolving_a_directory() {
    let server = crate::tests::server();
    let mut connection = server.connection();
    crate::tests::initialize(&server, &mut connection);
    let response = crate::tests::call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":2, "method":"language/save",
            "params":{"path":"demo.txt","text":"é".repeat(super::MAX_LANGUAGE_TARGET_BYTES / 2 + 1)}
        }),
    );
    assert_eq!(response["error"]["code"], -32602, "{response}");
    server.close_connection(connection);
}

#[test]
fn completion_item_projection_preserves_utf16_and_snippet_semantics() {
    let item = LanguageCompletionItem {
        label: "println!".into(),
        kind: LanguageCompletionItemKind::Snippet,
        detail: Some("macro".into()),
        documentation: Some("Prints one line".into()),
        filter_text: Some("println".into()),
        sort_text: Some("001".into()),
        preselect: Some(true),
        commit_characters: vec!["(".into()],
        insert_text_format: LanguageCompletionInsertTextFormat::Snippet,
        edit: Some(LanguageTextEdit {
            range: LanguageTextRange::new(4..7),
            new_text: "println!($0)".into(),
        }),
        additional_text_edits: Vec::new(),
        command: None,
        provider_data: serde_json::Value::Null,
    };

    let dto = completion_item_to_dto("🦀pri", item).expect("completion DTO");

    assert_eq!(dto.range.start.column_index, 2);
    assert_eq!(dto.range.end.column_index, 5);
    assert_eq!(
        dto.insert_text_format,
        LanguageCompletionInsertTextFormatDto::Snippet
    );
    assert_eq!(dto.insert_text, "println!($0)");
}

#[test]
fn completion_trigger_rejects_ambiguous_character_shapes() {
    assert!(matches!(
        completion_trigger(LanguageCompletionTriggerKindDto::Invoke, None),
        Ok(LanguageCompletionTrigger::Invoked)
    ));
    assert!(matches!(
        completion_trigger(
            LanguageCompletionTriggerKindDto::TriggerCharacter,
            Some(".")
        ),
        Ok(LanguageCompletionTrigger::TriggerCharacter(character)) if character == "."
    ));
    assert!(completion_trigger(LanguageCompletionTriggerKindDto::Invoke, Some(".")).is_err());
    assert!(
        completion_trigger(
            LanguageCompletionTriggerKindDto::TriggerCharacter,
            Some("ab")
        )
        .is_err()
    );
    assert!(
        completion_trigger(
            LanguageCompletionTriggerKindDto::TriggerCharacter,
            Some("\n")
        )
        .is_err()
    );
}

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

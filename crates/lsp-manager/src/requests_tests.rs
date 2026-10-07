use std::str::FromStr;

use ash_lsp::lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, CodeAction,
    CodeActionKind, CodeActionOrCommand, Command, CompletionItem, CompletionItemKind,
    CompletionResponse, CreateFile, DocumentChangeOperation, DocumentChanges,
    DocumentDiagnosticReport, DocumentDiagnosticReportResult, FullDocumentDiagnosticReport,
    GotoDefinitionResponse, Hover, HoverContents, InlayHint, InlayHintKind, InlayHintLabel,
    InlayHintTooltip, InsertTextFormat, LinkedEditingRanges, Location, MarkedString, OneOf,
    OptionalVersionedTextDocumentIdentifier, ParameterInformation, ParameterLabel,
    PositionEncodingKind, Range, RelatedFullDocumentDiagnosticReport,
    RelatedUnchangedDocumentDiagnosticReport, ResourceOp, SignatureHelp, SignatureInformation,
    SymbolInformation, SymbolKind, TextDocumentEdit, TextEdit, UnchangedDocumentDiagnosticReport,
    Uri, WorkspaceDiagnosticReport, WorkspaceDiagnosticReportResult,
    WorkspaceDocumentDiagnosticReport, WorkspaceEdit, WorkspaceFullDocumentDiagnosticReport,
    WorkspaceSymbolResponse,
};

use super::*;
use crate::workspace_diagnostics::project_workspace_diagnostics;

#[test]
fn request_position_uses_the_negotiated_encoding_without_splitting_unicode() {
    let text = "zero\n🦀rust";
    let position = LanguageDocumentPosition::new(1, "🦀".len() as u32);

    assert_eq!(
        protocol_position(text, position, &PositionEncodingKind::UTF8),
        Some(Position::new(1, 4))
    );
    assert_eq!(
        protocol_position(text, position, &PositionEncodingKind::UTF16),
        Some(Position::new(1, 2))
    );
    assert_eq!(
        protocol_position(
            text,
            LanguageDocumentPosition::new(1, 1),
            &PositionEncodingKind::UTF8
        ),
        None
    );
}

#[test]
fn pull_diagnostic_projection_distinguishes_full_and_unchanged_reports() {
    let full = project_document_diagnostics(
        LanguageRequestId::new(2),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(3),
        "馃rust",
        &PositionEncodingKind::UTF16,
        DocumentDiagnosticReportResult::Report(DocumentDiagnosticReport::Full(
            RelatedFullDocumentDiagnosticReport {
                related_documents: None,
                full_document_diagnostic_report: FullDocumentDiagnosticReport {
                    result_id: Some("one".into()),
                    items: vec![ash_lsp::lsp_types::Diagnostic::new_simple(
                        Range::new(Position::new(0, 2), Position::new(0, 6)),
                        "broken".into(),
                    )],
                },
            },
        )),
    )
    .expect("full diagnostics");
    let LanguagePulledDiagnosticReport::Full(diagnostics) = full.report else {
        panic!("full report expected");
    };
    assert_eq!(diagnostics[0].range.byte_range(), 6..10);

    let unchanged = project_document_diagnostics(
        LanguageRequestId::new(3),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(3),
        "馃rust",
        &PositionEncodingKind::UTF16,
        DocumentDiagnosticReportResult::Report(DocumentDiagnosticReport::Unchanged(
            RelatedUnchangedDocumentDiagnosticReport {
                related_documents: None,
                unchanged_document_diagnostic_report: UnchangedDocumentDiagnosticReport {
                    result_id: "one".into(),
                },
            },
        )),
    )
    .expect("unchanged diagnostics");
    assert_eq!(unchanged.report, LanguagePulledDiagnosticReport::Unchanged);
}

#[test]
fn workspace_diagnostic_projection_retains_paths_and_server_coordinates() {
    let uri = Uri::from_str("file:///C:/project/src/main.rs").unwrap();
    let result = project_workspace_diagnostics(
        LanguageRequestId::new(4),
        "rust".into(),
        &PositionEncodingKind::UTF16,
        WorkspaceDiagnosticReportResult::Report(WorkspaceDiagnosticReport {
            items: vec![WorkspaceDocumentDiagnosticReport::Full(
                WorkspaceFullDocumentDiagnosticReport {
                    uri,
                    version: None,
                    full_document_diagnostic_report: FullDocumentDiagnosticReport {
                        result_id: None,
                        items: vec![ash_lsp::lsp_types::Diagnostic::new_simple(
                            Range::new(Position::new(2, 1), Position::new(2, 5)),
                            "broken".into(),
                        )],
                    },
                },
            )],
        }),
    )
    .expect("workspace diagnostics");

    assert!(result.supported);
    assert_eq!(result.language_id, "rust");
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].range.start.row, 2);
    assert_eq!(result.diagnostics[0].range.end.character, 5);
    assert_eq!(
        result.diagnostics[0].encoding,
        LanguagePositionEncoding::Utf16
    );
}

#[test]
fn formatting_projection_converts_unicode_ranges_and_sorts_edits() {
    let path = absolute_test_path("formatted.rs");
    let result = project_formatting_edits(
        LanguageRequestId::new(4),
        path.clone(),
        LanguageDocumentRevision::new(9),
        "é rust\nsecond",
        &PositionEncodingKind::UTF16,
        Some(vec![
            TextEdit::new(
                Range::new(Position::new(1, 0), Position::new(1, 6)),
                "next".into(),
            ),
            TextEdit::new(
                Range::new(Position::new(0, 1), Position::new(0, 5)),
                "RUST".into(),
            ),
        ]),
    )
    .expect("formatting edits");

    assert_eq!(result.request_id, LanguageRequestId::new(4));
    assert_eq!(result.path, path);
    assert_eq!(result.revision, LanguageDocumentRevision::new(9));
    assert_eq!(result.edits[0].range.byte_range(), 2..6);
    assert_eq!(result.edits[0].new_text, "RUST");
    assert_eq!(result.edits[1].range.byte_range(), 8..14);
}

#[test]
fn formatting_projection_rejects_invalid_and_overlapping_edits() {
    let path = absolute_test_path("formatted.rs");
    let overlapping = project_formatting_edits(
        LanguageRequestId::new(5),
        path.clone(),
        LanguageDocumentRevision::new(1),
        "abcdef",
        &PositionEncodingKind::UTF16,
        Some(vec![
            TextEdit::new(
                Range::new(Position::new(0, 0), Position::new(0, 3)),
                "a".into(),
            ),
            TextEdit::new(
                Range::new(Position::new(0, 2), Position::new(0, 4)),
                "b".into(),
            ),
        ]),
    );
    assert!(overlapping.is_err());

    let invalid = project_formatting_edits(
        LanguageRequestId::new(6),
        path,
        LanguageDocumentRevision::new(1),
        "abcdef",
        &PositionEncodingKind::UTF16,
        Some(vec![TextEdit::new(
            Range::new(Position::new(2, 0), Position::new(2, 1)),
            "x".into(),
        )]),
    );
    assert!(invalid.is_err());
}

#[test]
fn signature_help_projection_resolves_utf16_parameter_labels_and_active_indices() {
    let path = absolute_test_path("signature.rs");
    let result = project_signature_help(
        LanguageRequestId::new(7),
        path,
        LanguageDocumentRevision::new(3),
        Some(SignatureHelp {
            signatures: vec![SignatureInformation {
                label: "call(é, value)".into(),
                documentation: Some(Documentation::String("Calls it".into())),
                parameters: Some(vec![
                    ParameterInformation {
                        label: ParameterLabel::LabelOffsets([5, 6]),
                        documentation: None,
                    },
                    ParameterInformation {
                        label: ParameterLabel::Simple("value".into()),
                        documentation: Some(Documentation::String("The value".into())),
                    },
                ]),
                active_parameter: None,
            }],
            active_signature: Some(0),
            active_parameter: Some(1),
        }),
    )
    .expect("signature help");

    assert_eq!(result.active_signature, Some(0));
    assert_eq!(result.signatures[0].parameters[0].label, "é");
    assert_eq!(result.signatures[0].active_parameter, Some(1));
    assert_eq!(
        result.signatures[0].parameters[1].documentation.as_deref(),
        Some("The value")
    );
}

#[test]
fn inlay_hint_projection_converts_positions_and_drops_mutating_behavior() {
    let result = project_inlay_hints(
        LanguageRequestId::new(8),
        absolute_test_path("hints.rs"),
        LanguageDocumentRevision::new(4),
        "é value",
        &PositionEncodingKind::UTF16,
        Some(vec![InlayHint {
            position: Position::new(0, 1),
            label: InlayHintLabel::String(": String".into()),
            kind: Some(InlayHintKind::TYPE),
            text_edits: Some(vec![TextEdit::new(
                Range::new(Position::new(0, 1), Position::new(0, 1)),
                ": String".into(),
            )]),
            tooltip: Some(InlayHintTooltip::String("inferred type".into())),
            padding_left: Some(true),
            padding_right: None,
            data: None,
        }]),
    );

    assert_eq!(
        result.hints[0].position,
        LanguageDocumentPosition::new(0, 2)
    );
    assert_eq!(result.hints[0].kind, LanguageInlayHintKind::Type);
    assert_eq!(result.hints[0].tooltip.as_deref(), Some("inferred type"));
    assert!(result.hints[0].padding_left);
}

#[test]
fn linked_editing_projection_validates_identical_non_overlapping_unicode_ranges() {
    let result = project_linked_editing_ranges(
        LanguageRequestId::new(9),
        absolute_test_path("linked.rs"),
        LanguageDocumentRevision::new(5),
        "茅tag 茅tag",
        &PositionEncodingKind::UTF16,
        Some(LinkedEditingRanges {
            ranges: vec![
                Range::new(Position::new(0, 0), Position::new(0, 4)),
                Range::new(Position::new(0, 5), Position::new(0, 9)),
            ],
            word_pattern: Some("[\\p{L}]+".into()),
        }),
    )
    .expect("linked ranges");

    assert_eq!(result.ranges[0].byte_range(), 0..6);
    assert_eq!(result.ranges[1].byte_range(), 7..13);
    assert_eq!(result.word_pattern.as_deref(), Some("[\\p{L}]+"));
}

#[test]
fn linked_editing_projection_rejects_mismatched_contents() {
    let result = project_linked_editing_ranges(
        LanguageRequestId::new(10),
        absolute_test_path("linked.rs"),
        LanguageDocumentRevision::new(5),
        "open close",
        &PositionEncodingKind::UTF16,
        Some(LinkedEditingRanges {
            ranges: vec![
                Range::new(Position::new(0, 0), Position::new(0, 4)),
                Range::new(Position::new(0, 5), Position::new(0, 10)),
            ],
            word_pattern: None,
        }),
    );

    assert!(result.is_none());
}

#[test]
fn workspace_edit_projection_preserves_multiple_documents_versions_and_unicode_ranges() {
    let first = absolute_test_path("first.ts");
    let second = absolute_test_path("second.ts");
    let first_uri =
        Uri::from_str(url::Url::from_file_path(&first).expect("file URL").as_str()).expect("URI");
    let second_uri = Uri::from_str(
        url::Url::from_file_path(&second)
            .expect("file URL")
            .as_str(),
    )
    .expect("URI");
    let edit = WorkspaceEdit {
        document_changes: Some(DocumentChanges::Edits(vec![
            TextDocumentEdit {
                text_document: OptionalVersionedTextDocumentIdentifier {
                    uri: first_uri,
                    version: Some(3),
                },
                edits: vec![OneOf::Left(TextEdit::new(
                    Range::new(Position::new(0, 2), Position::new(0, 4)),
                    "new".into(),
                ))],
            },
            TextDocumentEdit {
                text_document: OptionalVersionedTextDocumentIdentifier {
                    uri: second_uri,
                    version: None,
                },
                edits: vec![OneOf::Left(TextEdit::new(
                    Range::new(Position::new(1, 0), Position::new(1, 1)),
                    "x".into(),
                ))],
            },
        ])),
        ..WorkspaceEdit::default()
    };
    let result = project_workspace_edit(
        LanguageRequestId::new(11),
        first.clone(),
        LanguageDocumentRevision::new(8),
        &PositionEncodingKind::UTF16,
        Some(edit),
    )
    .expect("workspace edit");
    assert_eq!(result.edit.entries.len(), 2);
    let LanguageEditEntry::TextDocument(first_edit) = &result.edit.entries[0] else {
        panic!("expected text edit")
    };
    assert_eq!(first_edit.server_version, Some(3));
    assert_eq!(first_edit.edits[0].range.start.character, 2);
    assert_eq!(result.edit.encoding, LanguagePositionEncoding::Utf16);
}

#[test]
fn workspace_edit_projection_preserves_resource_operation_order() {
    let source = absolute_test_path("main.ts");
    let created = Uri::from_str(
        url::Url::from_file_path(absolute_test_path("created.ts"))
            .expect("file URL")
            .as_str(),
    )
    .expect("URI");
    let edit = WorkspaceEdit {
        document_changes: Some(DocumentChanges::Operations(vec![
            DocumentChangeOperation::Op(ResourceOp::Create(CreateFile {
                uri: created,
                options: None,
                annotation_id: None,
            })),
        ])),
        ..WorkspaceEdit::default()
    };

    let result = project_workspace_edit(
        LanguageRequestId::new(12),
        source,
        LanguageDocumentRevision::new(1),
        &PositionEncodingKind::UTF16,
        Some(edit),
    )
    .expect("workspace edit");
    assert!(
        matches!(&result.edit.entries[0], LanguageEditEntry::Create { path, existing: LanguageExistingTargetBehavior::Error } if path == &absolute_test_path("created.ts"))
    );
}

#[test]
fn code_action_projection_disables_actions_that_cannot_be_applied() {
    let source = absolute_test_path("main.ts");
    let unresolved = CodeAction {
        title: "Extract function".into(),
        kind: Some(CodeActionKind::REFACTOR_EXTRACT),
        data: Some(serde_json::json!({ "id": 3 })),
        ..CodeAction::default()
    };
    let command = CodeAction {
        title: "Run server command".into(),
        command: Some(Command::new("Run".into(), "server.run".into(), None)),
        ..CodeAction::default()
    };

    let actions = project_code_actions(
        LanguageRequestId::new(13),
        source,
        LanguageDocumentRevision::new(2),
        &PositionEncodingKind::UTF16,
        false,
        Some(vec![
            CodeActionOrCommand::CodeAction(unresolved),
            CodeActionOrCommand::CodeAction(command),
        ]),
    );

    assert_eq!(actions.actions.len(), 2);
    assert_eq!(
        actions.actions[0].disabled_reason.as_deref(),
        Some("This action requires unsupported language-server resolution")
    );
    assert_eq!(actions.actions[0].provider_data["data"]["id"], 3);
    assert_eq!(
        actions.actions[1].disabled_reason.as_deref(),
        Some("This action requires an unsupported language-server command")
    );
}

#[test]
#[allow(deprecated)]
fn workspace_symbol_projection_keeps_cross_file_location() {
    let path = absolute_test_path("symbols.ts");
    let uri =
        Uri::from_str(url::Url::from_file_path(&path).expect("file URL").as_str()).expect("URI");
    let response = WorkspaceSymbolResponse::Flat(vec![SymbolInformation {
        name: "Widget".into(),
        kind: SymbolKind::CLASS,
        tags: None,
        deprecated: None,
        location: Location::new(uri, Range::new(Position::new(4, 2), Position::new(7, 1))),
        container_name: Some("ui".into()),
    }]);

    let result = project_workspace_symbols(
        LanguageRequestId::new(14),
        "Wid".into(),
        &PositionEncodingKind::UTF16,
        Some(response),
    );
    assert_eq!(result.symbols.len(), 1);
    assert_eq!(result.symbols[0].path, path);
    assert_eq!(result.symbols[0].container_name.as_deref(), Some("ui"));
    assert_eq!(result.symbols[0].range.start.row, 4);
}

#[test]
fn hierarchy_projection_preserves_follow_up_data_and_call_site_ownership() {
    let request_id = LanguageRequestId::new(9);
    let revision = LanguageDocumentRevision::new(5);
    let source = absolute_test_path("main.ts");
    let caller = call_item(
        "caller",
        absolute_test_path("caller.ts"),
        serde_json::json!({ "id": 7 }),
    );
    let callee = call_item(
        "callee",
        absolute_test_path("callee.ts"),
        serde_json::json!(["opaque"]),
    );
    let incoming = project_incoming_calls(
        request_id,
        source.clone(),
        revision,
        &PositionEncodingKind::UTF16,
        vec![CallHierarchyIncomingCall {
            from: caller.clone(),
            from_ranges: vec![Range::new(Position::new(3, 4), Position::new(3, 10))],
        }],
    );
    assert_eq!(incoming.kind, LanguageHierarchyKind::IncomingCalls);
    assert_eq!(
        incoming.entries[0].from_path,
        Some(absolute_test_path("caller.ts"))
    );
    assert_eq!(
        incoming.entries[0].item.data,
        Some(serde_json::json!({ "id": 7 }))
    );

    let outgoing = project_outgoing_calls(
        request_id,
        source.clone(),
        revision,
        &PositionEncodingKind::UTF8,
        absolute_test_path("caller.ts"),
        vec![CallHierarchyOutgoingCall {
            to: callee,
            from_ranges: vec![Range::new(Position::new(1, 2), Position::new(1, 8))],
        }],
    );
    assert_eq!(
        outgoing.entries[0].from_path,
        Some(absolute_test_path("caller.ts"))
    );
    assert_eq!(
        outgoing.entries[0].item.encoding,
        LanguagePositionEncoding::Utf8
    );
    assert!(protocol_call_hierarchy_item(outgoing.entries[0].item.clone()).is_some());
}

fn call_item(name: &str, path: PathBuf, data: serde_json::Value) -> CallHierarchyItem {
    let uri =
        Uri::from_str(url::Url::from_file_path(path).expect("file URL").as_str()).expect("URI");
    CallHierarchyItem {
        name: name.into(),
        kind: SymbolKind::FUNCTION,
        tags: None,
        detail: Some(format!("{name}()")),
        uri,
        range: Range::new(Position::new(1, 0), Position::new(4, 1)),
        selection_range: Range::new(Position::new(1, 3), Position::new(1, 3 + name.len() as u32)),
        data: Some(data),
    }
}

fn absolute_test_path(file: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\workspace\src\{file}"))
    } else {
        PathBuf::from(format!("/workspace/src/{file}"))
    }
}

#[test]
fn hover_completion_and_definition_projection_remove_protocol_types() {
    let request_id = LanguageRequestId::new(7);
    let revision = LanguageDocumentRevision::new(4);
    let path = PathBuf::from("/workspace/src/main.rs");
    let hover = project_hover(
        request_id,
        path.clone(),
        revision,
        "fn main() {}",
        &PositionEncodingKind::UTF8,
        Some(Hover {
            contents: HoverContents::Scalar(MarkedString::String("main docs".into())),
            range: Some(Range::new(Position::new(0, 3), Position::new(0, 7))),
        }),
    )
    .expect("hover");
    assert_eq!(hover.contents, "main docs");
    assert_eq!(hover.range.expect("range").byte_range(), 3..7);

    let completions = project_completions(
        request_id,
        path.clone(),
        revision,
        LanguageDocumentPosition::new(0, 7),
        "println",
        &PositionEncodingKind::UTF8,
        true,
        Some(CompletionResponse::Array(vec![CompletionItem {
            label: "println!".into(),
            detail: Some("macro".into()),
            insert_text: Some("println!($0)".into()),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                Range::new(Position::new(0, 0), Position::new(0, 7)),
                "println!()".into(),
            ))),
            ..CompletionItem::default()
        }])),
    );
    assert_eq!(completions.items[0].kind, LanguageCompletionItemKind::Text);
    assert_eq!(
        completions.items[0]
            .edit
            .as_ref()
            .expect("completion edit")
            .new_text,
        "println!()"
    );

    let snippet = project_completions(
        request_id,
        path.clone(),
        revision,
        LanguageDocumentPosition::new(0, 3),
        "pri",
        &PositionEncodingKind::UTF8,
        true,
        Some(CompletionResponse::Array(vec![CompletionItem {
            label: "println!".into(),
            kind: Some(CompletionItemKind::SNIPPET),
            insert_text: Some("println!($0)".into()),
            insert_text_format: Some(InsertTextFormat::SNIPPET),
            commit_characters: Some(vec!["(".into()]),
            preselect: Some(true),
            ..CompletionItem::default()
        }])),
    );
    assert_eq!(snippet.items[0].kind, LanguageCompletionItemKind::Snippet);
    assert_eq!(
        snippet.items[0].insert_text_format,
        LanguageCompletionInsertTextFormat::Snippet
    );
    assert_eq!(snippet.items[0].commit_characters, ["("]);
    assert_eq!(
        snippet.items[0]
            .edit
            .as_ref()
            .expect("snippet edit")
            .new_text,
        "println!($0)"
    );
    assert_eq!(
        completions.items[0]
            .edit
            .as_ref()
            .expect("safe edit")
            .range
            .byte_range(),
        0..7
    );

    let insertion = project_completions(
        request_id,
        path.clone(),
        revision,
        LanguageDocumentPosition::new(0, "🦀".len() as u32),
        "🦀value",
        &PositionEncodingKind::UTF16,
        true,
        Some(CompletionResponse::Array(vec![CompletionItem {
            label: "::new()".into(),
            ..CompletionItem::default()
        }])),
    );
    assert_eq!(
        insertion.items[0]
            .edit
            .as_ref()
            .expect("plain insertion edit")
            .range
            .byte_range(),
        4..4
    );

    let target_path = if cfg!(windows) {
        PathBuf::from(r"C:\workspace\src\lib.rs")
    } else {
        PathBuf::from("/workspace/src/lib.rs")
    };
    let target_url = url::Url::from_file_path(&target_path).expect("file URL");
    let target_uri = Uri::from_str(target_url.as_str()).expect("URI");
    let definitions = project_locations(
        request_id,
        LanguageLocationKind::Definition,
        path,
        revision,
        &PositionEncodingKind::UTF16,
        Some(GotoDefinitionResponse::Scalar(Location::new(
            target_uri,
            Range::new(Position::new(2, 4), Position::new(2, 8)),
        ))),
    );
    assert_eq!(definitions.targets[0].path, target_path);
    assert_eq!(definitions.targets[0].range.start.row, 2);
    assert_eq!(definitions.targets[0].range.start.character, 4);
    assert_eq!(definitions.targets[0].range.end.character, 8);
    assert_eq!(
        definitions.targets[0].selection_range,
        definitions.targets[0].range
    );
    assert_eq!(
        definitions.targets[0].encoding,
        LanguagePositionEncoding::Utf16
    );
}

#[test]
fn completion_projection_drops_editor_unsafe_items_and_normalizes_metadata() {
    let completions = project_completions(
        LanguageRequestId::new(7),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(3),
        LanguageDocumentPosition::new(1, 8),
        "first\nmessage.\nlast",
        &PositionEncodingKind::UTF8,
        false,
        Some(CompletionResponse::Array(vec![
            CompletionItem {
                label: "len".into(),
                detail: Some("  ".into()),
                preselect: Some(true),
                commit_characters: Some(vec![".".into(), ".".into(), "\n".into(), "ab".into()]),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                    Range::new(Position::new(1, 0), Position::new(1, 8)),
                    "len".into(),
                ))),
                ..CompletionItem::default()
            },
            CompletionItem {
                label: "chars".into(),
                preselect: Some(true),
                ..CompletionItem::default()
            },
            CompletionItem {
                label: "multiline".into(),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                    Range::new(Position::new(0, 0), Position::new(1, 8)),
                    "multiline".into(),
                ))),
                ..CompletionItem::default()
            },
            CompletionItem {
                label: " ".into(),
                ..CompletionItem::default()
            },
        ])),
    );

    assert_eq!(completions.items.len(), 2);
    assert_eq!(completions.items[0].commit_characters, ["."]);
    assert_eq!(completions.items[0].detail, None);
    assert_eq!(completions.items[0].preselect, Some(true));
    assert_eq!(completions.items[1].preselect, Some(false));
}

#[test]
fn completion_projection_keeps_safe_additional_edits_commands_and_resolve_payload() {
    let completions = project_completions(
        LanguageRequestId::new(8),
        PathBuf::from("main.rs"),
        LanguageDocumentRevision::new(4),
        LanguageDocumentPosition::new(1, 4),
        "use x;\nprin",
        &PositionEncodingKind::UTF16,
        true,
        Some(CompletionResponse::Array(vec![CompletionItem {
            label: "println".into(),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                Range::new(Position::new(1, 0), Position::new(1, 4)),
                "println!()".into(),
            ))),
            additional_text_edits: Some(vec![TextEdit::new(
                Range::new(Position::new(0, 0), Position::new(0, 0)),
                "use std::println;\n".into(),
            )]),
            command: Some(Command::new("Finish".into(), "rust.finish".into(), None)),
            data: Some(serde_json::json!({ "id": 7 })),
            ..CompletionItem::default()
        }])),
    );

    assert_eq!(completions.items.len(), 1);
    assert_eq!(completions.items[0].additional_text_edits.len(), 1);
    assert_eq!(
        completions.items[0]
            .command
            .as_ref()
            .map(|command| command.id.as_str()),
        Some("rust.finish")
    );
    assert!(completions.can_resolve);
    assert!(completions.items[0].provider_data.get("data").is_some());
}

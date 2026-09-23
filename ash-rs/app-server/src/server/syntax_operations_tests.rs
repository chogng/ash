use super::AppServer;
use super::Utf16PositionIndex;
use super::byte_offset_for_utf16;
use super::byte_range_for_utf16;
use super::project;
use super::syntax_language;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::syntax::SyntaxPositionDto;
use ash_app_server_protocol::protocol::syntax::SyntaxRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxTokenKindDto;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;
use ash_syntax::DocumentRevision;
use ash_syntax::SyntaxDocument;
use ash_syntax::SyntaxLanguage;
use serde_json::json;
use std::sync::Arc;

#[test]
fn projects_syntax_ranges_as_utf16_positions() {
    let source = "{\n  \"emoji😀\": [\n  ]\n}\n";
    let document = SyntaxDocument::open(SyntaxLanguage::Json, DocumentRevision::new(12), source)
        .expect("JSON grammar should load");

    let result = project(source, &document.snapshot());
    let string = result
        .tokens
        .iter()
        .find(|token| token.kind == SyntaxTokenKindDto::String)
        .expect("string token should be projected");

    assert_eq!(result.revision, 12);
    assert_eq!(string.range.start.line_index, 1);
    assert_eq!(string.range.start.column_index, 2);
    assert_eq!(string.range.end.line_index, 1);
    assert_eq!(string.range.end.column_index, 11);
    assert!(
        result
            .folding_ranges
            .iter()
            .any(|range| { range.range.start.line_index == 1 && range.range.end.line_index == 2 })
    );
}

#[test]
fn maps_ecmascript_protocol_languages_to_the_authoritative_grammars() {
    assert_eq!(
        syntax_language(SyntaxLanguageDto::Javascript),
        SyntaxLanguage::Javascript
    );
    assert_eq!(
        syntax_language(SyntaxLanguageDto::Javascriptreact),
        SyntaxLanguage::Javascriptreact
    );
    assert_eq!(
        syntax_language(SyntaxLanguageDto::Typescript),
        SyntaxLanguage::Typescript
    );
    assert_eq!(
        syntax_language(SyntaxLanguageDto::Typescriptreact),
        SyntaxLanguage::Typescriptreact
    );
}

#[test]
fn projects_only_requested_structural_selection_scopes() {
    let source = "fn café() {}\n";
    let document = SyntaxDocument::open(SyntaxLanguage::Rust, DocumentRevision::new(4), source)
        .expect("Rust grammar should load");
    let requested = byte_range_for_utf16(
        source,
        SyntaxRangeDto {
            start: SyntaxPositionDto {
                line_index: 0,
                column_index: 3,
            },
            end: SyntaxPositionDto {
                line_index: 0,
                column_index: 7,
            },
        },
    )
    .expect("UTF-16 range should project to byte boundaries");
    let ranges = document
        .selection_ranges(requested)
        .expect("selection query should succeed");
    let positions = Utf16PositionIndex::for_selection_ranges(source, &ranges);

    assert!(
        ranges
            .iter()
            .any(|selection| &source[selection.range.bytes.clone()] == "café")
    );
    assert!(
        ranges
            .iter()
            .any(|selection| &source[selection.range.bytes.clone()] == "fn café() {}")
    );
    assert!(
        ranges
            .iter()
            .all(|selection| selection.range.bytes != (0..source.len()))
    );
    let identifier = ranges
        .iter()
        .find(|selection| &source[selection.range.bytes.clone()] == "café")
        .expect("identifier scope");
    assert_eq!(
        positions.project_range(&identifier.range).end.column_index,
        7
    );
}

#[test]
fn rejects_utf16_positions_inside_surrogate_pairs() {
    assert_eq!(
        byte_offset_for_utf16(
            "😀",
            SyntaxPositionDto {
                line_index: 0,
                column_index: 1,
            },
        ),
        None
    );
}

#[test]
fn parser_sessions_reuse_one_document_per_connection_and_release_on_close() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    );
    let first = server.connection();
    let second = server.connection();
    let first_result = server
        .syntax_analyze(
            &first,
            &json!({
                "documentId": "model-1", "language": "rust", "revision": 1,
                "text": "fn café() {}\n",
            }),
        )
        .unwrap();
    let second_result = server
        .syntax_analyze(
            &second,
            &json!({
                "documentId": "model-1", "language": "rust", "revision": 1,
                "text": "fn other() {}\n",
            }),
        )
        .unwrap();
    assert_eq!(first_result["symbols"][0]["name"], "café");
    assert_eq!(second_result["symbols"][0]["name"], "other");
    let document = Arc::clone(
        &server.syntax_documents.lock().unwrap()[&(first.connection_id, "model-1".into())],
    );

    let changed = server
        .syntax_analyze(
            &first,
            &json!({
                "documentId": "model-1", "language": "rust", "revision": 2,
                "text": "fn café_new() {}\n",
            }),
        )
        .unwrap();
    assert_eq!(changed["revision"], 2);
    assert_eq!(changed["symbols"][0]["name"], "café_new");
    assert!(Arc::ptr_eq(
        &document,
        &server.syntax_documents.lock().unwrap()[&(first.connection_id, "model-1".into())]
    ));
    let selected = server
        .syntax_selection_ranges(
            &first,
            &json!({
                "documentId": "model-1", "language": "rust", "revision": 2,
                "text": "fn café_new() {}\n", "ranges": [{
                    "start": {"lineIndex": 0, "columnIndex": 3},
                    "end": {"lineIndex": 0, "columnIndex": 11}
                }]
            }),
        )
        .unwrap();
    assert_eq!(selected["revision"], 2);
    assert!(selected["ranges"].as_array().unwrap().len() > 0);
    assert!(
        server
            .syntax_analyze(
                &first,
                &json!({
                    "documentId": "model-1", "language": "rust", "revision": 1,
                    "text": "fn stale() {}\n",
                })
            )
            .is_err()
    );

    server
        .syntax_close(&first, &json!({"documentId": "model-1"}))
        .unwrap();
    assert_eq!(server.syntax_documents.lock().unwrap().len(), 1);
    server.close_connection(second);
    assert!(server.syntax_documents.lock().unwrap().is_empty());
    server.close_connection(first);
}

use super::AppServer;
use super::Utf16PositionIndex;
use super::byte_offset_for_utf16;
use super::byte_range_for_utf16;
use super::project;
use super::syntax_language;
use ash_app_server_protocol::protocol::syntax::SyntaxDiagnosticKindDto;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::syntax::SyntaxPositionDto;
use ash_app_server_protocol::protocol::syntax::SyntaxRangeDto;
use ash_app_server_protocol::protocol::syntax::SyntaxSymbolKindDto;
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

    let result = project(&document, &document.snapshot());
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
        &document,
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
    let positions = Utf16PositionIndex::for_selection_ranges(&document, &ranges);

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
    let document =
        SyntaxDocument::open(SyntaxLanguage::Rust, DocumentRevision::new(1), "😀").unwrap();
    assert_eq!(
        byte_offset_for_utf16(
            &document,
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
    server
        .syntax_open(
            &first,
            &json!({
                "documentId": "model-1", "language": "rust", "revision": 1,
                "text": "fn café() {}\n",
            }),
        )
        .unwrap();
    server
        .syntax_open(
            &second,
            &json!({
                "documentId": "model-1", "language": "rust", "revision": 1,
                "text": "fn other() {}\n",
            }),
        )
        .unwrap();
    let first_result = server
        .syntax_analyze(&first, &json!({"documentId": "model-1", "revision": 1}))
        .unwrap();
    let second_result = server
        .syntax_analyze(&second, &json!({"documentId": "model-1", "revision": 1}))
        .unwrap();
    assert_eq!(first_result["symbols"][0]["name"], "café");
    assert_eq!(second_result["symbols"][0]["name"], "other");
    let document = Arc::clone(
        &server.syntax_documents.lock().unwrap()[&(first.connection_id, "model-1".into())],
    );

    assert!(
        server
            .syntax_update(
                &first,
                &json!({
                    "documentId": "model-1", "previousRevision": 1, "revision": 1,
                    "edits": [{"startOffset": 3, "endOffset": 7, "text": "cafè_new"}],
                })
            )
            .is_err()
    );
    server
        .syntax_update(
            &first,
            &json!({
                "documentId": "model-1", "previousRevision": 1, "revision": 2,
                "edits": [{"startOffset": 3, "endOffset": 7, "text": "cafè_new"}],
            }),
        )
        .unwrap();
    let changed = server
        .syntax_analyze(&first, &json!({"documentId": "model-1", "revision": 2}))
        .unwrap();
    assert_eq!(changed["revision"], 2);
    assert_eq!(changed["symbols"][0]["name"], "cafè_new");
    assert!(Arc::ptr_eq(
        &document,
        &server.syntax_documents.lock().unwrap()[&(first.connection_id, "model-1".into())]
    ));
    let selected = server
        .syntax_selection_ranges(
            &first,
            &json!({
                "documentId": "model-1", "revision": 2,
                "ranges": [{
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
            .syntax_analyze(&first, &json!({"documentId": "model-1", "revision": 1}))
            .is_err()
    );
    assert!(
        server
            .syntax_update(
                &first,
                &json!({
                    "documentId": "model-1", "previousRevision": 1, "revision": 3,
                    "edits": [{"startOffset": 3, "endOffset": 3, "text": "stale"}],
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

#[test]
fn shared_syntax_queries_use_one_rust_tree_and_release_with_the_connection() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    );
    let first = server.connection();
    let second = server.connection();
    let source = ash_async_utils::CancellationSource::new();
    let token = source.token();
    server.syntax_open_shared(&first, &json!({"documentId":"shared", "language":"javascript", "revision":1, "text":"// 😀\r\nfunction café() {\r\n  return [1];\r\n}\r\n"})).unwrap();
    let query = |kind: &str, revision: u64| json!({"documentId":"shared", "operationId":"query", "revision":revision, "kind":kind, "tabSize":4, "ranges":[{"startLineIndex":0,"endLineIndex":4}], "lineIndex":null,"lines":[]});
    let highlighted = server
        .syntax_query(&first, &query("highlight", 1), &token)
        .unwrap();
    assert_eq!(highlighted["rows"][0]["tokens"][0]["end"], 5);
    assert!(!highlighted["brackets"].as_array().unwrap().is_empty());
    assert_eq!(highlighted["incremental"], false);
    assert!(
        server
            .syntax_query(&second, &query("facts", 1), &token)
            .is_err()
    );
    let facts = server
        .syntax_query(&first, &query("facts", 1), &token)
        .unwrap();
    assert_eq!(facts["facts"]["symbols"]["items"][0][0], "café");
    assert!(facts["facts"]["baseRevision"].is_null());
    server.syntax_update(&first, &json!({"documentId":"shared","previousRevision":1,"revision":5,"edits":[{"startOffset":20,"endOffset":20,"text":"新"}]})).unwrap();
    let mut updated_query = query("facts", 5);
    updated_query["factsRevision"] = json!(1);
    updated_query["factsTabSize"] = json!(4);
    let updated = server.syntax_query(&first, &updated_query, &token).unwrap();
    assert_eq!(updated["facts"]["symbols"]["items"][0][0], "café新");
    assert_eq!(updated["incremental"], true);
    assert_eq!(updated["revision"], 5);
    assert_eq!(updated["facts"]["baseRevision"], 1);
    assert!(
        server
            .syntax_query(&first, &query("facts", 2), &token)
            .is_err()
    );
    assert!(
        server
            .syntax_query(&first, &query("highlight", 1), &token)
            .is_err()
    );
    let mut invalid = query("highlight", 5);
    invalid["ranges"][0]["endLineIndex"] = json!(999);
    assert!(server.syntax_query(&first, &invalid, &token).is_err());
    source.cancel();
    assert!(
        server
            .syntax_query(&first, &query("facts", 5), &token)
            .is_err()
    );
    server.close_connection(first);
    assert!(server.syntax_documents.lock().unwrap().is_empty());
    server.close_connection(second);
}

#[test]
fn viewport_brackets_use_utf16_columns_after_unicode_prefixes_near_eof() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    );
    let connection = server.connection();
    let cancellation = ash_async_utils::CancellationSource::new();
    let line = "const label = '😀'; function café() { return [1]; }";
    let text = "// 😀\r\n".repeat(4096) + line;
    server
        .syntax_open_shared(
            &connection,
            &json!({"documentId":"tail", "language":"javascript", "revision":1, "text":text}),
        )
        .unwrap();
    let result = server.syntax_query(&connection, &json!({"documentId":"tail", "operationId":"tail", "revision":1,"kind":"highlight","tabSize":4,"ranges":[{"startLineIndex":4096,"endLineIndex":4097}],"lineIndex":null,"lines":[]}), &cancellation.token()).unwrap();
    let pairs = result["brackets"].as_array().unwrap();
    for (opening, closing) in [('(', ')'), ('{', '}'), ('[', ']')] {
        let pair = pairs
            .iter()
            .find(|pair| pair["text"] == opening.to_string())
            .unwrap();
        let start = line[..line.find(opening).unwrap()].encode_utf16().count();
        let end = line[..line.find(closing).unwrap()].encode_utf16().count();
        assert_eq!(
            pair["opening"],
            json!({"start":{"lineIndex":4096,"columnIndex":start},"end":{"lineIndex":4096,"columnIndex":start+1}})
        );
        assert_eq!(
            pair["closing"],
            json!({"start":{"lineIndex":4096,"columnIndex":end},"end":{"lineIndex":4096,"columnIndex":end+1}})
        );
    }
    server.close_connection(connection);
}

#[test]
fn shared_facts_transmit_small_patches_and_reset_missing_or_changed_bases() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    );
    let connection = server.connection();
    let source = ash_async_utils::CancellationSource::new();
    let token = source.token();
    let text = (0..1000)
        .map(|index| format!("function item{index}() {{\n  return '😀';\n}}\n"))
        .collect::<String>();
    server.syntax_open_shared(&connection, &json!({ "documentId": "patches", "language": "javascript", "revision": 1, "text": text })).unwrap();
    let query = |revision, base, tab_size| json!({ "documentId": "patches", "operationId": "facts", "revision": revision, "kind": "facts", "ranges": [], "tabSize": tab_size, "factsRevision": base, "factsTabSize": 4, "lineIndex": null, "lines": [] });
    let first = server
        .syntax_query(&connection, &query(1, None, 4), &token)
        .unwrap();
    assert_eq!(
        first["facts"]["symbols"]["items"].as_array().unwrap().len(),
        1000
    );
    let mut current: AppliedFacts = serde_json::from_value::<
        ash_app_server_protocol::protocol::syntax::SyntaxQueryResult,
    >(first)
    .map(|result| {
        let facts = result.facts.unwrap();
        AppliedFacts {
            revision: 1,
            symbols: facts.symbols.items,
            folds: facts.folds.items,
            diagnostics: facts.diagnostics.items,
        }
    })
    .unwrap();
    let initial = current.clone();
    for (revision, offset, replacement) in [
        (2, 14, "X"),
        (3, 0, "// leading 😀\n"),
        (4, 0, "// another\n"),
    ] {
        server.syntax_update(&connection, &json!({ "documentId": "patches", "previousRevision": revision - 1, "revision": revision,
            "edits": [{ "startOffset": offset, "endOffset": offset, "text": replacement }] })).unwrap();
        let base = if revision == 3 { 1 } else { revision - 1 };
        if revision == 3 {
            current = initial.clone();
        }
        let patch = server
            .syntax_query(&connection, &query(revision, Some(base), 4), &token)
            .unwrap();
        assert!(
            serde_json::to_vec(&patch).unwrap().len() < 1500,
            "a local edit must not resend a thousand symbols"
        );
        let patch: ash_app_server_protocol::protocol::syntax::SyntaxQueryResult =
            serde_json::from_value(patch).unwrap();
        let patch = patch.facts.unwrap();
        assert_eq!(patch.base_revision, Some(base));
        for edit in patch.edits {
            current.apply_edit(edit);
        }
        current.symbols.splice(
            patch.symbols.start..patch.symbols.start + patch.symbols.delete_count,
            patch.symbols.items,
        );
        current.folds.splice(
            patch.folds.start..patch.folds.start + patch.folds.delete_count,
            patch.folds.items,
        );
        current.diagnostics.splice(
            patch.diagnostics.start..patch.diagnostics.start + patch.diagnostics.delete_count,
            patch.diagnostics.items,
        );
        current.revision = revision;
        let fresh = server
            .syntax_query(&connection, &query(revision, None, 4), &token)
            .unwrap();
        let fresh: ash_app_server_protocol::protocol::syntax::SyntaxQueryResult =
            serde_json::from_value(fresh).unwrap();
        let fresh = fresh.facts.unwrap();
        assert_eq!(current.symbols, fresh.symbols.items);
        assert_eq!(current.folds, fresh.folds.items);
        assert_eq!(current.diagnostics, fresh.diagnostics.items);
    }
    let tab_change = server
        .syntax_query(&connection, &query(4, Some(4), 2), &token)
        .unwrap();
    assert_eq!(tab_change["facts"]["baseRevision"], 4);
    // Same document revision can have different tab-size dependent folding.
    let old_tab_base = server
        .syntax_query(&connection, &query(4, Some(4), 4), &token)
        .unwrap();
    assert_eq!(
        old_tab_base["facts"]["baseRevision"], 4,
        "an acknowledged base includes its tab size even after another query"
    );
    let missed = server
        .syntax_query(&connection, &query(4, Some(1), 4), &token)
        .unwrap();
    assert!(missed["facts"]["baseRevision"].is_null());
    assert_eq!(
        missed["facts"]["symbols"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1000
    );
    server.close_connection(connection);
}

#[test]
fn rope_protocol_coordinates_match_utf16_across_chunks_and_reject_split_surrogates() {
    let source = format!(
        "{}fn café() {{\r\n  \"中文😀\";\r\n}}\n",
        "// 😀中文\r\n".repeat(512)
    );
    let document =
        SyntaxDocument::open(SyntaxLanguage::Rust, DocumentRevision::new(1), &source).unwrap();
    let mut offsets = source
        .char_indices()
        .map(|(offset, _)| offset)
        .collect::<Vec<_>>();
    offsets.push(source.len());
    let dense = Utf16PositionIndex::for_offsets(&document, offsets.clone());
    for offset in offsets {
        let prefix = &source[..offset];
        let expected = SyntaxPositionDto {
            line_index: prefix.bytes().filter(|byte| *byte == b'\n').count(),
            column_index: prefix.rsplit('\n').next().unwrap().encode_utf16().count(),
        };
        assert_eq!(dense.position(offset), expected);
        assert_eq!(byte_offset_for_utf16(&document, expected), Some(offset));
        assert_eq!(
            super::byte_offset_for_utf16_index(&document, prefix.encode_utf16().count()),
            Some(offset)
        );
    }
    let emoji = source.rfind('😀').unwrap();
    let index = source[..emoji].encode_utf16().count();
    assert_eq!(
        super::byte_offset_for_utf16_index(&document, index + 1),
        None
    );
    assert_eq!(
        super::byte_offset_for_utf16_index(&document, document.text().len_utf16_cu() + 1),
        None
    );
    let sparse = Utf16PositionIndex::for_offsets(&document, vec![0, emoji, source.len()]);
    for offset in [0, emoji, source.len()] {
        assert_eq!(sparse.position(offset), dense.position(offset));
    }
    assert_eq!(
        byte_offset_for_utf16(
            &document,
            SyntaxPositionDto {
                line_index: document.line_count(),
                column_index: 0
            }
        ),
        None
    );
}

#[test]
fn shared_rope_facts_keep_dense_utf16_coordinates_after_edits() {
    let names = (0..200)
        .map(|index| format!("café{index}"))
        .collect::<Vec<_>>();
    let declarations = names
        .iter()
        .map(|name| format!("fn {name}() {{ \"中文😀\"; }}"))
        .collect::<Vec<_>>();
    let source = declarations
        .iter()
        .map(|line| format!("// 😀\r\n{line}\r\n"))
        .collect::<String>();
    let mut document =
        SyntaxDocument::open(SyntaxLanguage::Rust, DocumentRevision::new(1), source).unwrap();
    for shift in 0..2 {
        let facts = document
            .editor_facts(4, &|| false)
            .unwrap()
            .delta(None, &[]);
        let facts = AppliedFacts {
            revision: document.revision().value(),
            symbols: facts
                .symbols
                .items
                .into_iter()
                .map(|symbol| {
                    (
                        symbol.name,
                        super::symbol_kind(symbol.kind),
                        symbol.range,
                        symbol.selection_range,
                    )
                })
                .collect(),
            folds: Vec::new(),
            diagnostics: Vec::new(),
        };
        assert_eq!(facts.symbols.len(), names.len());
        for (index, (name, _, range, selection)) in facts.symbols.iter().enumerate() {
            let row = index * 2 + 1 + shift;
            assert_eq!(name, &names[index]);
            assert_eq!(
                *range,
                [row, 0, row, declarations[index].encode_utf16().count()]
            );
            assert_eq!(*selection, [row, 3, row, 3 + name.encode_utf16().count()]);
        }
        if shift == 0 {
            document
                .update_edits(
                    DocumentRevision::new(2),
                    &[ash_syntax::SyntaxEdit::insert(0, "// inserted😀\r\n")],
                )
                .unwrap();
        }
    }
}

#[test]
#[ignore = "Manual isolated Rust structural-result latency measurement"]
fn shared_facts_latency_probe() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    );
    let connection = server.connection();
    let source = ash_async_utils::CancellationSource::new();
    let mut rows = Vec::new();
    // Restricting the fixture also measures a fresh process's first large document,
    // before the shared language queries have been compiled by a smaller file.
    let size_filter = std::env::var("ASH_SYNTAX_BENCH_SIZE").ok().map(|value| {
        value
            .parse::<usize>()
            .expect("benchmark size must be an integer")
    });
    assert!(size_filter.is_none_or(|size| [1_000, 10_000, 100_000].contains(&size)));
    for size in [1_000, 10_000, 100_000] {
        if size_filter.is_some_and(|filter| filter != size) {
            continue;
        }
        let count = size / 6;
        let text = (0..count).map(|i| format!("export function item{i}(value) {{\n  const label = '😀';\n  const offset = {i};\n  return value + offset;\n}}\n\n")).collect::<String>();
        for (position, index) in [("head", 0), ("middle", count / 2), ("tail", count - 1)] {
            let id = format!("bench-{size}-{position}");
            let query = |rev, base| json!({"documentId":id,"operationId":"facts","revision":rev,"kind":"facts","tabSize":4,"factsRevision":base,"factsTabSize":4,"ranges":[],"lineIndex":null,"lines":[]});
            let start = std::time::Instant::now();
            server
                .syntax_open_shared(
                    &connection,
                    &json!({"documentId":id,"language":"javascript","revision":1,"text":text}),
                )
                .unwrap();
            let parse_ms = start.elapsed().as_secs_f64() * 1000.;
            let start = std::time::Instant::now();
            let initial = server
                .syntax_query(&connection, &query(1, None), &source.token())
                .unwrap();
            let facts_ms = start.elapsed().as_secs_f64() * 1000.;
            assert_eq!(
                initial["facts"]["symbols"]["items"]
                    .as_array()
                    .unwrap()
                    .len(),
                count
            );
            let start = std::time::Instant::now();
            let bytes = serde_json::to_vec(&initial).unwrap().len();
            let serialize_ms = start.elapsed().as_secs_f64() * 1000.;
            rows.push(json!({"size":size,"position":position,"kind":"open","parseMs":parse_ms,"factsMs":facts_ms,"queryMs":initial["queryMs"],"serializeMs":serialize_ms,"bytes":bytes}));
            let name = format!("item{index}");
            let offset = text[..text.find(&name).unwrap() + name.len()]
                .encode_utf16()
                .count();
            for step in 0..24 {
                let rev = step + 2;
                let (start_offset, end_offset, replacement, kind) = if step < 16 {
                    if step % 2 == 0 {
                        (offset, offset, "X", "name")
                    } else {
                        (offset, offset + 1, "", "name")
                    }
                } else if step % 2 == 0 {
                    (offset, offset, "\n", "newline")
                } else {
                    (offset, offset + 1, "", "newline")
                };
                let start = std::time::Instant::now();
                server.syntax_update(&connection,&json!({"documentId":id,"previousRevision":rev-1,"revision":rev,"edits":[{"startOffset":start_offset,"endOffset":end_offset,"text":replacement}]})).unwrap();
                let parse_ms = start.elapsed().as_secs_f64() * 1000.;
                let start = std::time::Instant::now();
                let result = server
                    .syntax_query(&connection, &query(rev, Some(rev - 1)), &source.token())
                    .unwrap();
                let facts_ms = start.elapsed().as_secs_f64() * 1000.;
                let start = std::time::Instant::now();
                let bytes = serde_json::to_vec(&result).unwrap().len();
                let serialize_ms = start.elapsed().as_secs_f64() * 1000.;
                assert_eq!(result["facts"]["baseRevision"], rev - 1);
                assert!(bytes < 4000, "local edits should send small patches");
                rows.push(json!({"size":size,"position":position,"kind":kind,"warmup":step<4||step==16||step==17,"parseMs":parse_ms,"factsMs":facts_ms,"serializeMs":serialize_ms,"bytes":bytes}));
            }
        }
    }
    println!(
        "SYNTAX_FACTS_SAMPLES={}",
        serde_json::to_string(&rows).unwrap()
    );
    server.close_connection(connection);
}

#[derive(Clone, Default)]
struct AppliedFacts {
    revision: u64,
    symbols: Vec<(String, SyntaxSymbolKindDto, [usize; 4], [usize; 4])>,
    folds: Vec<(usize, usize, Option<String>)>,
    diagnostics: Vec<([usize; 4], SyntaxDiagnosticKindDto)>,
}
impl AppliedFacts {
    fn apply_edit(&mut self, edit: [usize; 6]) {
        for (_, _, range, selection) in &mut self.symbols {
            shift_fact_range(range, edit);
            shift_fact_range(selection, edit);
        }
        for (start, end, _) in &mut self.folds {
            *start = shift_fact_position([*start, 0], edit)[0];
            *end = shift_fact_position([*end, 0], edit)[0];
        }
        for (range, _) in &mut self.diagnostics {
            shift_fact_range(range, edit);
        }
    }
}
fn shift_fact_position(point: [usize; 2], edit: [usize; 6]) -> [usize; 2] {
    if point < [edit[0], edit[1]] {
        point
    } else if point < [edit[2], edit[3]] {
        [edit[0], edit[1]]
    } else {
        [
            point[0] - edit[2] + edit[4],
            if point[0] == edit[2] {
                point[1] - edit[3] + edit[5]
            } else {
                point[1]
            },
        ]
    }
}
fn shift_fact_range(range: &mut [usize; 4], edit: [usize; 6]) {
    let start = shift_fact_position([range[0], range[1]], edit);
    let end = shift_fact_position([range[2], range[3]], edit);
    *range = [start[0], start[1], end[0], end[1]];
}

#[test]
fn shared_fact_patches_match_full_results_with_skipped_versions_and_unicode_boundaries() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
    );
    let connection = server.connection();
    let cancellation = ash_async_utils::CancellationSource::new();
    for (id, language, text) in [
        (
            "js-boundaries",
            "javascript",
            "function café() { return '😀'; } function tail() {}\r\n",
        ),
        (
            "nested-ts",
            "typescript",
            "export class Café {\n  run() { return '😀'; }\n}\nfunction tail() {}\n",
        ),
        (
            "rs-boundaries",
            "rust",
            "fn café() { \"😀\"; } fn tail() {}\r\n",
        ),
        (
            "errors",
            "javascript",
            "function broken( {\n  return '😀';\n}\nfunction tail() {}\n",
        ),
        ("json-errors", "json", "{\n  \"😀\": [\n}\n"),
    ] {
        server
            .syntax_open_shared(
                &connection,
                &json!({"documentId":id,"language":language,"revision":1,"text":text}),
            )
            .unwrap();
        let query = |revision, base| json!({"documentId":id,"operationId":"facts","revision":revision,"kind":"facts","tabSize":4,"factsRevision":base,"factsTabSize":4,"ranges":[],"lineIndex":null,"lines":[]});
        let decode = |result| {
            serde_json::from_value::<ash_app_server_protocol::protocol::syntax::SyntaxQueryResult>(
                result,
            )
            .unwrap()
            .facts
            .unwrap()
        };
        let full = decode(
            server
                .syntax_query(&connection, &query(1, None), &cancellation.token())
                .unwrap(),
        );
        let mut current = AppliedFacts {
            revision: 1,
            symbols: full.symbols.items,
            folds: full.folds.items,
            diagnostics: full.diagnostics.items,
        };
        for step in 0..40 {
            let revision = step + 2;
            // Alternating header edits preserve parser validity where it existed,
            // while moving every following symbol through CRLF and UTF-16 text.
            let (end, replacement) = match step % 4 {
                0 => (0, "// 😀\r\n"),
                1 => (7, ""),
                2 => (0, "  "),
                _ => (2, ""),
            };
            server.syntax_update(&connection,&json!({"documentId":id,"previousRevision":revision-1,"revision":revision,"edits":[{"startOffset":0,"endOffset":end,"text":replacement}]})).unwrap();
            if step % 9 == 0 {
                continue;
            }
            let patch = decode(
                server
                    .syntax_query(
                        &connection,
                        &query(revision, Some(current.revision)),
                        &cancellation.token(),
                    )
                    .unwrap(),
            );
            assert_eq!(patch.base_revision, Some(current.revision));
            // A completed response can be discarded by the renderer after an edit.
            if step % 7 == 0 {
                continue;
            }
            for edit in patch.edits {
                current.apply_edit(edit);
            }
            current.symbols.splice(
                patch.symbols.start..patch.symbols.start + patch.symbols.delete_count,
                patch.symbols.items,
            );
            current.folds.splice(
                patch.folds.start..patch.folds.start + patch.folds.delete_count,
                patch.folds.items,
            );
            current.diagnostics.splice(
                patch.diagnostics.start..patch.diagnostics.start + patch.diagnostics.delete_count,
                patch.diagnostics.items,
            );
            current.revision = revision;
            let full = decode(
                server
                    .syntax_query(&connection, &query(revision, None), &cancellation.token())
                    .unwrap(),
            );
            assert_eq!(
                current.symbols, full.symbols.items,
                "{id} symbols revision {revision}"
            );
            assert_eq!(
                current.folds, full.folds.items,
                "{id} folds revision {revision}"
            );
            assert_eq!(
                current.diagnostics, full.diagnostics.items,
                "{id} diagnostics revision {revision}"
            );
        }
    }
    server.close_connection(connection);
}

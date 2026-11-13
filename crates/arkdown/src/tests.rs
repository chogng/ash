use crate::ChangeKind;
use crate::Document;
use crate::Error;
use crate::Node;
use crate::NodeKind;
use crate::SourceIndex;
use crate::TextEdit;
use crate::Transaction;
use crate::Utf16Range;
use crate::parse;
use crate::render_html;

fn edit(start: u32, end: u32, text: &str) -> TextEdit {
    TextEdit {
        range: Utf16Range { start, end },
        text: text.to_owned(),
    }
}

fn apply(document: &mut Document, edits: Vec<TextEdit>) {
    document
        .apply(Transaction {
            expected_revision: document.revision(),
            edits,
        })
        .unwrap();
}

fn walk<'a>(nodes: &'a [Node], output: &mut Vec<&'a Node>) {
    for node in nodes {
        output.push(node);
        walk(&node.children, output);
    }
}

#[test]
fn unicode_offsets_round_trip_and_reject_partial_encodings() {
    for source in ["", "ASCII\r\n", "中文🙂e\u{301}👩‍👩‍👧‍👦!", "𐐷aé\0"] {
        let index = SourceIndex::new(source).unwrap();
        for byte in 0..=source.len() {
            let actual = index.byte_to_utf16(byte);
            if source.is_char_boundary(byte) {
                let units = source[..byte].encode_utf16().count() as u32;
                assert_eq!(actual.unwrap(), units);
                assert_eq!(index.utf16_to_byte(units).unwrap(), byte);
            } else {
                assert_eq!(actual, Err(Error::InvalidByteOffset { offset: byte }));
            }
        }
        for units in 0..=index.utf16_len() {
            if let Ok(byte) = index.utf16_to_byte(units) {
                assert_eq!(index.byte_to_utf16(byte).unwrap(), units);
            }
        }
        assert!(index.utf16_to_byte(index.utf16_len() + 1).is_err());
    }
    assert_eq!(
        SourceIndex::new("🙂").unwrap().utf16_to_byte(1),
        Err(Error::InvalidUtf16Offset { offset: 1 })
    );
}

#[test]
fn cursor_movement_respects_graphemes_and_crlf() {
    let source = "a👩‍👩‍👧‍👦e\u{301}\r\n中";
    let index = SourceIndex::new(source).unwrap();
    let boundaries = [0, 1, 12, 14, 16, 17];
    for pair in boundaries.windows(2) {
        assert_eq!(index.next_grapheme(pair[0]).unwrap(), pair[1]);
        assert_eq!(index.previous_grapheme(pair[1]).unwrap(), pair[0]);
    }
    assert_eq!(index.previous_grapheme(13).unwrap(), 12);
    assert_eq!(index.next_grapheme(13).unwrap(), 14);
    assert_eq!(index.previous_grapheme(0).unwrap(), 0);
    assert_eq!(index.next_grapheme(17).unwrap(), 17);
}

#[test]
fn parsed_nodes_map_back_to_exact_source_syntax() {
    let source = "# 中文🙂\r\n\r\nA **bold** &amp; `code`\r\n\r\n- [x] task\r\n\r\n| a | b |\r\n|:-|--:|\r\n| c | d |\r\n";
    let nodes = parse(source).unwrap();
    let mut flat = Vec::new();
    walk(&nodes, &mut flat);
    assert!(
        flat.iter()
            .any(|node| matches!(node.kind, NodeKind::Heading { level: 1 }))
    );
    let strong = flat
        .iter()
        .find(|node| matches!(node.kind, NodeKind::Strong))
        .unwrap();
    assert_eq!(
        &source[strong.source.bytes.start..strong.source.bytes.end],
        "**bold**"
    );
    assert!(
        flat.iter()
            .any(|node| matches!(node.kind, NodeKind::TaskListMarker { checked: true }))
    );
    assert!(
        flat.iter()
            .any(|node| matches!(node.kind, NodeKind::Table { .. }))
    );
    let index = SourceIndex::new(source).unwrap();
    for node in flat {
        assert_eq!(
            index.byte_range(node.source.utf16).unwrap(),
            node.source.bytes.start..node.source.bytes.end
        );
    }
    assert_eq!(
        Document::new(source).unwrap().snapshot().unwrap().source,
        source
    );
}

#[test]
fn atomic_multi_edit_preserves_unedited_markdown_and_line_endings() {
    let original = "# Title\r\n\r\n中文🙂 **old**\r\n";
    let mut document = Document::new(original).unwrap();
    let change = document
        .apply(Transaction {
            expected_revision: 0,
            edits: vec![edit(18, 21, "new"), edit(2, 7, "Docs")],
        })
        .unwrap();
    assert_eq!(change.revision, 1);
    assert_eq!(document.source(), "# Docs\r\n\r\n中文🙂 **new**\r\n");
    assert_eq!(document.undo(1).unwrap().kind, ChangeKind::Undo);
    assert_eq!(document.source(), original);
    document.redo(2).unwrap();
    assert_eq!(document.source(), "# Docs\r\n\r\n中文🙂 **new**\r\n");
}

#[test]
fn invalid_transaction_never_changes_source_revision_or_history() {
    let mut document = Document::new("a🙂b").unwrap();
    for edits in [
        vec![edit(0, 1, "x"), edit(2, 3, "z")],
        vec![edit(0, 3, "x"), edit(1, 4, "y")],
        vec![edit(0, 0, "x"), edit(0, 0, "y")],
        vec![edit(3, 1, "x")],
    ] {
        assert!(
            document
                .apply(Transaction {
                    expected_revision: 0,
                    edits
                })
                .is_err()
        );
        assert_eq!(document.source(), "a🙂b");
        assert_eq!(document.revision(), 0);
        assert!(!document.can_undo());
    }
    assert!(matches!(
        document.apply(Transaction {
            expected_revision: 8,
            edits: vec![]
        }),
        Err(Error::RevisionMismatch {
            expected: 8,
            actual: 0
        })
    ));
}

#[test]
fn adjacent_deletions_and_replacements_have_unambiguous_undo() {
    for edits in [
        vec![edit(0, 1, ""), edit(1, 2, "")],
        vec![edit(0, 1, ""), edit(1, 2, "中🙂")],
        vec![edit(0, 1, "🙂"), edit(1, 2, "")],
    ] {
        let mut document = Document::new("abcd").unwrap();
        apply(&mut document, edits);
        let changed = document.source().to_owned();
        document.undo(1).unwrap();
        assert_eq!(document.source(), "abcd");
        document.redo(2).unwrap();
        assert_eq!(document.source(), changed);
    }
}

#[test]
fn noops_keep_revision_and_redo_while_new_edits_clear_redo() {
    let mut document = Document::new("abc").unwrap();
    apply(&mut document, vec![edit(1, 2, "x")]);
    document.undo(1).unwrap();
    let noop = document
        .apply(Transaction {
            expected_revision: 2,
            edits: vec![edit(1, 2, "b")],
        })
        .unwrap();
    assert!(!noop.changed);
    assert_eq!(document.revision(), 2);
    assert!(document.can_redo());
    apply(&mut document, vec![edit(0, 0, "new ")]);
    assert!(!document.can_redo());
    assert!(!document.redo(3).unwrap().changed);
    assert!(matches!(
        document.undo(2),
        Err(Error::RevisionMismatch { .. })
    ));
}

#[test]
fn edits_undo_and_redo_round_trip_at_every_unicode_scalar_boundary() {
    let source = "中🙂e\u{301}\r\n";
    let index = SourceIndex::new(source).unwrap();
    let positions: Vec<u32> = source
        .char_indices()
        .map(|(byte, _)| index.byte_to_utf16(byte).unwrap())
        .chain([index.utf16_len()])
        .collect();
    for &start in &positions {
        for &end in positions.iter().filter(|&&end| end >= start) {
            for replacement in ["", "x", "🙂中", "\r\n"] {
                let mut document = Document::new(source).unwrap();
                apply(&mut document, vec![edit(start, end, replacement)]);
                let changed = document.source().to_owned();
                if changed == source {
                    continue;
                }
                document.undo(1).unwrap();
                assert_eq!(document.source(), source);
                document.redo(2).unwrap();
                assert_eq!(document.source(), changed);
            }
        }
    }
}

#[test]
fn preview_escapes_html_and_drops_active_url_schemes() {
    let source = "<script>alert(1)</script>\n\n[click](javascript:alert) ![alt](data:text/html,bad) [safe](https://example.com)\n\n<img src=x onerror=alert(1)>";
    let html = render_html(source).unwrap();
    assert!(!html.contains("<script"));
    assert!(!html.contains("javascript:"));
    assert!(!html.contains("data:text"));
    assert!(!html.contains("<img"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("href=\"https://example.com\""));
    assert!(html.contains("click alt"));
}

#[test]
fn parsing_depth_and_document_size_are_bounded() {
    let source = format!("{}text", "> ".repeat(150));
    assert!(matches!(parse(&source), Err(Error::ParseLimit { .. })));
    assert!(matches!(
        Document::new("a".repeat(crate::MAX_SOURCE_BYTES + 1)),
        Err(Error::SourceTooLarge { .. })
    ));
}

#[test]
fn serialized_transactions_reject_unknown_fields_and_fractional_coordinates() {
    assert!(
        serde_json::from_str::<Transaction>(r#"{"expected_revision":0,"edits":[],"ignored":true}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<Transaction>(
            r#"{"expected_revision":0,"edits":[{"range":{"start":0.5,"end":1},"text":"x"}]}"#
        )
        .is_err()
    );
    let transaction: Transaction = serde_json::from_str(
        r#"{"expected_revision":0,"edits":[{"range":{"start":0,"end":0},"text":"中"}]}"#,
    )
    .unwrap();
    let mut document = Document::new("").unwrap();
    let change = document.apply(transaction).unwrap();
    assert_eq!(serde_json::to_value(change).unwrap()["kind"], "edit");
    assert_eq!(document.snapshot().unwrap().source, "中");
}

#[test]
fn bounded_history_drops_oldest_transactions_without_reusing_revisions() {
    let mut document = Document::new("base").unwrap();
    for _ in 0..300 {
        apply(&mut document, vec![edit(0, 0, "a")]);
    }
    let changed = document.source().to_owned();
    let mut undone = 0;
    while document.can_undo() {
        document.undo(document.revision()).unwrap();
        undone += 1;
    }
    assert_eq!(undone, 256);
    assert_eq!(document.source(), format!("{}base", "a".repeat(44)));
    assert_eq!(document.revision(), 556);
    while document.can_redo() {
        document.redo(document.revision()).unwrap();
    }
    assert_eq!(document.source(), changed);
    assert_eq!(document.revision(), 812);
    let too_many = Transaction {
        expected_revision: 812,
        edits: vec![edit(0, 0, ""); 4097],
    };
    assert!(matches!(
        document.apply(too_many),
        Err(Error::TooManyEdits { .. })
    ));
    assert_eq!(document.revision(), 812);
    assert_eq!(document.source(), changed);
}

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

#[test]
fn structural_edits_preserve_task_spelling_tables_and_history() {
    use crate::Operation;
    use crate::operation_edits;
    let source = "- [X] 中文\r\n\r\n| a | b |\r\n| :- | -: |\r\n| 一 | 二 |\r\n\r\nafter\r\n";
    let mut document = Document::new(source).unwrap();
    let edits = operation_edits(
        source,
        Operation::SetTaskChecked {
            offset: 3,
            checked: false,
        },
    )
    .unwrap();
    apply(&mut document, edits);
    assert!(document.source().starts_with("- [ ] 中文\r\n"));
    let row = document.source().find("| 一").unwrap();
    let offset = SourceIndex::new(document.source())
        .unwrap()
        .byte_to_utf16(row)
        .unwrap();
    let edits = operation_edits(document.source(), Operation::InsertTableRow { offset }).unwrap();
    apply(&mut document, edits);
    assert!(
        document
            .source()
            .contains("| 一 | 二 |\r\n|   |   |\r\n\r\nafter")
    );
    let edits = operation_edits(document.source(), Operation::DeleteTableRow { offset }).unwrap();
    apply(&mut document, edits);
    assert!(!document.source().contains("| 一"));
    for _ in 0..3 {
        document.undo(document.revision()).unwrap();
    }
    assert_eq!(document.source(), source);
    assert!(operation_edits(source, Operation::DeleteTableRow { offset: 0 }).is_err());
    let header = SourceIndex::new(source)
        .unwrap()
        .byte_to_utf16(source.find("| a").unwrap())
        .unwrap();
    assert!(operation_edits(source, Operation::DeleteTableRow { offset: header }).is_err());
}

#[test]
fn incremental_plain_text_matches_full_parse_and_shifts_unicode_suffixes() {
    for source in [
        "alpha beta\n\n# 后面🙂\n\n- tail\n",
        "# alpha beta\r\n\r\n后面🙂\r\n",
    ] {
        for replacement in ["中文", "🙂", "", "z", "**bold**", "\n\n> quote\n"] {
            let start = source.find("pha").unwrap();
            let mut document = Document::new(source).unwrap();
            document.snapshot().unwrap();
            apply(
                &mut document,
                vec![edit(start as u32, start as u32 + 3, replacement)],
            );
            assert_eq!(
                document.snapshot().unwrap().nodes,
                parse(document.source()).unwrap()
            );
            document.undo(1).unwrap();
            assert_eq!(document.snapshot().unwrap().nodes, parse(source).unwrap());
            document.redo(2).unwrap();
            assert_eq!(
                document.snapshot().unwrap().nodes,
                parse(document.source()).unwrap()
            );
        }
    }
    let source = "alpha beta\n\n# tail\n\nthird\n\nfourth\n\nfifth\n";
    let mut nodes = parse(source).unwrap();
    assert!(crate::incremental::update(
        source,
        "al中文 beta\n\n# tail\n\nthird\n\nfourth\n\nfifth\n",
        &mut nodes,
        &[edit(2, 5, "中文")]
    ));
    assert_eq!(
        nodes,
        parse("al中文 beta\n\n# tail\n\nthird\n\nfourth\n\nfifth\n").unwrap()
    );
}

#[test]
fn host_projection_tracks_authoritative_source_and_recovers_after_parse_failure() {
    let mut projection = crate::incremental::Projection::default();
    for source in [
        "alpha beta\n\n# 后面🙂\n",
        "al中文 beta\n\n# 后面🙂\n",
        "al🙂 beta\n\n# 后面🙂\n",
        "[link][ref]\n\n[ref]: /first\n",
        "[link][ref]\n\n[ref]: /second\n",
        "\n",
        "",
        "# last",
    ] {
        assert_eq!(projection.parse(source).unwrap(), parse(source).unwrap());
        assert_eq!(projection.parse(source).unwrap(), parse(source).unwrap());
    }
    assert!(
        projection
            .parse(&format!("{}text", "> ".repeat(150)))
            .is_err()
    );
    assert_eq!(
        projection.parse("# last").unwrap(),
        parse("# last").unwrap()
    );
}

#[test]
fn projection_matches_full_parser_across_markdown_context_boundaries() {
    let sources = [
        "# alpha beta\n\nnext🙂\n",
        "[label][ref]\n\n[ref]: /first\n\nplain text\n",
        "*unclosed text\n\nplain text\n",
        "# title #\r\n\r\nplain text\r\n",
        "alpha\n---\n\nplain text\n",
        "```\nplain text\n```\n\nlast\n",
        "| a | b |\n| - | - |\n| c | d |\n\nlast\n",
        "- [ ] item\n\nlast\n",
        "[ref]: /url\n\npara [ref]\n",
    ];
    for source in sources {
        let positions: Vec<usize> = source
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(source.len()))
            .collect();
        for &start in &positions {
            for &end in positions.iter().filter(|&&end| end >= start) {
                for text in ["中", "", "x", "*", "\n", "🙂"] {
                    let mut projection = crate::incremental::Projection::default();
                    projection.parse(source).unwrap();
                    let mut changed = source.to_owned();
                    changed.replace_range(start..end, text);
                    assert_eq!(
                        projection.parse(&changed).unwrap(),
                        parse(&changed).unwrap(),
                        "{source:?}, {start}..{end}, {text:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn task_noops_preserve_uppercase_marker() {
    assert!(
        crate::operation_edits(
            "- [X] task",
            crate::Operation::SetTaskChecked {
                offset: 3,
                checked: true
            }
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn collaborative_updates_converge_and_selective_history_preserves_remote_text() {
    use crate::Buffer;
    let mut a = Buffer::new(11, "alpha🙂 beta").unwrap();
    let mut b = Buffer::new(22, "").unwrap();
    b.apply_update(&a.encode_update(&[]).unwrap()).unwrap();
    assert!(!b.can_undo());
    for (doc, text) in [(&mut a, "甲"), (&mut b, "乙")] {
        doc.apply(Transaction {
            expected_revision: doc.revision(),
            edits: vec![edit(2, 2, text)],
        })
        .unwrap();
    }
    let ua = a.encode_update(&b.state_vector()).unwrap();
    let ub = b.encode_update(&a.state_vector()).unwrap();
    a.apply_update(&ub).unwrap();
    b.apply_update(&ua).unwrap();
    assert_eq!(a.source(), b.source());
    assert!(a.source().contains('甲') && a.source().contains('乙'));
    let before = a.source();
    let revision = a.revision();
    assert!(!a.apply_update(&ub).unwrap().changed);
    assert_eq!(a.revision(), revision);
    assert!(a.can_undo());
    a.undo(a.revision()).unwrap();
    assert!(!a.source().contains('甲'));
    assert!(a.source().contains('乙'));
    b.apply_update(&a.encode_update(&b.state_vector()).unwrap())
        .unwrap();
    assert_eq!(a.source(), b.source());
    a.redo(a.revision()).unwrap();
    assert_eq!(a.source(), before);
    b.apply_update(&a.encode_update(&b.state_vector()).unwrap())
        .unwrap();
    assert_eq!(a.source(), b.source());
    let revision = a.revision();
    assert!(a.apply_update(&[255]).is_err());
    assert_eq!(a.source(), before);
    assert_eq!(a.revision(), revision);
    assert!(
        a.apply(Transaction {
            expected_revision: revision - 1,
            edits: vec![edit(0, 0, "bad")]
        })
        .is_err()
    );
}

#[test]
fn collaborative_updates_buffer_missing_dependencies_and_validate_unicode_edits() {
    use crate::Buffer;
    let mut a = Buffer::new(31, "🙂").unwrap();
    let initial = a.encode_update(&[]).unwrap();
    let state = a.state_vector();
    a.apply(Transaction {
        expected_revision: 0,
        edits: vec![edit(2, 2, "one")],
    })
    .unwrap();
    let first = a.encode_update(&state).unwrap();
    let state = a.state_vector();
    a.apply(Transaction {
        expected_revision: 1,
        edits: vec![edit(5, 5, "two")],
    })
    .unwrap();
    let second = a.encode_update(&state).unwrap();
    let mut b = Buffer::new(32, "").unwrap();
    b.apply_update(&second).unwrap();
    b.apply_update(&first).unwrap();
    b.apply_update(&initial).unwrap();
    assert_eq!(a.source(), b.source());
    assert!(!b.can_undo());
    assert!(
        b.apply(Transaction {
            expected_revision: b.revision(),
            edits: vec![edit(1, 2, "bad")]
        })
        .is_err()
    );
    assert_eq!(a.source(), b.source());
}

#[test]
fn incremental_windows_reparse_structures_and_converge_with_full_parser() {
    let prefix = "first\n\nsecond\n\n";
    let suffix = "\n\nthird\n\nfourth\n\nfifth\n\nsixth\n";
    for (body, from, to) in [
        ("alpha beta", "pha", "**bold**"),
        ("alpha beta", "pha", "🙂\n\n- one\n- two\n\n"),
        ("- alpha\n- beta", "pha", "中文"),
        ("| a | b |\n| - | - |\n| c | d |", "c", "中文"),
        ("```rust\nalpha\n```", "pha", "中文"),
    ] {
        let source = format!("{prefix}{body}{suffix}");
        let start = source.find(from).unwrap();
        let index = SourceIndex::new(&source).unwrap();
        let mut changed = source.clone();
        changed.replace_range(start..start + from.len(), to);
        let mut nodes = parse(&source).unwrap();
        assert!(
            crate::incremental::update(
                &source,
                &changed,
                &mut nodes,
                &[edit(
                    index.byte_to_utf16(start).unwrap(),
                    index.byte_to_utf16(start + from.len()).unwrap(),
                    to
                )]
            ),
            "{body}"
        );
        assert_eq!(nodes, parse(&changed).unwrap(), "{body}");
    }
}

#[test]
fn heading_and_list_operations_preserve_unicode_line_endings_and_undo() {
    use crate::ListKind;
    use crate::Operation;
    let mut doc = Document::new("中文🙂\r\n\r\ntail\r\n").unwrap();
    for operation in [
        Operation::SetHeading {
            offset: 1,
            level: 2,
        },
        Operation::SetHeading {
            offset: 4,
            level: 0,
        },
        Operation::SetListKind {
            offset: 1,
            list: ListKind::Task,
        },
        Operation::SetListKind {
            offset: 8,
            list: ListKind::Ordered,
        },
    ] {
        let edits = crate::operation_edits(doc.source(), operation).unwrap();
        apply(&mut doc, edits);
    }
    assert_eq!(doc.source(), "1. 中文🙂\r\n\r\ntail\r\n");
    for _ in 0..4 {
        doc.undo(doc.revision()).unwrap();
    }
    assert_eq!(doc.source(), "中文🙂\r\n\r\ntail\r\n");
}

#[test]
fn collaborative_undo_size_limit_preserves_live_source_and_history() {
    use crate::Buffer;
    let mut a = Buffer::new(51, "").unwrap();
    a.apply(Transaction {
        expected_revision: 0,
        edits: vec![edit(0, 0, &"x".repeat(crate::MAX_SOURCE_BYTES))],
    })
    .unwrap();
    let mut b = Buffer::new(52, "").unwrap();
    b.apply_update(&a.encode_update(&[]).unwrap()).unwrap();
    a.apply(Transaction {
        expected_revision: a.revision(),
        edits: vec![edit(0, 1, "")],
    })
    .unwrap();
    b.apply_update(&a.encode_update(&b.state_vector()).unwrap())
        .unwrap();
    b.apply(Transaction {
        expected_revision: b.revision(),
        edits: vec![edit(0, 0, "r")],
    })
    .unwrap();
    a.apply_update(&b.encode_update(&a.state_vector()).unwrap())
        .unwrap();
    let before = a.source();
    let revision = a.revision();
    assert!(matches!(
        a.undo(revision),
        Err(Error::SourceTooLarge { .. })
    ));
    assert_eq!(a.source(), before);
    assert_eq!(a.revision(), revision);
    assert!(a.can_undo());
}

#[test]
fn structural_conversion_preserves_list_indentation_and_removes_heading_closer() {
    let mut doc = Document::new("  - 中文🙂\r\n  - next\r\n").unwrap();
    let edits = crate::operation_edits(
        doc.source(),
        crate::Operation::SetListKind {
            offset: 5,
            list: crate::ListKind::Ordered,
        },
    )
    .unwrap();
    apply(&mut doc, edits);
    assert_eq!(doc.source(), "  1. 中文🙂\r\n  2. next\r\n");
    let mut doc = Document::new("  ## 中文🙂 ##  \r\n").unwrap();
    let edits = crate::operation_edits(
        doc.source(),
        crate::Operation::SetHeading {
            offset: 5,
            level: 0,
        },
    )
    .unwrap();
    apply(&mut doc, edits);
    assert_eq!(doc.source(), "  中文🙂\r\n");
}

#[test]
fn collaborative_preview_and_gc_preserve_selective_undo() {
    let mut local = crate::Buffer::new(301, "abcdef").unwrap();
    let initial = local.encode_update(&[]).unwrap();
    let sizes = local
        .preview(
            crate::BufferAction::Edit {
                edits: vec![edit(1, 4, "")],
            },
            &[],
        )
        .unwrap();
    assert_eq!(local.source(), "abcdef");
    assert!(!local.can_undo());
    local
        .apply(Transaction {
            expected_revision: 0,
            edits: vec![edit(1, 4, "")],
        })
        .unwrap();
    assert_eq!(
        sizes.snapshot_bytes,
        local.encode_update(&[]).unwrap().len()
    );
    let mut server = crate::Buffer::new(302, "").unwrap();
    server.apply_update(&initial).unwrap();
    server
        .apply_update(&local.encode_update(&server.state_vector()).unwrap())
        .unwrap();
    server.compact();
    local
        .apply_update(&server.encode_update(&[]).unwrap())
        .unwrap();
    let preview = local
        .preview(crate::BufferAction::Undo, &server.state_vector())
        .unwrap();
    assert!(preview.update_bytes > 2);
    assert_eq!(local.source(), "aef");
    local.undo(local.revision()).unwrap();
    server
        .apply_update(&local.encode_update(&server.state_vector()).unwrap())
        .unwrap();
    assert_eq!(server.source(), "abcdef");
}

#[test]
fn collaborative_history_checkpoints_bound_deleted_contents() {
    let mut local = crate::Buffer::new(303, "x".repeat(1024).as_str()).unwrap();
    let mut server = crate::Buffer::new(304, "").unwrap();
    server
        .apply_update(&local.encode_update(&[]).unwrap())
        .unwrap();
    for i in 0..600 {
        let next = if i % 2 == 0 { "y" } else { "x" }.repeat(1024);
        local
            .apply(Transaction {
                expected_revision: local.revision(),
                edits: vec![edit(0, 1024, &next)],
            })
            .unwrap();
        server
            .apply_update(&local.encode_update(&server.state_vector()).unwrap())
            .unwrap();
    }
    assert!(local.encode_update(&[]).unwrap().len() < 256 * 1024);
    assert!(server.encode_update(&[]).unwrap().len() < 8 * 1024);
    assert_eq!(server.source(), local.source());
    assert!(local.can_undo());
}

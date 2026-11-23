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
fn comment_anchors_preserve_nested_marks_and_validate_identifiers() {
    let id = "33333333-3333-4333-8333-333333333333";
    let source = format!("中文 <span data-comment-id=\"{id}\"><u>**评论🙂**</u></span> tail");
    let nodes = parse(&source).unwrap();
    let mut flat = Vec::new();
    walk(&nodes, &mut flat);
    let anchor = flat
        .iter()
        .find(|node| matches!(node.kind, NodeKind::Comment { .. }))
        .unwrap();
    assert_eq!(
        anchor.kind,
        NodeKind::Comment {
            thread_id: id.to_owned()
        }
    );
    assert!(
        flat.iter()
            .any(|node| matches!(node.kind, NodeKind::Strong))
    );
    assert!(
        flat.iter()
            .any(|node| matches!(node.kind, NodeKind::Underline))
    );
    assert_eq!(anchor.source.utf16.start, 3);
    assert!(
        render_html(&source)
            .unwrap()
            .contains(&format!("data-comment-id=\"{id}\""))
    );
    for bad in [
        "bad",
        "33333333-3333-0333-8333-333333333333",
        "33333333-3333-4333-0333-333333333333",
        "x\" onclick=\"bad()",
    ] {
        let source = format!("text <span data-comment-id=\"{bad}\">literal</span>");
        let nodes = parse(&source).unwrap();
        let mut flat = Vec::new();
        walk(&nodes, &mut flat);
        assert!(
            !flat
                .iter()
                .any(|node| matches!(node.kind, NodeKind::Comment { .. }))
        );
        assert!(!render_html(&source).unwrap().contains("<span"));
    }
    let source = format!("`<span data-comment-id=\"{id}\">code</span>`");
    assert!(!render_html(&source).unwrap().contains("<span"));
}

#[test]
fn document_inline_formats_preserve_unicode_ranges_and_reject_unknown_html() {
    let source =
        "<span data-text-color=\"red\"><u>中文 **bold**</u></span> and <mark>highlight</mark>";
    let nodes = parse(source).unwrap();
    let mut all = Vec::new();
    walk(&nodes, &mut all);
    let color = all
        .iter()
        .find(|node| {
            matches!(
                node.kind,
                NodeKind::TextColor {
                    color: crate::TextColor::Red
                }
            )
        })
        .unwrap();
    assert_eq!(
        &source[color.source.bytes.start..color.source.bytes.end],
        "<span data-text-color=\"red\"><u>中文 **bold**</u></span>"
    );
    assert!(
        all.iter()
            .any(|node| matches!(node.kind, NodeKind::Underline))
    );
    assert!(
        all.iter()
            .any(|node| matches!(node.kind, NodeKind::Highlight))
    );
    assert!(
        render_html(source)
            .unwrap()
            .contains("<u>中文 <strong>bold</strong></u>")
    );
    for source in [
        "<u>unclosed",
        "<span data-text-color=\"blue\">unknown</span>",
        "<span data-text-color=\"red\" onclick=\"alert(1)\">unsafe</span>",
        "`<u>code</u>`",
    ] {
        let nodes = parse(source).unwrap();
        let mut all = Vec::new();
        walk(&nodes, &mut all);
        assert!(!all.iter().any(|node| matches!(
            node.kind,
            NodeKind::TextColor { .. } | NodeKind::Underline | NodeKind::Highlight
        )));
        assert!(!render_html(source).unwrap().contains("<span"));
    }
    assert!(parse(&format!("{}x{}", "<u>".repeat(129), "</u>".repeat(129))).is_err());
    let mixed = format!(
        "{}**{}x{}**{}",
        "<u>".repeat(70),
        "<mark>".repeat(70),
        "</mark>".repeat(70),
        "</u>".repeat(70)
    );
    assert!(parse(&mixed).is_err());
}

#[test]
fn list_indentation_preserves_subtrees_unicode_crlf_and_history() {
    let source = "- Parent\r\n- Child🙂\r\n  - Nested\r\n- Last\r\n";
    let mut document = Document::new(source).unwrap();
    let child = source.find("Child").unwrap() as u32;
    let edits = crate::operation_edits(
        source,
        crate::Operation::IndentList {
            offset: child,
            end: child,
            direction: crate::IndentDirection::Increase,
        },
    )
    .unwrap();
    apply(&mut document, edits);
    assert_eq!(
        document.source(),
        "- Parent\r\n  - Child🙂\r\n    - Nested\r\n- Last\r\n"
    );
    let source = document.source().to_owned();
    let child = source.find("Child").unwrap() as u32;
    let edits = crate::operation_edits(
        &source,
        crate::Operation::IndentList {
            offset: child,
            end: child,
            direction: crate::IndentDirection::Decrease,
        },
    )
    .unwrap();
    apply(&mut document, edits);
    assert_eq!(
        document.source(),
        "- Parent\r\n- Child🙂\r\n  - Nested\r\n- Last\r\n"
    );
    assert!(
        crate::operation_edits(
            document.source(),
            crate::Operation::IndentList {
                offset: 2,
                end: 2,
                direction: crate::IndentDirection::Increase
            }
        )
        .is_err()
    );
    assert!(
        crate::operation_edits(
            document.source(),
            crate::Operation::IndentList {
                offset: 2,
                end: 2,
                direction: crate::IndentDirection::Decrease
            }
        )
        .is_err()
    );
}

#[test]
fn indentation_moves_selected_siblings_together() {
    let source = "- Parent\n- One\n- Two\n- Last\n";
    let mut document = Document::new(source).unwrap();
    let offset = source.find("One").unwrap() as u32;
    let end = source.find("- Last").unwrap() as u32;
    let edits = crate::operation_edits(
        source,
        crate::Operation::IndentList {
            offset,
            end,
            direction: crate::IndentDirection::Increase,
        },
    )
    .unwrap();
    apply(&mut document, edits);
    assert_eq!(document.source(), "- Parent\n  - One\n  - Two\n- Last\n");
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
fn preview_embedded_images_accepts_only_bounded_raster_base64() {
    for mime in ["png", "jpeg", "gif", "webp"] {
        let url = format!("data:image/{mime};base64,AQID");
        let html = render_html(&format!("![Image]({url}) [Link]({url})")).unwrap();
        assert!(html.contains(&format!("src=\"{url}\"")));
        assert!(!html.contains("href="));
    }
    for url in [
        "data:image/svg+xml;base64,AQID",
        "data:text/html;base64,AQID",
        "data:image/png,AQID",
        "data:image/png;base64,",
        "data:image/png;base64,AQ=I",
        "data:image/png;base64,AQID====",
    ] {
        assert!(
            !render_html(&format!("![Image]({url})"))
                .unwrap()
                .contains("<img")
        );
    }
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
fn structural_conversions_edit_nested_blocks_and_setext_headings() {
    use crate::ListKind;
    use crate::Operation;
    for (source, target, level, expected) in [
        (
            "中文🙂\r\n====\r\n\r\ntail\r\n",
            "中文",
            2,
            "## 中文🙂\r\n\r\ntail\r\n",
        ),
        (
            "> 中文 **标题**\r\n> 第二行🙂\r\n> ----\r\n",
            "中文",
            3,
            "> ### 中文 **标题** 第二行🙂\r\n",
        ),
        ("> ## 中文🙂 ##\n", "中文", 0, "> 中文🙂\n"),
        (
            "- Parent\n  - Child🙂\n  - Next\n- Tail\n",
            "Child",
            2,
            "- Parent\n  - ## Child🙂\n  - Next\n- Tail\n",
        ),
        (
            "- Parent\n\n  中文🙂\n  ----\n",
            "中文",
            0,
            "- Parent\n\n  中文🙂\n",
        ),
        ("## ##\n", "##", 0, "\n"),
        ("first\nsecond\n", "first", 1, "# first second\n"),
    ] {
        let offset = source[..source.find(target).unwrap()]
            .encode_utf16()
            .count() as u32;
        let mut doc = Document::new(source).unwrap();
        let edits =
            crate::operation_edits(source, Operation::SetHeading { offset, level }).unwrap();
        apply(&mut doc, edits);
        assert_eq!(doc.source(), expected, "{source}");
        doc.undo(doc.revision()).unwrap();
        assert_eq!(doc.source(), source);
        doc.redo(doc.revision()).unwrap();
        assert_eq!(doc.source(), expected);
    }
    for (source, target, list, expected) in [
        ("# 中文🙂 #\r\n", "中文", ListKind::Bullet, "- 中文🙂\r\n"),
        (
            "> Title\n> ====\n",
            "Title",
            ListKind::Task,
            "> - [ ] Title\n",
        ),
        (
            "- Parent\n  - Child🙂\n    - Grandchild\n  - Next\n- Tail\n",
            "Child",
            ListKind::Ordered,
            "- Parent\n  1. Child🙂\n     - Grandchild\n  2. Next\n- Tail\n",
        ),
        (
            "> - [x] Done\r\n>   - Child\r\n> - [ ] Todo\r\n",
            "Done",
            ListKind::Ordered,
            "> 1. Done\r\n>    - Child\r\n> 2. Todo\r\n",
        ),
        (
            "> - [X] Done\n> - [ ] Todo\n",
            "Done",
            ListKind::Task,
            "> - [X] Done\n> - [ ] Todo\n",
        ),
        (
            "1. Parent\n   - Child\n2. Next\n",
            "Parent",
            ListKind::Bullet,
            "- Parent\n  - Child\n- Next\n",
        ),
    ] {
        let offset = source[..source.find(target).unwrap()]
            .encode_utf16()
            .count() as u32;
        let mut doc = Document::new(source).unwrap();
        let edits =
            crate::operation_edits(source, Operation::SetListKind { offset, list }).unwrap();
        apply(&mut doc, edits);
        assert_eq!(doc.source(), expected, "{source}");
        doc.undo(doc.revision()).unwrap();
        assert_eq!(doc.source(), source);
    }
}

#[test]
fn structural_conversions_keep_literal_checkboxes_and_reject_code_blocks() {
    let source = "- [x]literal\n";
    let edits = crate::operation_edits(
        source,
        crate::Operation::SetListKind {
            offset: 5,
            list: crate::ListKind::Task,
        },
    )
    .unwrap();
    let mut doc = Document::new(source).unwrap();
    apply(&mut doc, edits);
    assert_eq!(doc.source(), "- [ ] [x]literal\n");
    let source = "- Parent\n\n  ```md\n  code\n  ```\n";
    let offset = source.find("code").unwrap() as u32;
    for operation in [
        crate::Operation::SetHeading { offset, level: 2 },
        crate::Operation::SetListKind {
            offset,
            list: crate::ListKind::Task,
        },
    ] {
        assert!(crate::operation_edits(source, operation).is_err());
    }
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

fn table_action(source: &str, action: crate::TableAction) -> String {
    let offset = source.find('|').unwrap();
    let offset = SourceIndex::new(source)
        .unwrap()
        .byte_to_utf16(offset)
        .unwrap();
    let mut document = Document::new(source).unwrap();
    apply(
        &mut document,
        crate::operation_edits(source, crate::Operation::Table { offset, action }).unwrap(),
    );
    document.source().to_owned()
}

#[test]
fn table_operations_preserve_outer_source_unicode_crlf_and_inline_marks() {
    use crate::TableAction;
    let source = "前言🙂\r\n\r\n| 名称 | 值 |\r\n| :-- | --: |\r\n| **乙** | 2 |\r\n| 甲\\|一 | 1 |\r\n\r\n后记\r\n";
    let moved = table_action(source, TableAction::MoveRow { from: 2, to: 1 });
    assert!(moved.starts_with("前言🙂\r\n\r\n"));
    assert!(moved.ends_with("\r\n\r\n后记\r\n"));
    assert!(moved.contains("| 甲\\|一 | 1 |\r\n| **乙** | 2 |"));
    assert!(moved.contains("| :--- | ---: |"));
    let inserted = table_action(&moved, TableAction::InsertColumn { index: 1 });
    assert!(inserted.contains("| 名称 |  | 值 |"));
    let deleted = table_action(&inserted, TableAction::DeleteColumns { from: 1, to: 1 });
    assert_eq!(deleted, moved);
    let sorted = table_action(
        source,
        TableAction::SortColumn {
            column: 1,
            direction: crate::SortDirection::Ascending,
        },
    );
    assert!(sorted.contains("| 甲\\|一 | 1 |\r\n| **乙** | 2 |"));
}

#[test]
fn table_cells_create_real_headings_lists_and_tasks_without_changing_the_grid() {
    use crate::CellBlock;
    use crate::ListKind;
    use crate::TableAction;
    let source = "Before\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 中文 **bold**🙂 | |\r\n\r\nAfter";
    let format = |source: &str, row, column, block| {
        table_action(
            source,
            TableAction::SetCellBlock {
                top: row,
                left: column,
                bottom: row,
                right: column,
                block,
                offset: None,
            },
        )
    };
    let heading = format(source, 1, 0, CellBlock::Heading { level: 2 });
    assert!(heading.contains("<h2>中文 **bold**🙂</h2>"));
    let nodes = parse(&heading).unwrap();
    let cell = &nodes[1].children[1].children[0];
    assert!(matches!(
        cell.children[0].kind,
        NodeKind::Heading { level: 2 }
    ));
    assert!(
        render_html(&heading)
            .unwrap()
            .contains("<h2>中文 <strong>bold</strong>🙂</h2>")
    );
    let task = format(
        &heading,
        1,
        0,
        CellBlock::List {
            list: ListKind::Task,
        },
    );
    assert!(task.contains("<ul><li>[ ] 中文 **bold**🙂</li></ul>"));
    let nodes = parse(&task).unwrap();
    let item = &nodes[1].children[1].children[0].children[0].children[0];
    assert!(matches!(item.kind, NodeKind::Item));
    assert!(matches!(
        item.children[0].kind,
        NodeKind::TaskListMarker { checked: false }
    ));
    let mut doc = Document::new(&task).unwrap();
    let edits = crate::operation_edits(
        &task,
        crate::Operation::SetTaskChecked {
            offset: item.children[0].source.utf16.start,
            checked: true,
        },
    )
    .unwrap();
    apply(&mut doc, edits);
    assert!(doc.source().contains("<li>[x] 中文"));
    assert!(
        render_html(doc.source())
            .unwrap()
            .contains("<input type=\"checkbox\" disabled checked>")
    );
    let numbered = format(
        doc.source(),
        1,
        0,
        CellBlock::List {
            list: ListKind::Ordered,
        },
    );
    assert!(numbered.contains("<ol><li>中文 **bold**🙂</li></ol>"));
    let paragraph = format(&numbered, 1, 0, CellBlock::Heading { level: 0 });
    assert!(paragraph.contains("<p>中文 **bold**🙂</p>"));
    for block in [
        CellBlock::Heading { level: 1 },
        CellBlock::List {
            list: ListKind::Bullet,
        },
        CellBlock::List {
            list: ListKind::Task,
        },
    ] {
        let value = format(source, 1, 1, block);
        let nodes = parse(&value).unwrap();
        assert_eq!(nodes[1].children.len(), 2);
        assert_eq!(nodes[1].children[1].children.len(), 2);
        assert!(value.starts_with("Before\r\n\r\n"));
        assert!(value.ends_with("\r\n\r\nAfter"));
        assert!(nodes[1].children[1].children[1].children[0].children.len() > 0);
    }
    let evil = "| A |\n| - |\n| <h2 onclick=\"bad()\">unsafe</h2><script>bad()</script> |";
    assert!(!render_html(evil).unwrap().contains("<script>"));
    assert!(!render_html(evil).unwrap().contains("<h2 onclick="));
    let missing = "| A | B |\n| - | - |\n| short |";
    let filled = format(
        missing,
        1,
        1,
        CellBlock::List {
            list: ListKind::Task,
        },
    );
    assert!(filled.contains("<ul><li>[ ] </li></ul>"));
    assert!(
        parse(&filled).unwrap()[0].children[1].children[1]
            .children
            .len()
            > 0
    );
}

#[test]
fn table_layout_metadata_is_validated_and_attached_without_visible_html() {
    let source = "| a | b |\n| --- | --- |\n| c | d |\n";
    let sized = table_action(
        source,
        crate::TableAction::SetColumnWidth {
            column: 1,
            end_column: None,
            width: 224,
        },
    );
    let nodes = parse(&sized).unwrap();
    assert_eq!(nodes.len(), 1);
    let NodeKind::Table { layout, alignments } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!(layout.widths, [0, 224]);
    assert_eq!(alignments.len(), 2);
    assert_eq!(nodes[0].source.bytes.end, sized.len());
    let html = render_html(&sized).unwrap();
    assert!(!html.contains("ash-table"));
    assert!(html.contains("width:224px"));
    for invalid in [
        r#"{"widths":[0,47]}"#,
        r#"{"widths":[0,4001]}"#,
        r#"{"widths":[0]}"#,
        r#"{"widths":[0,0],"extra":true}"#,
        r#"{"cells":[{"row":0,"column":0,"rowspan":3,"colspan":1}]}"#,
        r#"{"cells":[{"row":0,"column":0,"rowspan":1,"colspan":2},{"row":0,"column":1,"rowspan":1,"colspan":1,"color":"red"}]}"#,
    ] {
        let source = format!("{source}\n<!-- ash-table {invalid} -->\n");
        assert_eq!(parse(&source).unwrap().len(), 2, "{invalid}");
    }
}

#[test]
fn table_merge_split_color_and_header_round_trip_through_source() {
    use crate::TableAction;
    let source = "| a | b |\n| --- | --- |\n| c | d |\n";
    let merged = table_action(
        source,
        TableAction::MergeCells {
            top: 0,
            left: 0,
            bottom: 1,
            right: 1,
        },
    );
    assert!(merged.starts_with("| a b c d |  |\n| --- | --- |\n|  |  |"));
    let colored = table_action(
        &merged,
        TableAction::SetCellColor {
            top: 0,
            left: 0,
            bottom: 1,
            right: 1,
            color: Some(crate::TableColor::Purple),
        },
    );
    let no_header = table_action(&colored, TableAction::ToggleHeader {});
    let nodes = parse(&no_header).unwrap();
    let NodeKind::Table { layout, .. } = &nodes[0].kind else {
        panic!()
    };
    assert!(!layout.header);
    assert_eq!(layout.cells[0].rowspan, 2);
    assert_eq!(layout.cells[0].colspan, 2);
    assert_eq!(layout.cells[0].color, Some(crate::TableColor::Purple));
    let html = render_html(&no_header).unwrap();
    assert!(html.contains("rowspan=\"2\" colspan=\"2\""));
    assert!(html.contains("background-color:#ede6fa"));
    assert!(!html.contains("<th"));
    assert!(!html.contains("ash-table"));
    let split = table_action(&no_header, TableAction::SplitCell { row: 1, column: 1 });
    let nodes = parse(&split).unwrap();
    let NodeKind::Table { layout, .. } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!(layout.cells[0].rowspan, 1);
    assert_eq!(layout.cells[0].colspan, 1);
    assert!(split.contains("a b c d"));
}

#[test]
fn table_paste_expands_grid_escapes_plain_text_and_rejects_partial_merge_edits() {
    use crate::TableAction;
    let source = "| a | b |\n| --- | --- |\n| c | d |\n";
    let pasted = table_action(
        source,
        TableAction::PasteCells {
            cells: None,
            row: 1,
            column: 1,
            values: vec![
                vec!["**literal**|中文🙂".to_owned(), "<script>\nline".to_owned()],
                vec!["last".to_owned(), "".to_owned()],
            ],
        },
    );
    let nodes = parse(&pasted).unwrap();
    let NodeKind::Table { alignments, .. } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!(alignments.len(), 3);
    assert_eq!(nodes[0].children.len(), 3);
    assert!(pasted.contains("\\*\\*literal\\*\\*\\|中文🙂"));
    assert!(pasted.contains("\\<script\\>&#10;line"));
    let merged = table_action(
        source,
        TableAction::MergeCells {
            top: 1,
            left: 0,
            bottom: 1,
            right: 1,
        },
    );
    let invalid = TableAction::ClearCells {
        top: 1,
        left: 0,
        bottom: 1,
        right: 0,
    };
    assert!(
        crate::operation_edits(
            &merged,
            crate::Operation::Table {
                offset: 0,
                action: invalid
            }
        )
        .is_err()
    );
    for action in [
        TableAction::InsertRow { index: 99 },
        TableAction::SetColumnWidth {
            column: 0,
            end_column: None,
            width: 47,
        },
        TableAction::DeleteRows { from: 1, to: 0 },
        TableAction::PasteCells {
            cells: None,
            row: 0,
            column: 0,
            values: vec![vec!["a".to_owned()], vec![]],
        },
    ] {
        assert!(
            crate::operation_edits(source, crate::Operation::Table { offset: 0, action }).is_err()
        );
    }
    assert!(
        crate::operation_edits(
            "> | a |\n> | --- |\n> | b |",
            crate::Operation::Table {
                offset: 3,
                action: TableAction::DeleteTable {}
            }
        )
        .is_err()
    );
}

#[test]
fn table_delete_and_insert_update_spans_and_layout_coordinates() {
    use crate::TableAction;
    let source = "| a | b | c |\n| --- | --- | --- |\n| d | e | f |\n| g | h | i |\n";
    let merged = table_action(
        source,
        TableAction::MergeCells {
            top: 1,
            left: 0,
            bottom: 2,
            right: 1,
        },
    );
    let inserted = table_action(&merged, TableAction::InsertRow { index: 2 });
    let removed = table_action(&inserted, TableAction::DeleteRows { from: 1, to: 1 });
    let nodes = parse(&removed).unwrap();
    let NodeKind::Table { layout, .. } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!((layout.cells[0].row, layout.cells[0].rowspan), (1, 2));
    assert!(removed.contains("d e g h"));
    assert_eq!(
        table_action(source, TableAction::DeleteColumns { from: 0, to: 2 }),
        ""
    );
    assert_eq!(
        table_action(source, TableAction::DeleteRows { from: 0, to: 2 }),
        ""
    );
}

#[test]
fn legacy_table_row_append_stays_before_layout_annotation_and_preserves_markdown() {
    let source = "| a | b |\n| - | - |\n| c | d |\n\n<!-- ash-table {\"widths\":[112,224]} -->\n";
    let mut document = Document::new(source).unwrap();
    let offset = source.find('c').unwrap() as u32;
    apply(
        &mut document,
        crate::operation_edits(source, crate::Operation::InsertTableRow { offset }).unwrap(),
    );
    assert!(
        document
            .source()
            .starts_with("| a | b |\n| - | - |\n| c | d |\n|   |   |\n\n")
    );
    let nodes = parse(document.source()).unwrap();
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].children.len(), 3);
}

#[test]
fn table_noops_preserve_original_format_and_do_not_offer_transactions() {
    use crate::TableAction;
    let source = "| a | b |\n| - | - |\n| 1 |  |\n";
    for action in [
        TableAction::SetColumnWidth {
            column: 0,
            end_column: None,
            width: 0,
        },
        TableAction::SetColumnAlignment {
            from: 0,
            to: 1,
            alignment: crate::ColumnAlignment::None,
        },
        TableAction::MoveRow { from: 1, to: 1 },
        TableAction::ClearCells {
            top: 1,
            left: 1,
            bottom: 1,
            right: 1,
        },
        TableAction::SetCellColor {
            top: 1,
            left: 1,
            bottom: 1,
            right: 1,
            color: None,
        },
        TableAction::SplitCell { row: 1, column: 0 },
        TableAction::SortColumn {
            column: 0,
            direction: crate::SortDirection::Ascending,
        },
    ] {
        assert!(
            crate::operation_edits(source, crate::Operation::Table { offset: 0, action })
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn table_width_ranges_are_atomic_and_validate_both_boundaries() {
    use crate::TableAction;
    let source = "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
    let action = TableAction::SetColumnWidth {
        column: 0,
        end_column: Some(1),
        width: 224,
    };
    let edits =
        crate::operation_edits(source, crate::Operation::Table { offset: 0, action }).unwrap();
    assert_eq!(edits.len(), 1);
    let mut document = Document::new(source).unwrap();
    apply(&mut document, edits);
    let nodes = parse(document.source()).unwrap();
    let NodeKind::Table { layout, .. } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!(layout.widths, [224, 224, 0]);
    document.undo(document.revision()).unwrap();
    assert_eq!(document.source(), source);
    for (column, end_column) in [(1, Some(0)), (0, Some(3)), (3, None)] {
        assert!(
            crate::operation_edits(
                source,
                crate::Operation::Table {
                    offset: 0,
                    action: TableAction::SetColumnWidth {
                        column,
                        end_column,
                        width: 112
                    }
                }
            )
            .is_err()
        );
    }
    let omitted: crate::Operation = serde_json::from_str(r#"{"kind":"table","offset":0,"action":{"kind":"set_column_width","column":1,"width":112}}"#).unwrap();
    assert!(crate::operation_edits(source, omitted).is_ok());
    assert!(serde_json::from_str::<crate::Operation>(r#"{"kind":"table","offset":0,"action":{"kind":"set_column_width","column":1,"width":112,"extra":0}}"#).is_err());
}

#[test]
fn short_table_rows_project_complete_grid_and_keep_missing_ranges_inside_their_row() {
    let source =
        "| a | b | c |\r\n| --- | --- | --- |\r\n| 中文🙂 |\r\n| two | three |\r\n\r\nAfter\r\n";
    let nodes = parse(source).unwrap();
    let table = &nodes[0];
    assert_eq!(table.children.len(), 3);
    assert!(table.children.iter().all(|row| row.children.len() == 3));
    let first = &table.children[1];
    for cell in &first.children[1..] {
        assert_eq!(cell.kind, NodeKind::TableCell { missing: true });
        assert!(cell.children.is_empty());
        assert_eq!(cell.source.bytes.start, cell.source.bytes.end);
        assert_eq!(cell.source.bytes.end, first.source.bytes.end - 2);
        assert!(cell.source.bytes.end < table.children[2].source.bytes.start);
    }
    assert_eq!(
        table.children[2].children[2].kind,
        NodeKind::TableCell { missing: true }
    );
    let filled = table_action(
        source,
        crate::TableAction::PasteCells {
            cells: None,
            row: 1,
            column: 2,
            values: vec![vec!["补齐".to_owned()]],
        },
    );
    assert!(filled.contains("| 中文🙂 |  | 补齐 |\r\n| two | three |  |"));
    assert!(filled.ends_with("\r\n\r\nAfter\r\n"));
    let explicit = parse("| a | b |\n| --- | --- |\n| one |  |\n").unwrap();
    assert_eq!(
        explicit[0].children[1].children[1].kind,
        NodeKind::TableCell { missing: false }
    );
}

#[test]
fn table_clipboard_fragment_preserves_relative_spans_colors_and_cell_linebreaks() {
    use crate::TableAction;
    let source = "| a | b | c |\r\n| --- | --- | --- |\r\n| d | e | f |\r\n\r\nAfter\r\n";
    let colored = table_action(
        source,
        TableAction::SetCellColor {
            top: 1,
            left: 0,
            bottom: 1,
            right: 2,
            color: Some(crate::TableColor::Blue),
        },
    );
    let fragment = crate::TableCellLayout {
        row: 0,
        column: 0,
        rowspan: 2,
        colspan: 2,
        color: Some(crate::TableColor::Yellow),
    };
    let values = vec![
        vec!["合并\r\n格\r第三行\t尾".to_owned(), "".to_owned()],
        vec!["".to_owned(), "".to_owned()],
    ];
    let action = TableAction::PasteCells {
        row: 1,
        column: 1,
        values: values.clone(),
        cells: Some(vec![fragment.clone()]),
    };
    let pasted = table_action(&colored, action);
    assert!(pasted.contains("合并&#10;格&#10;第三行&#9;尾"));
    assert!(pasted.ends_with("\r\n\r\nAfter\r\n"));
    let nodes = parse(&pasted).unwrap();
    let NodeKind::Table { layout, .. } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!(layout.cells.len(), 2);
    assert_eq!(layout.cells[0].column, 0);
    assert_eq!(layout.cells[0].color, Some(crate::TableColor::Blue));
    assert_eq!(
        layout.cells[1],
        crate::TableCellLayout {
            row: 1,
            column: 1,
            ..fragment.clone()
        }
    );
    let html = render_html(&pasted).unwrap();
    assert!(html.contains("white-space:pre-wrap"));
    assert!(html.contains("合并\n格\n第三行\t尾"));
    let invalid = crate::TableCellLayout {
        colspan: 3,
        ..fragment
    };
    assert!(
        crate::operation_edits(
            &colored,
            crate::Operation::Table {
                offset: 0,
                action: TableAction::PasteCells {
                    row: 1,
                    column: 1,
                    values,
                    cells: Some(vec![invalid])
                }
            }
        )
        .is_err()
    );
    let cleared = table_action(
        &pasted,
        TableAction::PasteCells {
            row: 1,
            column: 1,
            values: vec![
                vec!["x".to_owned(), "y".to_owned()],
                vec!["z".to_owned(), "w".to_owned()],
            ],
            cells: Some(Vec::new()),
        },
    );
    let nodes = parse(&cleared).unwrap();
    let NodeKind::Table { layout, .. } = &nodes[0].kind else {
        panic!()
    };
    assert_eq!(layout.cells.len(), 1);
    assert_eq!(layout.cells[0].column, 0);
}

#[test]
fn table_plain_paste_keeps_cell_newlines_without_turning_literal_entities_into_markup() {
    let source = "| a | b |\n| --- | --- |\n| c | d |\n";
    let pasted = table_action(
        source,
        crate::TableAction::PasteCells {
            row: 1,
            column: 0,
            values: vec![vec![
                "first\r\nsecond\rthird\nfourth".to_owned(),
                "&#10;".to_owned(),
            ]],
            cells: None,
        },
    );
    assert!(pasted.contains("first&#10;second&#10;third&#10;fourth"));
    assert!(pasted.contains("\\&#10;"));
    let nodes = parse(&pasted).unwrap();
    let row = &nodes[0].children[1];
    let mut flat = Vec::new();
    walk(&row.children[0].children, &mut flat);
    let text: String = flat
        .into_iter()
        .filter_map(|node| {
            if let NodeKind::Text { text } = &node.kind {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(text, "first\nsecond\nthird\nfourth");
    assert!(render_html(&pasted).unwrap().contains("&amp;#10;"));
}

fn sorted_table_indices(keys: &[&str], direction: crate::SortDirection) -> Vec<usize> {
    let rows = keys
        .iter()
        .enumerate()
        .map(|(index, key)| format!("| {key} | {index} |\n"))
        .collect::<String>();
    let source = format!("| Key | Row |\n| --- | --- |\n{rows}");
    let sorted = table_action(
        &source,
        crate::TableAction::SortColumn {
            column: 0,
            direction,
        },
    );
    parse(&sorted).unwrap()[0]
        .children
        .iter()
        .skip(1)
        .map(|row| {
            let range = row.children[1].source.bytes;
            sorted[range.start..range.end].trim().parse().unwrap()
        })
        .collect()
}

#[test]
fn table_sort_keeps_blank_cells_last_in_both_directions_and_preserves_ties() {
    use crate::SortDirection;
    let keys = ["", "2", "10", " ", "2", ""];
    assert_eq!(
        sorted_table_indices(&keys, SortDirection::Ascending),
        [1, 4, 2, 0, 3, 5]
    );
    assert_eq!(
        sorted_table_indices(&keys, SortDirection::Descending),
        [2, 1, 4, 0, 3, 5]
    );
    assert_eq!(
        sorted_table_indices(&["", "", ""], SortDirection::Descending),
        [0, 1, 2]
    );
    assert_eq!(
        sorted_table_indices(&["-0", "0", "0.00", "-1"], SortDirection::Descending),
        [0, 1, 2, 3]
    );
}

#[test]
fn table_sort_uses_numeric_mode_only_for_an_entire_numeric_column() {
    use crate::SortDirection;
    let formatted = [
        "$1,200.50",
        "€50",
        "10%",
        "£-3",
        "1,200.5",
        "**50**",
        "",
        "0x10",
        "1e2",
    ];
    assert_eq!(
        sorted_table_indices(&formatted, SortDirection::Ascending),
        [3, 2, 7, 1, 5, 8, 0, 4, 6]
    );
    assert_eq!(
        sorted_table_indices(&formatted, SortDirection::Descending),
        [0, 4, 8, 1, 5, 7, 2, 3, 6]
    );
    let mixed = ["10 apples", "3", "2 apples", "ITEM10", "item2", "", "12,34"];
    assert_eq!(
        sorted_table_indices(&mixed, SortDirection::Ascending),
        [2, 1, 0, 6, 4, 3, 5]
    );
    assert_eq!(
        sorted_table_indices(&mixed, SortDirection::Descending),
        [3, 4, 6, 0, 1, 2, 5]
    );
    // A decimal comma is text, so the whole column uses the same natural order.
    assert_eq!(
        sorted_table_indices(&["1,2", "3", "10"], SortDirection::Ascending),
        [0, 1, 2]
    );
}

#[test]
fn table_sort_natural_text_folds_case_accents_and_leading_zero_runs_stably() {
    use crate::SortDirection;
    let keys = [
        "Item2",
        "item02",
        "ITEM2",
        "café2",
        "Cafe2",
        "cafe\u{0301}2",
        "Item10",
        "",
        "",
    ];
    assert_eq!(
        sorted_table_indices(&keys, SortDirection::Ascending),
        [3, 4, 5, 0, 1, 2, 6, 7, 8]
    );
    assert_eq!(
        sorted_table_indices(&keys, SortDirection::Descending),
        [6, 0, 1, 2, 3, 4, 5, 7, 8]
    );
    let long = [
        "part9999999999999999999999999999999999999999999999999",
        "part10",
        "PART2",
    ];
    assert_eq!(
        sorted_table_indices(&long, SortDirection::Ascending),
        [2, 1, 0]
    );
}
#[test]
fn embedded_forms_preserve_original_utf16_value_ranges() {
    let fence = "~~~widget:json\r\n{ \"中文😀\": \"草稿\", \"attempts\" : 1.00, \"enabled\": false }\r\n~~~\r\n";
    let form = serde_json::to_value(crate::embedded_editor::resolve("widget:json", fence)).unwrap();
    assert_eq!(form["kind"], "json_form");
    let units = fence.encode_utf16().collect::<Vec<_>>();
    for (field, (name, token)) in form["fields"].as_array().unwrap().iter().zip([
        ("中文😀", "\"草稿\""),
        ("attempts", "1.00"),
        ("enabled", "false"),
    ]) {
        assert_eq!(field["name"], name);
        let start = field["start"].as_u64().unwrap() as usize;
        let end = field["end"].as_u64().unwrap() as usize;
        assert_eq!(String::from_utf16(&units[start..end]).unwrap(), token);
    }
    assert_eq!(form["fields"].as_array().unwrap().len(), 3);
    assert!(
        crate::embedded_editor::resolve("widget:json", "```widget:json\n{\"a\":{}}\n```").is_none()
    );
    assert!(
        crate::embedded_editor::resolve("widget:json", "```widget:json\n{\"a\":true}\n").is_none()
    );
    let progress =
        crate::embedded_editor::resolve("widget:task-progress", "```widget:task-progress\n```\n");
    assert_eq!(
        serde_json::to_value(progress).unwrap()["kind"],
        "task_progress"
    );
}

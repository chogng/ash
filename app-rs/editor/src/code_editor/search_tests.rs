use super::{CodeEditorCaseSensitivity, CodeEditorDocument, CodeEditorSearchQuery};
use crate::CodeEditorCommand;

#[test]
fn search_reports_unicode_positions_and_wraps_in_both_directions() {
    let mut document = CodeEditorDocument::from_text("零 alpha\nalpha 终");
    let query = CodeEditorSearchQuery::new("alpha");

    let matches = document.search_matches(&query);
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].start().row_index, 0);
    assert_eq!(matches[0].start().byte_offset, "零 ".len());
    assert_eq!(matches[1].start().row_index, 1);

    assert_eq!(document.find_next(&query).unwrap().byte_range(), 4..9);
    assert_eq!(document.find_next(&query).unwrap().byte_range(), 10..15);
    assert_eq!(document.find_next(&query).unwrap().byte_range(), 4..9);
    assert_eq!(document.find_previous(&query).unwrap().byte_range(), 10..15);
}

#[test]
fn ascii_insensitive_search_preserves_unicode_byte_offsets() {
    let document = CodeEditorDocument::from_text("界 Rust RUST rust");
    let query = CodeEditorSearchQuery::new("RuSt")
        .with_case_sensitivity(CodeEditorCaseSensitivity::AsciiInsensitive);

    let ranges = document
        .search_matches(&query)
        .into_iter()
        .map(|matched| matched.byte_range())
        .collect::<Vec<_>>();

    assert_eq!(ranges, vec![4..8, 9..13, 14..18]);
}

#[test]
fn replace_current_and_replace_all_are_atomic_undoable_edits() {
    let mut document = CodeEditorDocument::from_text("one fish, two fish");
    let query = CodeEditorSearchQuery::new("fish");

    assert!(!document.replace_current(&query, "cat"));
    document.find_next(&query).unwrap();
    assert!(document.replace_current(&query, "cat"));
    assert_eq!(document.text(), "one cat, two fish");
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one fish, two fish");

    document.apply(CodeEditorCommand::SelectAll);
    assert_eq!(document.replace_all(&query, "🐟"), 2);
    assert_eq!(document.text(), "one 🐟, two 🐟");
    assert_eq!(document.selected_text(), Some("one 🐟, two 🐟"));
    document.apply(CodeEditorCommand::Undo);
    assert_eq!(document.text(), "one fish, two fish");
}

#[test]
fn empty_queries_and_control_only_replacements_do_not_corrupt_the_document() {
    let mut document = CodeEditorDocument::from_text("keep keep");
    let empty = CodeEditorSearchQuery::new("");
    let keep = CodeEditorSearchQuery::new("keep");

    assert!(document.search_matches(&empty).is_empty());
    assert!(document.find_next(&empty).is_none());
    assert_eq!(document.replace_all(&empty, "lost"), 0);
    assert_eq!(document.replace_all(&keep, "\0"), 2);
    assert_eq!(document.text(), " ");
}

#[test]
fn incremental_search_keeps_an_extended_query_on_the_same_match() {
    let mut document = CodeEditorDocument::from_text("fish fish");

    assert_eq!(
        document
            .find_nearest(&CodeEditorSearchQuery::new("f"))
            .unwrap()
            .byte_range(),
        0..1
    );
    assert_eq!(
        document
            .find_nearest(&CodeEditorSearchQuery::new("fi"))
            .unwrap()
            .byte_range(),
        0..2
    );
}

use std::ops::Range;

use super::CodeEditorFoldingRange;
use super::CodeEditorLanguage;
use super::derived_folding_ranges;

fn line_ranges(text: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, character) in text.char_indices() {
        if character == '\n' {
            let end = text[..index].strip_suffix('\r').map_or(index, str::len);
            ranges.push(start..end);
            start = index + character.len_utf8();
        }
    }
    ranges.push(start..text.len());
    ranges
}

fn range(start_row: usize, end_row: usize) -> CodeEditorFoldingRange {
    CodeEditorFoldingRange::new(start_row, end_row).unwrap()
}

#[test]
fn indentation_folds_include_nested_blocks_and_blank_lines() {
    let text = "root\n  child\n    nested\n\n  sibling\nafter";

    assert_eq!(
        derived_folding_ranges(text, &line_ranges(text), CodeEditorLanguage::PlainText),
        vec![range(0, 4), range(1, 3)]
    );
}

#[test]
fn regions_follow_language_comment_markers_and_nesting() {
    let text = "// #region outer\nbody\n// region inner\ninner\n// endregion\n// #endregion";

    assert_eq!(
        derived_folding_ranges(text, &line_ranges(text), CodeEditorLanguage::Rust),
        vec![range(0, 5), range(2, 4)]
    );
}

#[test]
fn regions_are_not_recognized_in_json_or_unclosed_blocks() {
    let text = "#region ignored\nbody\n#endregion\n#region unclosed";

    assert!(derived_folding_ranges(text, &line_ranges(text), CodeEditorLanguage::Json).is_empty());
    assert_eq!(
        derived_folding_ranges(text, &line_ranges(text), CodeEditorLanguage::Shell),
        vec![range(0, 2)]
    );
}

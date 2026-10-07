use super::project;
use ash_diff::DiffDocument;

#[test]
fn projects_rust_rows_and_utf16_inline_ranges_for_the_frontend() {
    let document = DiffDocument::from_text("before 😀 after", "before 🤖 after").unwrap();
    let result = project(document);

    assert_eq!(result.original_line_count, 1);
    assert_eq!(result.modified_line_count, 1);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].original_line_index, Some(0));
    assert_eq!(result.rows[0].modified_line_index, Some(0));
    assert_eq!(result.rows[0].original_changes[0].start_column, 7);
    assert_eq!(result.rows[0].original_changes[0].end_column, 9);
    assert_eq!(result.rows[0].modified_changes[0].start_column, 7);
    assert_eq!(result.rows[0].modified_changes[0].end_column, 9);
}

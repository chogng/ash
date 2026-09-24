use super::{CodeEditorFoldState, CodeEditorFoldingProjection, CodeEditorFoldingRange};

fn range(start_row: usize, end_row: usize) -> CodeEditorFoldingRange {
    CodeEditorFoldingRange::new(start_row, end_row).unwrap()
}

#[test]
fn collapsed_ranges_project_visual_rows_without_losing_nested_state() {
    let mut projection = CodeEditorFoldingProjection::default();
    projection.synchronize([range(0, 5), range(1, 3)], 7);

    assert!(projection.collapse(1, 7));
    assert_eq!(projection.source_row(2), Some(4));
    assert!(projection.collapse(0, 7));
    assert_eq!(projection.row_count(), 2);
    assert_eq!(projection.source_row(0), Some(0));
    assert_eq!(projection.source_row(1), Some(6));

    assert!(projection.expand(0, 7));
    assert_eq!(projection.state_at(1), Some(CodeEditorFoldState::Collapsed));
    assert_eq!(projection.source_row(1), Some(1));
    assert_eq!(projection.source_row(2), Some(4));
}

#[test]
fn synchronization_keeps_only_still_valid_collapsed_starts() {
    let mut projection = CodeEditorFoldingProjection::default();
    projection.synchronize([range(0, 2), range(3, 5)], 6);
    assert!(projection.collapse(3, 6));

    projection.synchronize([range(0, 2), range(3, 4)], 6);

    assert_eq!(projection.state_at(3), Some(CodeEditorFoldState::Expanded));
    assert_eq!(projection.row_count(), 6);
}

#[test]
fn normalization_uses_the_outermost_range_for_one_start_row() {
    let mut projection = CodeEditorFoldingProjection::default();
    projection.synchronize([range(0, 2), range(0, 5)], 6);

    assert_eq!(projection.ranges(), &[range(0, 5)]);
    assert!(projection.collapse(0, 6));
    assert_eq!(projection.row_count(), 1);
}

use super::*;
use crate::{CodeEditorDocument, CodeEditorRow, CodeEditorRowSource};
use std::cell::Cell;

struct CountingRows {
    row_count: usize,
    row_calls: Cell<usize>,
}

impl CodeEditorRowSource for CountingRows {
    fn row_count(&self) -> usize {
        self.row_count
    }

    fn largest_line_number(&self) -> usize {
        self.row_count
    }

    fn row(&self, index: usize) -> Option<CodeEditorRow<'_>> {
        self.row_calls.set(self.row_calls.get() + 1);
        (index < self.row_count).then(|| CodeEditorRow::new(index + 1, "row"))
    }
}

#[test]
fn wrapping_preserves_graphemes_tabs_and_empty_rows() {
    let document = CodeEditorDocument::from_text("ab界cd\na\tb\n");
    let projection = CodeEditorVisualProjection::new(&document, CodeEditorLineWrapping::Soft, 4);

    assert_eq!(projection.len(), 5);
    assert_eq!(projection.line(&document, 0).unwrap().start_byte, 0);
    assert_eq!(
        projection.line(&document, 0).unwrap().end_byte,
        "ab界".len()
    );
    assert_eq!(
        projection.line(&document, 1).unwrap().start_byte,
        "ab界".len()
    );
    assert_eq!(projection.line(&document, 2).unwrap().end_column, 4);
    assert_eq!(projection.line(&document, 3).unwrap().start_column, 4);
    assert_eq!(projection.line(&document, 4).unwrap().start_byte, 0);
    assert_eq!(document.row_count(), 3);
}

#[test]
fn unwrapped_projection_does_not_materialize_the_document_row_table() {
    let rows = CountingRows {
        row_count: 1_000_000,
        row_calls: Cell::new(0),
    };

    let projection =
        CodeEditorVisualProjection::new(&rows, CodeEditorLineWrapping::None, usize::MAX);

    assert_eq!(projection.len(), 1_000_000);
    assert_eq!(rows.row_calls.get(), 0);
    assert_eq!(projection.line(&rows, 999_999).unwrap().row_index, 999_999);
    assert_eq!(rows.row_calls.get(), 1);
}

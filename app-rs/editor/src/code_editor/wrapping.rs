//! Private source-row to visual-line projection for viewport soft wrapping.

use unicode_segmentation::UnicodeSegmentation;

use super::text_metrics::display_columns;
use super::{
    CodeEditor, CodeEditorLineWrapping, CodeEditorNavigation, CodeEditorPosition,
    CodeEditorRowSource, TAB_WIDTH,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct CodeEditorVisualLine {
    pub(super) row_index: usize,
    pub(super) start_byte: usize,
    pub(super) end_byte: usize,
    pub(super) start_column: usize,
    pub(super) end_column: usize,
    pub(super) first_for_row: bool,
    pub(super) last_for_row: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CodeEditorVisualProjection {
    Identity { row_count: usize },
    Wrapped { lines: Vec<CodeEditorVisualLine> },
}

impl CodeEditorVisualProjection {
    pub(super) fn new(
        rows: &dyn CodeEditorRowSource,
        wrapping: CodeEditorLineWrapping,
        wrap_columns: usize,
    ) -> Self {
        if wrapping == CodeEditorLineWrapping::None {
            return Self::Identity {
                row_count: rows.row_count(),
            };
        }
        let mut lines = Vec::new();
        for row_index in 0..rows.row_count() {
            let text = rows.row(row_index).and_then(|row| row.text).unwrap_or("");
            let first = lines.len();
            append_wrapped_lines(&mut lines, row_index, text, wrap_columns.max(1));
            let last = lines.len().saturating_sub(1);
            for (index, line) in lines[first..].iter_mut().enumerate() {
                line.first_for_row = index == 0;
                line.last_for_row = first + index == last;
            }
        }
        Self::Wrapped { lines }
    }

    pub(super) fn len(&self) -> usize {
        match self {
            Self::Identity { row_count } => *row_count,
            Self::Wrapped { lines } => lines.len(),
        }
    }

    pub(super) fn line(
        &self,
        rows: &dyn CodeEditorRowSource,
        index: usize,
    ) -> Option<CodeEditorVisualLine> {
        match self {
            Self::Identity { row_count } => {
                if index >= *row_count {
                    return None;
                }
                let row = rows.row(index)?;
                let text = row.text.unwrap_or("");
                Some(CodeEditorVisualLine {
                    row_index: index,
                    start_byte: 0,
                    end_byte: text.len(),
                    start_column: 0,
                    end_column: display_columns(text),
                    first_for_row: true,
                    last_for_row: true,
                })
            }
            Self::Wrapped { lines } => lines.get(index).copied(),
        }
    }

    pub(super) fn visual_line_for_position(
        &self,
        rows: &dyn CodeEditorRowSource,
        position: CodeEditorPosition,
    ) -> Option<usize> {
        let row_index = rows.visual_row(position.row_index)?;
        match self {
            Self::Identity { row_count } => (row_index < *row_count).then_some(row_index),
            Self::Wrapped { lines } => lines
                .iter()
                .enumerate()
                .filter(|(_, line)| {
                    line.row_index == row_index && line.start_byte <= position.byte_offset
                })
                .map(|(index, _)| index)
                .next_back()
                .or_else(|| lines.iter().position(|line| line.row_index == row_index)),
        }
    }
}

impl CodeEditor<'_> {
    /// Selects horizontal scrolling or editor-owned viewport soft wrapping.
    pub fn with_line_wrapping(mut self, wrapping: CodeEditorLineWrapping) -> Self {
        self.line_wrapping = wrapping;
        self.rebuild_visual_projection();
        self
    }

    pub fn visual_row_count(&self) -> usize {
        self.visual_projection.len()
    }

    pub fn caret_visual_row(&self) -> Option<usize> {
        self.visual_projection
            .visual_line_for_position(self.rows, self.rows.caret()?)
    }

    pub fn navigation(&self) -> CodeEditorNavigation {
        let page_rows = self.visible_row_capacity().max(1);
        match self.line_wrapping {
            CodeEditorLineWrapping::None => CodeEditorNavigation::LogicalLines { page_rows },
            CodeEditorLineWrapping::Soft => CodeEditorNavigation::SoftWrapped {
                columns: self.wrap_column_capacity(),
                page_rows,
            },
        }
    }

    pub(super) fn rebuild_visual_projection(&mut self) {
        self.visual_projection = CodeEditorVisualProjection::new(
            self.rows,
            self.line_wrapping,
            self.wrap_column_capacity(),
        );
    }

    fn wrap_column_capacity(&self) -> usize {
        let layout = self.layout();
        let cell_width = self.style.cell_width();
        ((layout.content.size.width - self.content_horizontal_padding * 2.0).max(cell_width)
            / cell_width)
            .floor() as usize
    }

    pub(super) fn horizontal_origin_column(&self, line: CodeEditorVisualLine) -> usize {
        match self.line_wrapping {
            CodeEditorLineWrapping::None => self.viewport.horizontal_column,
            CodeEditorLineWrapping::Soft => line.start_column,
        }
    }
}

fn append_wrapped_lines(
    lines: &mut Vec<CodeEditorVisualLine>,
    row_index: usize,
    text: &str,
    wrap_columns: usize,
) {
    if text.is_empty() {
        lines.push(CodeEditorVisualLine {
            row_index,
            start_byte: 0,
            end_byte: 0,
            start_column: 0,
            end_column: 0,
            first_for_row: true,
            last_for_row: true,
        });
        return;
    }
    let mut start_byte = 0;
    let mut start_column = 0;
    let mut column = 0;
    for (byte, grapheme) in text.grapheme_indices(true) {
        let columns = grapheme_columns(grapheme, column);
        if column > start_column && column - start_column + columns > wrap_columns {
            lines.push(CodeEditorVisualLine {
                row_index,
                start_byte,
                end_byte: byte,
                start_column,
                end_column: column,
                first_for_row: false,
                last_for_row: false,
            });
            start_byte = byte;
            start_column = column;
        }
        column += columns;
    }
    lines.push(CodeEditorVisualLine {
        row_index,
        start_byte,
        end_byte: text.len(),
        start_column,
        end_column: column,
        first_for_row: false,
        last_for_row: true,
    });
}

fn grapheme_columns(grapheme: &str, column: usize) -> usize {
    if grapheme == "\t" {
        TAB_WIDTH - column % TAB_WIDTH
    } else {
        display_columns(grapheme)
    }
}

#[cfg(test)]
#[path = "wrapping_tests.rs"]
mod tests;

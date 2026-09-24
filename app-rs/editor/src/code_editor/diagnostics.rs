//! Product-neutral document diagnostics and editor-owned presentation.

use std::ops::Range;

use zui::ui::{Color, PaintRect, Point, Rect, UiScene};

use super::text_metrics::display_columns_until;
use super::{CodeEditor, CodeEditorPosition};

/// Diagnostic importance used by CodeEditor presentation without importing a language protocol.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodeEditorDiagnosticSeverity {
    Error,
    Warning,
    Information,
    Hint,
}

/// Semantic diagnostic colors resolved by the host's editor theme adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodeEditorDiagnosticPalette {
    pub error: Color,
    pub warning: Color,
    pub information: Color,
    pub hint: Color,
}

impl CodeEditorDiagnosticPalette {
    pub(super) const fn color(self, severity: CodeEditorDiagnosticSeverity) -> Color {
        match severity {
            CodeEditorDiagnosticSeverity::Error => self.error,
            CodeEditorDiagnosticSeverity::Warning => self.warning,
            CodeEditorDiagnosticSeverity::Information => self.information,
            CodeEditorDiagnosticSeverity::Hint => self.hint,
        }
    }
}

/// One diagnostic bound to an authoritative UTF-8 document byte range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeEditorDiagnostic {
    range: Range<usize>,
    severity: CodeEditorDiagnosticSeverity,
    message: String,
    source: Option<String>,
    code: Option<String>,
}

impl CodeEditorDiagnostic {
    pub fn new(
        range: Range<usize>,
        severity: CodeEditorDiagnosticSeverity,
        message: impl Into<String>,
    ) -> Self {
        Self {
            range,
            severity,
            message: message.into(),
            source: None,
            code: None,
        }
    }

    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }

    pub const fn severity(&self) -> CodeEditorDiagnosticSeverity {
        self.severity
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }
}

impl<'a> CodeEditor<'a> {
    /// Supplies diagnostics for the exact document snapshot represented by this editor frame.
    pub const fn with_diagnostics(mut self, diagnostics: &'a [CodeEditorDiagnostic]) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    /// Returns the highest-priority diagnostic under a visible text position.
    pub fn diagnostic_at(&self, point: Point) -> Option<&'a CodeEditorDiagnostic> {
        let layout = self.layout();
        if !layout.content.contains(point) {
            return None;
        }
        let location = self.location_at(point)?;
        let line = self.visual_projection.line(self.rows, location.row_index)?;
        let row = self.rows.row(line.row_index)?;
        let text = row.text?;
        let source_row = self.rows.source_row(line.row_index)?;
        let source_range = self.rows.source_byte_range(source_row)?;
        let position = self.text_position_at(point)?;
        let offset = self.document_offset(position)?;
        self.diagnostics
            .iter()
            .filter(|diagnostic| {
                let Some(local) = local_intersection(&diagnostic.range, &source_range, text.len())
                else {
                    return false;
                };
                if !text.is_char_boundary(local.start) || !text.is_char_boundary(local.end) {
                    return false;
                }
                if diagnostic.range.is_empty() {
                    let column = display_columns_until(text, local.start);
                    let x = layout.content.origin.x
                        + self.content_horizontal_padding
                        + (column as isize - self.horizontal_origin_column(line) as isize) as f32
                            * self.style.cell_width();
                    return x <= point.x && point.x < x + self.style.cell_width();
                }
                contains_offset(&diagnostic.range, offset)
            })
            .min_by_key(|diagnostic| {
                (
                    severity_rank(diagnostic.severity),
                    diagnostic.range.end.saturating_sub(diagnostic.range.start),
                )
            })
    }

    pub(super) fn paint_diagnostics(
        &self,
        scene: &mut UiScene,
        bounds: Rect,
        source_row: usize,
        text: &str,
        visual_bytes: Range<usize>,
        origin_column: usize,
    ) {
        let Some(source_range) = self.rows.source_byte_range(source_row) else {
            return;
        };
        for diagnostic in self.diagnostics {
            let Some(local_range) =
                local_intersection(&diagnostic.range, &source_range, text.len())
            else {
                continue;
            };
            if !text.is_char_boundary(local_range.start) || !text.is_char_boundary(local_range.end)
            {
                continue;
            }
            let visible = if local_range.is_empty() {
                if !empty_diagnostic_is_on_visual_line(local_range.start, &visual_bytes, text.len())
                {
                    continue;
                }
                local_range.clone()
            } else {
                let visible = local_range.start.max(visual_bytes.start)
                    ..local_range.end.min(visual_bytes.end);
                if visible.is_empty() {
                    continue;
                }
                visible
            };
            let start_column = display_columns_until(text, visible.start.min(text.len()));
            let end_column = display_columns_until(text, visible.end.min(text.len()));
            let width_columns = end_column.saturating_sub(start_column).max(1);
            let x = bounds.origin.x
                + self.content_horizontal_padding
                + (start_column as isize - origin_column as isize) as f32 * self.style.cell_width();
            paint_squiggle(
                scene,
                x,
                bounds.origin.y + self.style.row_height() - 3.0,
                width_columns as f32 * self.style.cell_width(),
                self.style.diagnostic_color(diagnostic.severity),
            );
        }
    }

    fn document_offset(&self, position: CodeEditorPosition) -> Option<usize> {
        let range = self.rows.source_byte_range(position.row_index)?;
        Some(
            range.start
                + position
                    .byte_offset
                    .min(range.end.saturating_sub(range.start)),
        )
    }
}

fn local_intersection(
    diagnostic: &Range<usize>,
    source: &Range<usize>,
    text_len: usize,
) -> Option<Range<usize>> {
    if diagnostic.is_empty() {
        return (source.start <= diagnostic.start && diagnostic.start <= source.end).then_some(
            diagnostic.start.saturating_sub(source.start).min(text_len)
                ..diagnostic.start.saturating_sub(source.start).min(text_len),
        );
    }
    let start = diagnostic.start.max(source.start);
    let end = diagnostic.end.min(source.end);
    (start < end).then(|| start - source.start..end - source.start)
}

fn contains_offset(range: &Range<usize>, offset: usize) -> bool {
    if range.is_empty() {
        range.start == offset
    } else {
        range.contains(&offset)
    }
}

fn empty_diagnostic_is_on_visual_line(
    offset: usize,
    visual_bytes: &Range<usize>,
    text_len: usize,
) -> bool {
    visual_bytes.contains(&offset)
        || (offset == text_len && visual_bytes.end == text_len)
        || (text_len == 0 && visual_bytes.is_empty())
}

const fn severity_rank(severity: CodeEditorDiagnosticSeverity) -> u8 {
    match severity {
        CodeEditorDiagnosticSeverity::Error => 0,
        CodeEditorDiagnosticSeverity::Warning => 1,
        CodeEditorDiagnosticSeverity::Information => 2,
        CodeEditorDiagnosticSeverity::Hint => 3,
    }
}

fn paint_squiggle(scene: &mut UiScene, x: f32, y: f32, width: f32, color: Color) {
    let steps = (width / 2.0).ceil() as usize;
    for step in 0..steps {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(x + step as f32 * 2.0, y + (step % 2) as f32, 2.0, 1.0),
            color,
        ));
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;

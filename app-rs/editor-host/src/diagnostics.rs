//! Editor presentation for editor-owned diagnostic hover details.

use ash_editor::CodeEditorDiagnostic;
use zui::ui::{
    Border, Component, ComponentElement, Edges, Element, PaintRect, Point, Rect, Size, TextBlock,
    TextBlockWrap, TextStyle, UiScene,
};

use crate::style::EditorOverlayStyle;

const TOOLTIP_WIDTH: f32 = 360.0;
const TOOLTIP_HEIGHT: f32 = 58.0;
const TOOLTIP_GAP: f32 = 10.0;
const TOOLTIP_PADDING: f32 = 9.0;

/// Pointer-anchored diagnostic detail presented outside CodeEditor internals.
pub struct FileEditorDiagnosticTooltip<'a> {
    bounds: Rect,
    diagnostic: &'a CodeEditorDiagnostic,
    style: EditorOverlayStyle,
}

impl<'a> FileEditorDiagnosticTooltip<'a> {
    pub fn new(
        editor_bounds: Rect,
        pointer: Point,
        diagnostic: &'a CodeEditorDiagnostic,
        style: EditorOverlayStyle,
    ) -> Self {
        let width = TOOLTIP_WIDTH.min(editor_bounds.size.width.max(1.0));
        let x = (pointer.x + TOOLTIP_GAP)
            .min(editor_bounds.right() - width)
            .max(editor_bounds.origin.x);
        let below = pointer.y + TOOLTIP_GAP;
        let y = if below + TOOLTIP_HEIGHT <= editor_bounds.bottom() {
            below
        } else {
            (pointer.y - TOOLTIP_GAP - TOOLTIP_HEIGHT).max(editor_bounds.origin.y)
        };
        Self {
            bounds: Rect::from_xywh(x, y, width, TOOLTIP_HEIGHT),
            diagnostic,
            style,
        }
    }

    #[cfg(test)]
    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    fn label(&self) -> String {
        match (self.diagnostic.source(), self.diagnostic.code()) {
            (Some(source), Some(code)) => format!("{source}({code}): {}", self.message()),
            (Some(source), None) => format!("{source}: {}", self.message()),
            (None, Some(code)) => format!("{code}: {}", self.message()),
            (None, None) => self.message(),
        }
    }

    fn message(&self) -> String {
        self.diagnostic
            .message()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl Component for FileEditorDiagnosticTooltip<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("FileEditorDiagnosticTooltip").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.surface_raised)
                .with_border(Border::new(Edges::uniform(1.0), self.style.border)),
        );
        scene.draw_text(
            TextBlock::new(
                self.label(),
                Point::new(
                    self.bounds.origin.x + TOOLTIP_PADDING,
                    self.bounds.origin.y + TOOLTIP_PADDING,
                ),
                Size::new(
                    (self.bounds.size.width - TOOLTIP_PADDING * 2.0).max(1.0),
                    self.bounds.size.height - TOOLTIP_PADDING * 2.0,
                ),
                TextStyle::new(12.0, self.style.text).with_line_height(18.0),
            )
            .with_wrap(TextBlockWrap::WordOrGlyph),
        );
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;

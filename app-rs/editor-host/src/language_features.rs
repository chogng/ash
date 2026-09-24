//! Editor popovers for product-neutral language hover and completion results.

use ash_lsp_manager::{LanguageCompletions, LanguageHover};
use zui::ui::{
    Border, Component, ComponentElement, Edges, Element, PaintRect, Point, Rect, Size, TextBlock,
    TextBlockWrap, TextStyle, UiScene,
};

use crate::style::EditorOverlayStyle;

const POPOVER_WIDTH: f32 = 380.0;
const POPOVER_GAP: f32 = 8.0;
const POPOVER_PADDING: f32 = 9.0;
const COMPLETION_ROW_HEIGHT: f32 = 23.0;
const MAX_VISIBLE_COMPLETIONS: usize = 8;

pub struct LanguageHoverPopover<'a> {
    bounds: Rect,
    hover: &'a LanguageHover,
    style: EditorOverlayStyle,
}

impl<'a> LanguageHoverPopover<'a> {
    pub fn new(
        editor_bounds: Rect,
        anchor: Point,
        hover: &'a LanguageHover,
        style: EditorOverlayStyle,
    ) -> Self {
        let height = 96.0_f32.min(editor_bounds.size.height.max(1.0));
        Self {
            bounds: popover_bounds(editor_bounds, anchor, height),
            hover,
            style,
        }
    }
}

impl Component for LanguageHoverPopover<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("LanguageHoverPopover").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        paint_surface(scene, self.bounds, self.style);
        scene.draw_text(
            TextBlock::new(
                compact_text(&self.hover.contents),
                Point::new(
                    self.bounds.origin.x + POPOVER_PADDING,
                    self.bounds.origin.y + POPOVER_PADDING,
                ),
                Size::new(
                    self.bounds.size.width - POPOVER_PADDING * 2.0,
                    self.bounds.size.height - POPOVER_PADDING * 2.0,
                ),
                TextStyle::new(12.0, self.style.text).with_line_height(18.0),
            )
            .with_wrap(TextBlockWrap::WordOrGlyph),
        );
    }
}

pub struct LanguageCompletionPopover<'a> {
    bounds: Rect,
    completions: &'a LanguageCompletions,
    style: EditorOverlayStyle,
    selected: usize,
}

impl<'a> LanguageCompletionPopover<'a> {
    pub fn new(
        editor_bounds: Rect,
        anchor: Point,
        completions: &'a LanguageCompletions,
        selected: usize,
        style: EditorOverlayStyle,
    ) -> Self {
        let rows = completions.items.len().clamp(1, MAX_VISIBLE_COMPLETIONS);
        let height = rows as f32 * COMPLETION_ROW_HEIGHT + POPOVER_PADDING * 2.0;
        Self {
            bounds: popover_bounds(editor_bounds, anchor, height),
            completions,
            style,
            selected,
        }
    }
}

impl Component for LanguageCompletionPopover<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("LanguageCompletionPopover").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        paint_surface(scene, self.bounds, self.style);
        if self.completions.items.is_empty() {
            paint_completion_row(scene, self.bounds, 0, "No suggestions", None, self.style);
            return;
        }
        let window_start = completion_window_start(self.completions.items.len(), self.selected);
        for (row, (index, item)) in self
            .completions
            .items
            .iter()
            .enumerate()
            .skip(window_start)
            .take(MAX_VISIBLE_COMPLETIONS)
            .enumerate()
        {
            if index == self.selected {
                scene.draw_rect(PaintRect::new(
                    Rect::from_xywh(
                        self.bounds.origin.x + 1.0,
                        self.bounds.origin.y + POPOVER_PADDING + row as f32 * COMPLETION_ROW_HEIGHT,
                        self.bounds.size.width - 2.0,
                        COMPLETION_ROW_HEIGHT,
                    ),
                    self.style.surface_hovered,
                ));
            }
            paint_completion_row(
                scene,
                self.bounds,
                row,
                &item.label,
                item.detail.as_deref(),
                self.style,
            );
        }
    }
}

fn completion_window_start(item_count: usize, selected: usize) -> usize {
    let last_start = item_count.saturating_sub(MAX_VISIBLE_COMPLETIONS);
    selected
        .saturating_sub(MAX_VISIBLE_COMPLETIONS - 1)
        .min(last_start)
}

fn paint_completion_row(
    scene: &mut UiScene,
    bounds: Rect,
    index: usize,
    label: &str,
    detail: Option<&str>,
    style: EditorOverlayStyle,
) {
    let y = bounds.origin.y + POPOVER_PADDING + index as f32 * COMPLETION_ROW_HEIGHT;
    scene.draw_text(TextBlock::new(
        label,
        Point::new(bounds.origin.x + POPOVER_PADDING, y + 2.0),
        Size::new(bounds.size.width * 0.58, 18.0),
        TextStyle::new(12.0, style.text).with_line_height(18.0),
    ));
    if let Some(detail) = detail {
        scene.draw_text(TextBlock::new(
            detail,
            Point::new(bounds.origin.x + bounds.size.width * 0.6, y + 2.0),
            Size::new(bounds.size.width * 0.36, 18.0),
            TextStyle::new(11.0, style.text_muted).with_line_height(18.0),
        ));
    }
}

fn popover_bounds(editor: Rect, anchor: Point, requested_height: f32) -> Rect {
    let width = POPOVER_WIDTH.min(editor.size.width.max(1.0));
    let height = requested_height.min(editor.size.height.max(1.0));
    let x = anchor.x.min(editor.right() - width).max(editor.origin.x);
    let below = anchor.y + POPOVER_GAP;
    let y = if below + height <= editor.bottom() {
        below
    } else {
        (anchor.y - POPOVER_GAP - height).max(editor.origin.y)
    };
    Rect::from_xywh(x, y, width, height)
}

fn paint_surface(scene: &mut UiScene, bounds: Rect, style: EditorOverlayStyle) {
    scene.draw_rect(
        PaintRect::new(bounds, style.surface_raised)
            .with_border(Border::new(Edges::uniform(1.0), style.border)),
    );
}

fn compact_text(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("```") && !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
#[path = "language_features_tests.rs"]
mod tests;

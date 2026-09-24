use std::collections::BinaryHeap;

use zui::ui::{PaintRect, Point, Rect, Size, TextBlock, TextBlockWrap, TextSpan, UiScene};

use super::text_metrics::{
    display_columns, display_columns_until, expand_tabs, expand_tabs_at_column,
    has_wide_display_cells,
};
use super::{
    CodeEditor, CodeEditorCaretStyle, CodeEditorInlineHighlight, CodeEditorSyntaxToken,
    paint_text_block,
};

const BAR_CARET_WIDTH: f32 = 1.5;

impl CodeEditor<'_> {
    pub fn caret_bounds(&self) -> Option<Rect> {
        let caret = self.rows.caret()?;
        let visual_row = self.caret_visual_row()?;
        let visible = self.visible_row_range();
        if !visible.contains(&visual_row) {
            return None;
        }
        let line = self.visual_projection.line(self.rows, visual_row)?;
        let row = self.rows.row(line.row_index)?;
        let text = row.text?;
        let layout = self.layout();
        let cell_width = self.style.cell_width();
        let row_height = self.style.row_height();
        let column = display_columns_until(text, caret.byte_offset.min(text.len()));
        let mut x = layout.content.origin.x
            + self.content_horizontal_padding
            + (column as isize - self.horizontal_origin_column(line) as isize) as f32 * cell_width;
        if let Some(composition) = self.rows.composition()
            && let zui::ui::TextInputCompositionCursor::Visible(cursor) = composition.cursor
        {
            x += display_columns_until(composition.text, cursor.end) as f32 * cell_width;
        }
        Some(Rect::from_xywh(
            x,
            layout.body.origin.y + (visual_row - visible.start) as f32 * row_height,
            match self.caret_style {
                CodeEditorCaretStyle::Bar => BAR_CARET_WIDTH,
                CodeEditorCaretStyle::Block => cell_width,
            },
            row_height,
        ))
    }

    pub(super) fn paint_selection(
        &self,
        scene: &mut UiScene,
        bounds: Rect,
        row_index: usize,
        text: &str,
        origin_column: usize,
    ) {
        let Some(selection) = self.rows.selection() else {
            return;
        };
        if row_index < selection.start.row_index || row_index > selection.end.row_index {
            return;
        }
        let start = if row_index == selection.start.row_index {
            selection.start.byte_offset.min(text.len())
        } else {
            0
        };
        let end = if row_index == selection.end.row_index {
            selection.end.byte_offset.min(text.len())
        } else {
            text.len()
        };
        let start_column = display_columns_until(text, start);
        let end_column = display_columns_until(text, end);
        let cell_width = self.style.cell_width();
        let width = (end_column - start_column) as f32 * cell_width
            + if row_index < selection.end.row_index {
                cell_width
            } else {
                0.0
            };
        if width <= 0.0 {
            return;
        }
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(
                bounds.origin.x
                    + self.content_horizontal_padding
                    + (start_column as isize - origin_column as isize) as f32 * cell_width,
                bounds.origin.y,
                width,
                self.style.row_height(),
            ),
            self.style.selection(),
        ));
    }

    pub(super) fn paint_inline_highlights(
        &self,
        scene: &mut UiScene,
        bounds: Rect,
        text: &str,
        highlights: &[CodeEditorInlineHighlight],
        origin_column: usize,
    ) {
        for highlight in highlights {
            if highlight.range.is_empty()
                || highlight.range.end > text.len()
                || !text.is_char_boundary(highlight.range.start)
                || !text.is_char_boundary(highlight.range.end)
            {
                continue;
            }
            let start = display_columns_until(text, highlight.range.start);
            let end = display_columns_until(text, highlight.range.end);
            if end <= start {
                continue;
            }
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(
                    bounds.origin.x
                        + self.content_horizontal_padding
                        + (start as isize - origin_column as isize) as f32
                            * self.style.cell_width(),
                    bounds.origin.y,
                    (end - start) as f32 * self.style.cell_width(),
                    self.style.row_height(),
                ),
                highlight.color,
            ));
        }
    }

    pub(super) fn paint_code_text(
        &self,
        scene: &mut UiScene,
        bounds: Rect,
        text: &str,
        tokens: &[CodeEditorSyntaxToken],
        origin_column: usize,
    ) {
        if text.is_empty() {
            return;
        }
        let cell_width = self.style.cell_width();
        let row_height = self.style.row_height();
        let origin = Point::new(
            bounds.origin.x + self.content_horizontal_padding - origin_column as f32 * cell_width,
            bounds.origin.y,
        );
        let block_size = Size::new((bounds.right() - origin.x).max(cell_width), row_height);
        let base_style = self.style.text_style().clone();
        let spans = self.syntax_spans(text, tokens);
        if spans.is_empty() {
            let text = expand_tabs(text);
            if has_wide_display_cells(&text) {
                let columns = display_columns(&text);
                paint_text_block(
                    scene,
                    text,
                    origin,
                    Size::new(columns as f32 * cell_width, row_height),
                    base_style,
                    cell_width,
                );
                return;
            }
            scene.draw_text(
                TextBlock::new(text, origin, block_size, base_style).with_wrap(TextBlockWrap::None),
            );
            return;
        }
        if spans.iter().any(|span| has_wide_display_cells(span.text())) {
            let mut column = 0;
            for span in spans {
                let columns = display_columns(span.text());
                paint_text_block(
                    scene,
                    span.text(),
                    Point::new(origin.x + column as f32 * cell_width, origin.y),
                    Size::new(columns as f32 * cell_width, row_height),
                    span.style().clone(),
                    cell_width,
                );
                column += columns;
            }
            return;
        }
        let block = TextBlock::from_spans(spans, origin, block_size, base_style);
        scene.draw_text(block.with_wrap(TextBlockWrap::None));
    }

    fn syntax_spans(&self, text: &str, tokens: &[CodeEditorSyntaxToken]) -> Vec<TextSpan> {
        let tokens = tokens
            .iter()
            .enumerate()
            .filter(|(_, token)| valid_syntax_token(text, token))
            .collect::<Vec<_>>();
        if tokens.is_empty() {
            return Vec::new();
        }
        let mut boundaries = Vec::with_capacity(tokens.len() * 2 + 2);
        boundaries.extend([0, text.len()]);
        for (_, token) in &tokens {
            boundaries.extend([token.range.start, token.range.end]);
        }
        boundaries.sort_unstable();
        boundaries.dedup();

        let mut starts = (0..tokens.len()).collect::<Vec<_>>();
        starts.sort_unstable_by_key(|index| {
            let (order, token) = tokens[*index];
            (token.range.start, order)
        });
        let mut next_start = 0;
        let mut active = BinaryHeap::new();
        let mut column = 0;
        let mut runs: Vec<(String, Option<super::CodeEditorTokenRole>)> = Vec::new();
        for interval in boundaries.windows(2) {
            let start = interval[0];
            let end = interval[1];
            while next_start < starts.len() && tokens[starts[next_start]].1.range.start <= start {
                let token_index = starts[next_start];
                active.push((tokens[token_index].0, token_index));
                next_start += 1;
            }
            while active
                .peek()
                .is_some_and(|(_, index)| tokens[*index].1.range.end <= start)
            {
                active.pop();
            }
            let role = active.peek().map(|(_, index)| tokens[*index].1.role);
            let (fragment, next_column) = expand_tabs_at_column(&text[start..end], column);
            column = next_column;
            if fragment.is_empty() {
                continue;
            }
            if let Some((previous, previous_role)) = runs.last_mut()
                && *previous_role == role
            {
                previous.push_str(&fragment);
            } else {
                runs.push((fragment, role));
            }
        }
        runs.into_iter()
            .map(|(text, role)| {
                let style = role.map_or_else(
                    || self.style.text_style().clone(),
                    |role| self.style.text_with_color(self.style.syntax_color(role)),
                );
                TextSpan::new(text, style)
            })
            .collect()
    }

    pub(super) fn paint_composition_and_caret(
        &self,
        scene: &mut UiScene,
        bounds: Rect,
        row_index: usize,
        visual_row: usize,
        text: &str,
        origin_column: usize,
    ) {
        let Some(caret) = self.rows.caret().filter(|caret| {
            caret.row_index == row_index && self.caret_visual_row() == Some(visual_row)
        }) else {
            return;
        };
        let cell_width = self.style.cell_width();
        let row_height = self.style.row_height();
        let column = display_columns_until(text, caret.byte_offset.min(text.len()));
        let base_x = bounds.origin.x
            + self.content_horizontal_padding
            + (column as isize - origin_column as isize) as f32 * cell_width;
        let mut caret_x = base_x;
        if let Some(composition) = self.rows.composition() {
            let width = display_columns(composition.text) as f32 * cell_width;
            paint_text_block(
                scene,
                expand_tabs(composition.text),
                Point::new(base_x, bounds.origin.y),
                Size::new(width, row_height),
                self.style.text_style().clone(),
                cell_width,
            );
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(base_x, bounds.bottom() - 1.0, width.max(cell_width), 1.0),
                self.style.composition_underline(),
            ));
            if let zui::ui::TextInputCompositionCursor::Visible(cursor) = composition.cursor {
                caret_x += display_columns_until(composition.text, cursor.end) as f32 * cell_width;
            }
        }
        if self.caret_visibility == zui::ui::CaretVisibility::Visible {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(
                    caret_x,
                    bounds.origin.y,
                    match self.caret_style {
                        CodeEditorCaretStyle::Bar => BAR_CARET_WIDTH,
                        CodeEditorCaretStyle::Block => cell_width,
                    },
                    row_height,
                ),
                self.style.caret(),
            ));
        }
    }

    pub(super) fn paint_ghost_text(
        &self,
        scene: &mut UiScene,
        bounds: Rect,
        row_index: usize,
        visual_row: usize,
        text: &str,
        origin_column: usize,
    ) {
        let Some(ghost_text) = self
            .ghost_text
            .and_then(|text| text.split(['\r', '\n']).next())
            .filter(|text| !text.is_empty())
        else {
            return;
        };
        if self.rows.composition().is_some()
            || self
                .rows
                .selection()
                .is_some_and(|selection| selection.start != selection.end)
        {
            return;
        }
        let Some(caret) = self.rows.caret().filter(|caret| {
            caret.row_index == row_index && self.caret_visual_row() == Some(visual_row)
        }) else {
            return;
        };
        let cell_width = self.style.cell_width();
        let column = display_columns_until(text, caret.byte_offset.min(text.len()));
        let x = bounds.origin.x
            + self.content_horizontal_padding
            + (column as isize - origin_column as isize) as f32 * cell_width;
        paint_text_block(
            scene,
            expand_tabs(ghost_text),
            Point::new(x, bounds.origin.y),
            Size::new(
                display_columns(ghost_text) as f32 * cell_width,
                self.style.row_height(),
            ),
            self.style.muted_text_style(),
            cell_width,
        );
    }
}

fn valid_syntax_token(text: &str, token: &CodeEditorSyntaxToken) -> bool {
    !token.range.is_empty()
        && token.range.end <= text.len()
        && text.is_char_boundary(token.range.start)
        && text.is_char_boundary(token.range.end)
}

mod scroll;

pub(crate) use scroll::ChatHistoryScroll;
pub(crate) use scroll::TranscriptScrollAnchor;
pub(crate) use scroll::TranscriptScrollDirection;
pub(crate) use scroll::TranscriptScrollTarget;

use super::CellView;
use super::ChatHistoryRenderCache;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::Renderable;
use crate::render::interaction_style;
use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
#[cfg(test)]
use ratatui::text::Line;
use unicode_width::UnicodeWidthStr;

pub(crate) struct ChatHistoryView<'a> {
    pub(crate) jump_label: &'a str,
    pub(crate) header: Option<&'a Buffer>,
    pub(crate) messages: &'a [CellView<'a>],
    pub(crate) scroll: &'a ChatHistoryScroll,
    pub(crate) render_cache: &'a ChatHistoryRenderCache,
    pub(crate) pointer: ChatHistoryPointerState<'a>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChatHistoryPointerTarget {
    JumpToBottom,
    Toggle(String),
    Details(String),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ChatHistoryPointerState<'a> {
    pub(crate) hovered_jump_to_bottom: bool,
    pub(crate) hovered_toggle: Option<&'a str>,
    pub(crate) hovered_details: Option<&'a str>,
    pub(crate) pressed_jump_to_bottom: bool,
    pub(crate) pressed_toggle: Option<&'a str>,
    pub(crate) pressed_details: Option<&'a str>,
}

impl Renderable for ChatHistoryView<'_> {
    fn desired_height(&self, width: u16, context: RenderContext<'_>) -> u16 {
        let message_rows = measured_heights(self.messages, self.render_cache, width, context)
            .into_iter()
            .sum::<usize>();
        header_rows(self.header)
            .saturating_add(message_rows)
            .min(u16::MAX as usize) as u16
    }

    fn render(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        let heights = measured_heights(self.messages, self.render_cache, area.width, context);
        let header_rows = header_rows(self.header);
        let (content_area, _) = scroll_areas(area, header_rows, &heights, self.scroll);
        let total_rows = header_rows.saturating_add(heights.iter().sum::<usize>());
        let bottom_offset = total_rows.saturating_sub(usize::from(content_area.height));
        let viewport_start = viewport_offset(
            self.messages,
            header_rows,
            &heights,
            self.scroll,
            bottom_offset,
        );
        render_header(
            frame.buffer_mut(),
            content_area,
            self.header,
            viewport_start,
        );
        render_cells(
            frame,
            content_area,
            header_rows,
            viewport_start,
            self.messages,
            &heights,
            self.render_cache,
            self.pointer,
            context,
        );
        render_jump_to_bottom(
            frame,
            self.jump_area(area, context),
            self.jump_label,
            self.pointer,
            context,
        );
    }
}

impl ChatHistoryView<'_> {
    pub(crate) fn jump_area(&self, area: Rect, context: RenderContext<'_>) -> Option<Rect> {
        let heights = measured_heights(self.messages, self.render_cache, area.width, context);
        let mut target =
            jump_to_bottom_area(area, header_rows(self.header), &heights, self.scroll)?;
        let width = self.jump_label.width().min(usize::from(area.width)) as u16;
        target.x = area.x + (area.width - width) / 2;
        target.width = width;
        Some(target)
    }

    pub(crate) fn pointer_target_at(
        &self,
        area: Rect,
        position: ratatui::layout::Position,
        context: RenderContext<'_>,
    ) -> Option<ChatHistoryPointerTarget> {
        if self
            .jump_area(area, context)
            .is_some_and(|target| target.contains(position))
        {
            return Some(ChatHistoryPointerTarget::JumpToBottom);
        }
        let heights = measured_heights(self.messages, self.render_cache, area.width, context);
        let header_rows = header_rows(self.header);
        let (content_area, _) = scroll_areas(area, header_rows, &heights, self.scroll);
        if !content_area.contains(position) {
            return None;
        }
        let total_rows = header_rows.saturating_add(heights.iter().sum::<usize>());
        let bottom_offset = total_rows.saturating_sub(usize::from(content_area.height));
        let viewport_start = viewport_offset(
            self.messages,
            header_rows,
            &heights,
            self.scroll,
            bottom_offset,
        );
        let logical_row = viewport_start.saturating_add(usize::from(position.y - content_area.y));
        let mut cell_start = header_rows;
        for (cell, height) in self.messages.iter().zip(heights) {
            let cell_end = cell_start.saturating_add(height);
            if logical_row < cell_start || logical_row >= cell_end {
                cell_start = cell_end;
                continue;
            }
            let cell_id = cell.cell_id.as_ref()?;
            if cell.can_expand && logical_row == cell_start && position.x == content_area.x {
                return Some(ChatHistoryPointerTarget::Toggle(cell_id.clone()));
            }
            let details_row = self
                .render_cache
                .measure(cell, area.width, context, || {
                    cell.lines(context, Some(self.render_cache), area.width)
                })
                .details_row;
            if cell.has_details
                && details_row.is_some_and(|row| logical_row == cell_start.saturating_add(row))
                && position.x >= content_area.x
                && position.x
                    < content_area
                        .x
                        .saturating_add(("   view full".len() as u16).min(content_area.width))
            {
                return Some(ChatHistoryPointerTarget::Details(cell_id.clone()));
            }
            return None;
        }
        None
    }
}

pub(crate) fn scroll_target(
    area: Rect,
    header_rows: usize,
    messages: &[CellView<'_>],
    scroll: &ChatHistoryScroll,
    render_cache: &ChatHistoryRenderCache,
    context: RenderContext<'_>,
    direction: TranscriptScrollDirection,
    rows: usize,
) -> Option<TranscriptScrollTarget> {
    let heights = measured_heights(messages, render_cache, area.width, context);
    let (content_area, _) = scroll_areas(area, header_rows, &heights, scroll);
    let bottom_offset = header_rows
        .saturating_add(heights.iter().sum::<usize>())
        .saturating_sub(usize::from(content_area.height));
    let current = viewport_offset(messages, header_rows, &heights, scroll, bottom_offset);
    let target = match direction {
        TranscriptScrollDirection::Up => current.saturating_sub(rows),
        TranscriptScrollDirection::Down => current.saturating_add(rows),
    };
    if target >= bottom_offset {
        return scroll
            .anchor()
            .is_some()
            .then_some(TranscriptScrollTarget::FollowLatest);
    }
    if target == current {
        return None;
    }
    anchor_at(messages, header_rows, &heights, target).map(TranscriptScrollTarget::Anchor)
}

pub(crate) fn first_scroll_target(
    has_header: bool,
    messages: &[CellView<'_>],
) -> Option<TranscriptScrollTarget> {
    if has_header {
        return Some(TranscriptScrollTarget::Anchor(
            TranscriptScrollAnchor::Header { line_offset: 0 },
        ));
    }
    messages.iter().find_map(|cell| {
        cell.cell_id.as_ref().map(|cell_id| {
            TranscriptScrollTarget::Anchor(TranscriptScrollAnchor::Cell {
                cell_id: cell_id.clone(),
                line_offset: 0,
            })
        })
    })
}

fn jump_to_bottom_area(
    area: Rect,
    header_rows: usize,
    heights: &[usize],
    scroll: &ChatHistoryScroll,
) -> Option<Rect> {
    if area.width == 0 || area.height == 0 {
        return None;
    }
    let total_rows = header_rows.saturating_add(heights.iter().sum::<usize>());
    let bottom_offset = total_rows.saturating_sub(usize::from(area.height));
    if bottom_offset == 0 || scroll.anchor().is_none() {
        return None;
    }
    let width = area.width;
    let x = area.x.saturating_add((area.width - width) / 2);
    Some(Rect::new(x, area.bottom().saturating_sub(1), width, 1))
}

fn scroll_areas(
    area: Rect,
    header_rows: usize,
    heights: &[usize],
    scroll: &ChatHistoryScroll,
) -> (Rect, Option<Rect>) {
    let jump_area = jump_to_bottom_area(area, header_rows, heights, scroll);
    let content_area = if jump_area.is_some() {
        Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1))
    } else {
        area
    };
    (content_area, jump_area)
}

fn viewport_offset(
    messages: &[CellView<'_>],
    header_rows: usize,
    heights: &[usize],
    scroll: &ChatHistoryScroll,
    bottom_offset: usize,
) -> usize {
    let Some(anchor) = scroll.anchor() else {
        return bottom_offset;
    };
    if let TranscriptScrollAnchor::Header { line_offset } = anchor {
        return (*line_offset)
            .min(header_rows.saturating_sub(1))
            .min(bottom_offset);
    }
    let TranscriptScrollAnchor::Cell {
        cell_id,
        line_offset,
    } = anchor
    else {
        unreachable!();
    };
    let mut start = header_rows;
    for (cell, height) in messages.iter().zip(heights) {
        if cell.cell_id.as_deref() == Some(cell_id.as_str()) {
            return start
                .saturating_add((*line_offset).min(height.saturating_sub(1)))
                .min(bottom_offset);
        }
        start = start.saturating_add(*height);
    }
    bottom_offset
}

fn anchor_at(
    messages: &[CellView<'_>],
    header_rows: usize,
    heights: &[usize],
    target: usize,
) -> Option<TranscriptScrollAnchor> {
    if target < header_rows {
        return Some(TranscriptScrollAnchor::Header {
            line_offset: target,
        });
    }
    let mut start = header_rows;
    for (index, (cell, height)) in messages.iter().zip(heights).enumerate() {
        let end = start.saturating_add(*height);
        if target < end {
            let line_offset = target.saturating_sub(start);
            if line_offset == height.saturating_sub(1)
                && let Some(cell_id) = messages
                    .get(index.saturating_add(1))
                    .and_then(|cell| cell.cell_id.as_ref())
            {
                return Some(TranscriptScrollAnchor::Cell {
                    cell_id: cell_id.clone(),
                    line_offset: 0,
                });
            }
            return cell
                .cell_id
                .as_ref()
                .map(|cell_id| TranscriptScrollAnchor::Cell {
                    cell_id: cell_id.clone(),
                    line_offset: line_offset.min(height.saturating_sub(2)),
                });
        }
        start = end;
    }
    None
}

fn render_jump_to_bottom(
    frame: &mut Frame<'_>,
    area: Option<Rect>,
    label: &str,
    pointer: ChatHistoryPointerState<'_>,
    context: RenderContext<'_>,
) {
    let Some(area) = area else {
        return;
    };
    let style = if pointer.hovered_jump_to_bottom || pointer.pressed_jump_to_bottom {
        interaction_style(
            context,
            InteractionState {
                target: InteractionTarget::Rest,
                hovered: pointer.hovered_jump_to_bottom,
                pressed: pointer.pressed_jump_to_bottom,
                ..Default::default()
            },
        )
    } else {
        Style::default()
            .fg(context.foreground())
            .bg(context.transcript_jump_background())
    };
    frame
        .buffer_mut()
        .set_stringn(area.x, area.y, label, usize::from(area.width), style);
}

#[cfg(test)]
fn message_lines<'a>(messages: &'a [CellView<'_>], context: RenderContext<'_>) -> Vec<Line<'a>> {
    messages
        .iter()
        .flat_map(|cell| cell.lines(context, None, 80).lines)
        .collect()
}

fn measured_heights(
    messages: &[CellView<'_>],
    cache: &ChatHistoryRenderCache,
    width: u16,
    context: RenderContext<'_>,
) -> Vec<usize> {
    cache.retain_cells(messages);
    messages
        .iter()
        .map(|cell| {
            cache
                .measure(cell, width, context, || {
                    cell.lines(context, Some(cache), width)
                })
                .height
        })
        .collect()
}

fn header_rows(header: Option<&Buffer>) -> usize {
    header.map_or(0, |buffer| usize::from(buffer.area.height))
}

fn render_header(target: &mut Buffer, area: Rect, header: Option<&Buffer>, viewport_start: usize) {
    let Some(header) = header else {
        return;
    };
    let header_rows = usize::from(header.area.height);
    let viewport_end = viewport_start.saturating_add(usize::from(area.height));
    let visible_start = viewport_start.min(header_rows);
    let visible_end = viewport_end.min(header_rows);
    if visible_start >= visible_end {
        return;
    }
    let target_y = area.y;
    let target_height = u16::try_from(visible_end - visible_start).unwrap_or(area.height);
    let width = area.width.min(header.area.width);
    for row in 0..target_height {
        let source_y = visible_start.saturating_add(usize::from(row)) as u16;
        for column in 0..width {
            let Some(source) = header.cell((column, source_y)) else {
                continue;
            };
            if let Some(destination) = target.cell_mut((area.x + column, target_y + row)) {
                *destination = source.clone();
            }
        }
    }
}

fn render_cells(
    frame: &mut Frame<'_>,
    area: Rect,
    header_rows: usize,
    viewport_start: usize,
    messages: &[CellView<'_>],
    heights: &[usize],
    cache: &ChatHistoryRenderCache,
    pointer: ChatHistoryPointerState<'_>,
    context: RenderContext<'_>,
) {
    let viewport_end = viewport_start.saturating_add(usize::from(area.height));
    let mut cell_start = header_rows;
    for (cell, height) in messages.iter().zip(heights) {
        let cell_end = cell_start.saturating_add(*height);
        let visible_start = cell_start.max(viewport_start);
        let visible_end = cell_end.min(viewport_end);
        if visible_start < visible_end {
            let target_y = area
                .y
                .saturating_add((visible_start - viewport_start) as u16);
            let target_height = (visible_end - visible_start) as u16;
            let source_row = visible_start - cell_start;
            let prepared = cache.prepare(cell, area.width, context, || {
                cell.lines(context, Some(cache), area.width)
            });
            prepared.render(
                frame.buffer_mut(),
                Rect::new(area.x, target_y, area.width, target_height),
                source_row,
            );
            if let Some(links) = context.hyperlinks() {
                prepared.place_links(
                    &mut links.borrow_mut(),
                    Rect::new(area.x, target_y, area.width, target_height),
                    source_row,
                );
            }
            render_pointer_feedback(
                frame,
                area,
                cell,
                cell_start,
                cache
                    .measure(cell, area.width, context, || {
                        cell.lines(context, Some(cache), area.width)
                    })
                    .details_row,
                viewport_start,
                pointer,
                context,
            );
        }
        cell_start = cell_end;
        if cell_start >= viewport_end {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn render_pointer_feedback(
    frame: &mut Frame<'_>,
    area: Rect,
    cell: &CellView<'_>,
    cell_start: usize,
    details_row: Option<usize>,
    viewport_start: usize,
    pointer: ChatHistoryPointerState<'_>,
    context: RenderContext<'_>,
) {
    let Some(cell_id) = cell.cell_id.as_deref() else {
        return;
    };
    let toggle_hovered = pointer.hovered_toggle == Some(cell_id);
    let toggle_pressed = pointer.pressed_toggle == Some(cell_id);
    if cell.can_expand && (toggle_hovered || toggle_pressed) {
        render_action_feedback(
            frame,
            area,
            cell_start,
            viewport_start,
            1,
            toggle_hovered,
            toggle_pressed,
            context,
        );
    }
    let details_hovered = pointer.hovered_details == Some(cell_id);
    let details_pressed = pointer.pressed_details == Some(cell_id);
    if let Some(details_row) = details_row
        && (details_hovered || details_pressed)
    {
        render_action_feedback(
            frame,
            area,
            cell_start.saturating_add(details_row),
            viewport_start,
            "   view full".len() as u16,
            details_hovered,
            details_pressed,
            context,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn render_action_feedback(
    frame: &mut Frame<'_>,
    area: Rect,
    logical_row: usize,
    viewport_start: usize,
    width: u16,
    hovered: bool,
    pressed: bool,
    context: RenderContext<'_>,
) {
    let Some(row) = logical_row.checked_sub(viewport_start) else {
        return;
    };
    if row >= usize::from(area.height) {
        return;
    }
    let style = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Rest,
            selected: false,
            hovered,
            pressed,
        },
    )
    .add_modifier(Modifier::BOLD);
    frame.buffer_mut().set_style(
        Rect::new(
            area.x,
            area.y.saturating_add(row as u16),
            width.min(area.width),
            1,
        ),
        style,
    );
}

#[cfg(test)]
#[path = "view/render_tests.rs"]
mod tests;

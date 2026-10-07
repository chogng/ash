mod layout;
mod scroll;
use super::history_cell::CellLayout;
use layout::TranscriptLayout;

pub(crate) use scroll::ChatHistoryScroll;
pub(crate) use scroll::TranscriptScrollAnchor;
pub(crate) use scroll::TranscriptScrollDirection;
pub(crate) use scroll::TranscriptScrollTarget;

use super::CellView;
use super::ChatHistoryRenderCache;
use super::message_response::ResponseAction;
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
        let message_rows = self
            .measure_cells(width, context)
            .into_iter()
            .map(|cell| cell.height)
            .sum::<usize>();
        header_rows(self.header)
            .saturating_add(message_rows)
            .min(u16::MAX as usize) as u16
    }

    fn render(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        let layout = self.layout(area, context);
        render_header(
            frame.buffer_mut(),
            layout.content,
            self.header,
            layout.viewport_start,
        );
        render_cells(
            frame,
            &layout,
            self.messages,
            self.render_cache,
            self.pointer,
            context,
        );
        render_jump_to_bottom(frame, layout.jump, self.jump_label, self.pointer, context);
    }
}

impl ChatHistoryView<'_> {
    fn measure_cells(&self, width: u16, context: RenderContext<'_>) -> Vec<CellLayout> {
        measure_cells(self.messages, self.render_cache, width, context)
    }

    fn layout(&self, area: Rect, context: RenderContext<'_>) -> TranscriptLayout {
        TranscriptLayout::new(
            area,
            header_rows(self.header),
            self.messages,
            self.scroll,
            self.measure_cells(area.width, context),
            self.jump_label,
        )
    }

    pub(crate) fn scroll_target(
        &self,
        area: Rect,
        context: RenderContext<'_>,
        direction: TranscriptScrollDirection,
        rows: usize,
    ) -> Option<TranscriptScrollTarget> {
        self.layout(area, context)
            .scroll_target(self.messages, direction, rows)
    }

    pub(crate) fn pointer_target_at(
        &self,
        area: Rect,
        position: ratatui::layout::Position,
        context: RenderContext<'_>,
    ) -> Option<ChatHistoryPointerTarget> {
        let layout = self.layout(area, context);
        if layout.jump.is_some_and(|target| target.contains(position)) {
            return Some(ChatHistoryPointerTarget::JumpToBottom);
        }
        let content_area = layout.content;
        let viewport_start = layout.viewport_start;
        if !content_area.contains(position) {
            return None;
        }
        let logical_row = viewport_start.saturating_add(usize::from(position.y - content_area.y));
        let mut cell_start = layout.header_rows;
        for (cell, measured) in self.messages.iter().zip(&layout.cells) {
            let height = measured.height;
            let cell_end = cell_start.saturating_add(height);
            if logical_row < cell_start || logical_row >= cell_end {
                cell_start = cell_end;
                continue;
            }
            let cell_id = cell.cell_id.as_ref()?;
            if cell.can_expand && logical_row == cell_start && position.x == content_area.x {
                return Some(ChatHistoryPointerTarget::Toggle(cell_id.clone()));
            }
            let details_action = &measured.details_action;
            if cell.has_details
                && details_action.as_ref().is_some_and(|action| {
                    action.contains(logical_row - cell_start, position.x - content_area.x)
                })
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
    TranscriptLayout::new(
        area,
        header_rows,
        messages,
        scroll,
        measure_cells(messages, render_cache, area.width, context),
        "",
    )
    .scroll_target(messages, direction, rows)
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

fn measure_cells(
    messages: &[CellView<'_>],
    cache: &ChatHistoryRenderCache,
    width: u16,
    context: RenderContext<'_>,
) -> Vec<CellLayout> {
    cache.retain_cells(messages);
    messages
        .iter()
        .map(|cell| {
            cache.measure(cell, width, context, || {
                cell.lines(context, Some(cache), width)
            })
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
    layout: &TranscriptLayout,
    messages: &[CellView<'_>],
    cache: &ChatHistoryRenderCache,
    pointer: ChatHistoryPointerState<'_>,
    context: RenderContext<'_>,
) {
    let area = layout.content;
    let viewport_start = layout.viewport_start;
    let viewport_end = viewport_start.saturating_add(usize::from(area.height));
    let mut cell_start = layout.header_rows;
    for (cell, measured) in messages.iter().zip(&layout.cells) {
        let cell_end = cell_start.saturating_add(measured.height);
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
                measured.details_action.clone(),
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
    details_action: Option<ResponseAction>,
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
    if let Some(action) = details_action
        && (details_hovered || details_pressed)
    {
        for row in action.rows {
            render_action_feedback(
                frame,
                area,
                cell_start.saturating_add(row.row),
                viewport_start,
                row.width,
                details_hovered,
                details_pressed,
                context,
            );
        }
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

use super::ListSelectionState;
use super::state::ListSelectionItem;
use crate::render::RenderContext;
use crate::render::line_to_borrowed;
use crate::render::selection_marker;
use crate::widgets::search_box;
use crate::widgets::search_box::SEARCH_BOX_HEIGHT;
use crate::widgets::tab_list;
use ratatui::Frame;
use ratatui::layout::Constraint;
use ratatui::layout::Direction;
use ratatui::layout::Layout;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthStr;

const ITEM_STATE_COLUMN_WIDTH: u16 = 2;
const ITEM_COLUMN_GAP: u16 = 4;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ListSelectionPointerTarget {
    Tab(usize),
    Action,
    Search,
    Item(super::ListSelectionItemId),
}

pub(crate) fn pointer_target_at(
    view: &ListSelectionState,
    tabs: Rect,
    body: Rect,
    position: ratatui::layout::Position,
) -> Option<ListSelectionPointerTarget> {
    if view.show_tabs()
        && let Some(index) = tab_list::index_at(view.tabs(), tabs, position)
    {
        return Some(ListSelectionPointerTarget::Tab(index));
    }
    if view.action().is_some_and(|action| action.id().is_some())
        && with_state_column(action_area(body)).contains(position)
    {
        return Some(ListSelectionPointerTarget::Action);
    }
    let areas = body_areas(body, view);
    if view.search().is_some() && areas[0].contains(position) {
        return Some(ListSelectionPointerTarget::Search);
    }
    let viewport = view.viewport(areas[1]);
    if !with_state_column(viewport.items).contains(position) {
        return None;
    }
    let rows = view.item_rows(areas[1].width);
    let (index, detail) = *rows.get(viewport.start + usize::from(position.y - viewport.items.y))?;
    if detail > 0 {
        return None;
    }
    view.visible_items()
        .get(index)
        .and_then(|item| item.id())
        .cloned()
        .map(ListSelectionPointerTarget::Item)
}

pub(crate) fn draw_tabs(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &ListSelectionState,
    hovered_tab: Option<usize>,
    pressed_tab: Option<usize>,
    context: RenderContext<'_>,
) {
    if !view.show_tabs() {
        return;
    }
    tab_list::draw(
        frame,
        area,
        view.tab_list(),
        view.tabs_focused(),
        hovered_tab,
        pressed_tab,
        context,
    );
}

pub(crate) fn draw_body_with_pointer(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &ListSelectionState,
    hovered: Option<&ListSelectionPointerTarget>,
    pressed: Option<&ListSelectionPointerTarget>,
    context: RenderContext<'_>,
) {
    if area.is_empty() {
        return;
    }
    if let Some(action) = view.action() {
        let selected = view.action_focused();
        let style = crate::render::interaction_style(
            context,
            crate::render::InteractionState {
                target: if action.id().is_some() {
                    crate::render::InteractionTarget::Rest
                } else {
                    crate::render::InteractionTarget::Disabled
                },
                selected,
                hovered: hovered == Some(&ListSelectionPointerTarget::Action),
                pressed: pressed == Some(&ListSelectionPointerTarget::Action),
            },
        );
        frame.render_widget(
            Paragraph::new(format!("{}{}", selection_marker(selected), action.label()))
                .style(style),
            with_state_column(action_area(area)),
        );
    }
    let areas = body_areas(area, view);

    if let Some(search) = view.search() {
        search_box::draw(
            frame,
            areas[0],
            search,
            hovered == Some(&ListSelectionPointerTarget::Search),
            pressed == Some(&ListSelectionPointerTarget::Search),
            context,
        );
    }

    let visible_items = view.visible_items();
    if let Some(message) = view.message() {
        frame.render_widget(
            Paragraph::new(message).style(Style::default().fg(context.muted())),
            areas[3],
        );
    }
    let viewport = view.viewport(areas[1]);
    if visible_items.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                view.empty_message(),
                Style::default().fg(context.muted()),
            ))),
            areas[1],
        );
    } else {
        let list_area = with_state_column(areas[1]);
        let column_layout = ItemColumnLayout::new(list_area.width, &visible_items);
        let rows = view.item_rows(areas[1].width);
        for (row, &(index, detail)) in rows
            .iter()
            .skip(viewport.start)
            .take(viewport.end - viewport.start)
            .enumerate()
        {
            let item = visible_items[index];
            let selected = view.selected_visible_index() == Some(index) && !view.action_focused();
            let row_area = Rect::new(
                list_area.x,
                viewport.items.y + row as u16,
                list_area.width,
                1,
            );
            if detail > 0 {
                if item.section_divider() {
                    continue;
                }
                let description = item.detail().unwrap_or_default();
                frame.render_widget(
                    Paragraph::new(description)
                        .wrap(ratatui::widgets::Wrap { trim: false })
                        .scroll(((detail - 1) as u16, 0))
                        .style(Style::default().fg(context.muted())),
                    Rect::new(
                        areas[1].x + 2,
                        row_area.y,
                        areas[1].width.saturating_sub(2),
                        1,
                    ),
                );
                continue;
            }
            draw_item(
                frame,
                row_area,
                item,
                selected,
                selected && view.items_focused(),
                matches!(hovered, Some(ListSelectionPointerTarget::Item(id)) if item.id() == Some(id)),
                matches!(pressed, Some(ListSelectionPointerTarget::Item(id)) if item.id() == Some(id)),
                column_layout,
                view.expandable().then_some(view.expanded(item)),
                context,
            );
        }
        for (area, count, position) in [
            (viewport.above, viewport.start, "above"),
            (viewport.below, rows.len() - viewport.end, "below"),
        ] {
            if !area.is_empty() {
                frame.render_widget(
                    Paragraph::new(format!(
                        "{count} {} {}",
                        context.localize("more"),
                        context.localize(position)
                    ))
                    .style(Style::default().fg(context.muted())),
                    area,
                );
            }
        }
    }
    if let Some(item) = view.selected_item()
        && let Some(preview) = item.preview()
    {
        let caption_height = u16::from(preview.caption().is_some());
        let top_margin = preview.top_margin().min(u16::MAX as usize) as u16;
        let line_height = preview.lines().len().min(u16::MAX as usize) as u16;
        let bottom_margin = preview.bottom_margin().min(u16::MAX as usize) as u16;
        let preview_areas = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(top_margin),
                Constraint::Length(1),
                Constraint::Length(line_height),
                Constraint::Length(1),
                Constraint::Length(caption_height),
                Constraint::Length(bottom_margin),
            ])
            .split(areas[2]);
        let separator_color = preview.separator_color().unwrap_or_else(|| context.muted());
        frame.render_widget(
            Paragraph::new(dashed_rule(
                preview_areas[1].width,
                Some(preview.title()),
                separator_color,
            )),
            preview_areas[1],
        );
        for (offset, line) in preview
            .lines()
            .iter()
            .take(usize::from(preview_areas[2].height))
            .enumerate()
        {
            let row = Rect::new(
                preview_areas[2].x,
                preview_areas[2].y.saturating_add(offset as u16),
                preview_areas[2].width,
                1,
            );
            frame.render_widget(Block::default().style(line.style), row);
            frame.render_widget(Paragraph::new(line_to_borrowed(line)), row);
        }
        frame.render_widget(
            Paragraph::new(dashed_rule(preview_areas[3].width, None, separator_color)),
            preview_areas[3],
        );
        if let Some(caption) = preview.caption() {
            frame.render_widget(Paragraph::new(line_to_borrowed(caption)), preview_areas[4]);
        }
    }
}

impl ListSelectionState {
    pub(crate) fn scroll(&mut self, area: Rect, lines: i16) -> bool {
        let list = body_areas(area, self)[1];
        let rows = self.item_rows(list.width);
        self.scroll_rows(list, &rows, lines).end == rows.len()
    }

    fn scroll_rows(&mut self, list: Rect, rows: &[(usize, usize)], lines: i16) -> ListViewport {
        if list.is_empty() || rows.len() <= usize::from(list.height) {
            return self.viewport_with_rows(list, rows);
        }
        let capacity = usize::from(if self.scroll_counts() {
            list.height.saturating_sub(2).max(1)
        } else {
            list.height
        });
        let start = self
            .viewport_with_rows(list, rows)
            .start
            .saturating_add_signed(isize::from(lines))
            .min(rows.len().saturating_sub(capacity));
        self.scroll_offset = Some(start);
        self.viewport_with_rows(list, rows)
    }

    /// Keep wheel movement tied to rendered rows while preventing activation of an offscreen item.
    pub(crate) fn scroll_with_selection(&mut self, area: Rect, lines: i16) {
        let list = body_areas(area, self)[1];
        let rows = self.item_rows(list.width);
        let viewport = self.scroll_rows(list, &rows, lines);
        let visible = &rows[viewport.start..viewport.end];
        if visible
            .iter()
            .any(|&(index, detail)| detail == 0 && self.selected_visible_index() == Some(index))
        {
            return;
        }
        let items = self.visible_items();
        let selectable = visible.iter().filter_map(|&(index, detail)| {
            (detail == 0 && items[index].id().is_some()).then_some(index)
        });
        let next = if lines > 0 {
            selectable.min()
        } else {
            selectable.max()
        };
        if let Some(index) = next {
            self.select_visible_item(index);
        } else {
            self.clear_visible_selection();
        }
    }

    fn viewport(&self, area: Rect) -> ListViewport {
        let rows = self.item_rows(area.width);
        self.viewport_with_rows(area, &rows)
    }

    fn viewport_with_rows(&self, area: Rect, rows: &[(usize, usize)]) -> ListViewport {
        if !self.scroll_counts() {
            let capacity = usize::from(area.height);
            let start = self
                .scroll_offset
                .unwrap_or_else(|| {
                    self.selected_visible_index()
                        .unwrap_or(0)
                        .saturating_sub(capacity.saturating_sub(1))
                })
                .min(rows.len().saturating_sub(capacity));
            return ListViewport {
                start,
                end: (start + capacity).min(rows.len()),
                items: area,
                above: Rect::default(),
                below: Rect::default(),
            };
        }
        if let Some(start) = self.scroll_offset {
            return ListViewport::scrolled(area, rows.len(), start);
        }
        let selected = self.selected_visible_index().and_then(|selected| {
            let first = rows.iter().position(|&(index, _)| index == selected)?;
            let last = rows.iter().rposition(|&(index, _)| index == selected)?;
            Some(last.min(first + usize::from(area.height.saturating_sub(3))))
        });
        ListViewport::new(area, rows.len(), selected)
    }

    pub(super) fn item_rows(&self, width: u16) -> Vec<(usize, usize)> {
        let mut rows = Vec::new();
        for (index, item) in self.visible_items().iter().enumerate() {
            if index > 0 && item.section_divider() {
                rows.push((index, 1));
            }
            rows.push((index, 0));
            if self.expandable() && self.expanded(item) {
                let description = item.detail().unwrap_or_default();
                if !description.is_empty() {
                    let paragraph =
                        Paragraph::new(description).wrap(ratatui::widgets::Wrap { trim: false });
                    for line in 1..=paragraph.line_count(width.saturating_sub(2).max(1)) {
                        rows.push((index, line));
                    }
                }
            }
        }
        rows
    }
}

struct ListViewport {
    start: usize,
    end: usize,
    items: Rect,
    above: Rect,
    below: Rect,
}

impl ListViewport {
    fn scrolled(area: Rect, count: usize, start: usize) -> Self {
        if area.height <= 1 {
            return Self::new(area, count, Some(start));
        }
        if count <= usize::from(area.height) {
            return Self::new(area, count, None);
        }
        let capacity = usize::from(area.height.saturating_sub(2).max(1));
        let start = start.min(count.saturating_sub(capacity));
        let above = u16::from(start > 0 && area.height > 1);
        let end =
            (start + usize::from(area.height.saturating_sub(above).saturating_sub(1))).min(count);
        let rows = (end - start) as u16;
        Self {
            start,
            end,
            items: Rect::new(area.x, area.y + above, area.width, rows),
            above: Rect::new(area.x, area.y, area.width, above),
            below: Rect::new(
                area.x,
                area.y + above + rows,
                area.width,
                u16::from(end < count && area.height > above + rows),
            ),
        }
    }

    fn new(area: Rect, count: usize, selected: Option<usize>) -> Self {
        let height = usize::from(area.height);
        let selected = selected.unwrap_or(0).min(count.saturating_sub(1));
        let (start, end) = if count <= height {
            (0, count)
        } else if height <= 1 {
            (selected, (selected + height).min(count))
        } else if selected < height - 1 {
            (0, height - 1)
        } else if selected >= count - (height - 1) {
            (count - (height - 1), count)
        } else {
            let capacity = height.saturating_sub(2).max(1);
            (selected + 1 - capacity, selected + 1)
        };
        let above_rows = u16::from(start > 0 && height > 1);
        let item_rows = (end - start) as u16;
        let below_rows = u16::from(end < count && area.height > above_rows + item_rows);
        Self {
            start,
            end,
            items: Rect::new(area.x, area.y + above_rows, area.width, item_rows),
            above: Rect::new(area.x, area.y, area.width, above_rows),
            below: Rect::new(
                area.x,
                area.y + above_rows + item_rows,
                area.width,
                below_rows,
            ),
        }
    }
}

fn with_state_column(area: Rect) -> Rect {
    let state_column_width = ITEM_STATE_COLUMN_WIDTH.min(area.x);
    Rect {
        x: area.x.saturating_sub(state_column_width),
        width: area.width.saturating_add(state_column_width),
        ..area
    }
}

fn action_area(content: Rect) -> Rect {
    Rect::new(content.x, content.y, content.width, content.height.min(1))
}

fn body_areas(mut content: Rect, view: &ListSelectionState) -> [Rect; 4] {
    if view.action().is_some() {
        let rows = content.height.min(2);
        content.y += rows;
        content.height -= rows;
    }
    let search_height = view.search().map(|_| SEARCH_BOX_HEIGHT).unwrap_or(0);
    let preview_height = view
        .selected_item()
        .and_then(|item| item.preview())
        .map(|preview| preview.desired_height())
        .unwrap_or_default()
        .min(u16::MAX as usize) as u16;
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(search_height),
            Constraint::Length(u16::from(view.message().is_some())),
            Constraint::Min(1),
            Constraint::Length(preview_height),
        ])
        .split(content);
    // Keep the list and preview indices stable for hit testing and scrolling.
    [areas[0], areas[2], areas[3], areas[1]]
}

#[derive(Clone, Copy)]
struct ItemColumnLayout {
    leading_width: u16,
    trailing_width: u16,
    gap: u16,
}

impl ItemColumnLayout {
    fn new(width: u16, items: &[&ListSelectionItem]) -> Self {
        let desired_leading = items
            .iter()
            .filter_map(|item| item.columns())
            .map(|columns| columns.leading.width().min(u16::MAX as usize) as u16)
            .max()
            .unwrap_or_default();
        let trailing_width = items
            .iter()
            .filter_map(|item| item.columns())
            .map(|columns| columns.trailing.width().min(u16::MAX as usize) as u16)
            .max()
            .unwrap_or_default()
            .min(width.saturating_sub(ITEM_STATE_COLUMN_WIDTH));
        let width_before_trailing = width
            .saturating_sub(ITEM_STATE_COLUMN_WIDTH)
            .saturating_sub(trailing_width);
        let gap = ITEM_COLUMN_GAP.min(width_before_trailing / 2);
        let leading_width = desired_leading.min(
            width_before_trailing
                .saturating_sub(gap.saturating_mul(2))
                .saturating_sub(1),
        );
        Self {
            leading_width,
            trailing_width,
            gap,
        }
    }
}

fn draw_item(
    frame: &mut Frame<'_>,
    area: Rect,
    item: &ListSelectionItem,
    selected: bool,
    show_marker: bool,
    hovered: bool,
    pressed: bool,
    column_layout: ItemColumnLayout,
    expanded: Option<bool>,
    context: RenderContext<'_>,
) {
    if item.section_heading() {
        let prefix = format!("  {} ", item.label());
        let label_style = Style::default()
            .fg(context.muted())
            .add_modifier(Modifier::BOLD);
        let heading = if item.section_divider() {
            Line::from(vec![
                Span::styled(prefix.clone(), label_style),
                Span::styled(
                    "─".repeat(usize::from(area.width).saturating_sub(prefix.width())),
                    Style::default().fg(context.muted()),
                ),
            ])
        } else {
            Line::from(Span::styled(format!("  {}", item.label()), label_style))
        };
        frame.render_widget(Paragraph::new(heading), area);
        return;
    }
    let row_style = item_style(context, selected, hovered, pressed);
    frame.render_widget(Block::default().style(row_style), area);
    let label_style = if selected && !pressed {
        item.selection_foreground()
            .map(|foreground| row_style.fg(foreground))
            .unwrap_or(row_style)
    } else if selected || hovered || pressed {
        row_style
    } else {
        row_style
    };
    let marker = expanded.filter(|_| item.detail().is_some()).map_or_else(
        || selection_marker(show_marker),
        |expanded| if expanded { "v " } else { "> " },
    );
    let marker_style = if selected {
        Style::default()
            .fg(context.foreground())
            .add_modifier(Modifier::BOLD)
    } else {
        label_style
    };
    let detail_style = if !selected && !hovered && !pressed {
        Style::default().fg(context.muted())
    } else {
        row_style
    };
    if expanded.is_some() {
        let value = item.columns().map_or("", |c| c.trailing.as_str());
        let value_width = (value.width() as u16).min(area.width);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(marker, marker_style),
                Span::styled(item.label(), label_style),
            ])),
            Rect::new(
                area.x,
                area.y,
                area.width.saturating_sub(value_width + 2),
                1,
            ),
        );
        frame.render_widget(
            Paragraph::new(value).style(detail_style),
            Rect::new(area.right() - value_width, area.y, value_width, 1),
        );
        return;
    }
    let Some(columns) = item.columns() else {
        let spans = item_spans(item, marker, marker_style, label_style, detail_style);
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
        return;
    };

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(marker, marker_style),
            Span::styled(columns.leading.as_str(), label_style),
        ])),
        Rect::new(
            area.x,
            area.y,
            ITEM_STATE_COLUMN_WIDTH.saturating_add(column_layout.leading_width),
            1,
        ),
    );

    let middle_x = area
        .x
        .saturating_add(ITEM_STATE_COLUMN_WIDTH)
        .saturating_add(column_layout.leading_width)
        .saturating_add(column_layout.gap);
    let trailing_x = area
        .x
        .saturating_add(area.width.saturating_sub(column_layout.trailing_width));
    let middle_width = trailing_x
        .saturating_sub(column_layout.gap)
        .saturating_sub(middle_x);
    frame.render_widget(
        Paragraph::new(Span::styled(columns.middle.as_str(), detail_style)),
        Rect::new(middle_x, area.y, middle_width, 1),
    );
    frame.render_widget(
        Paragraph::new(Span::styled(columns.trailing.as_str(), detail_style)),
        Rect::new(trailing_x, area.y, column_layout.trailing_width, 1),
    );
}

fn item_spans<'a>(
    item: &'a ListSelectionItem,
    marker: &'static str,
    marker_style: Style,
    label_style: Style,
    detail_style: Style,
) -> Vec<Span<'a>> {
    let Some(description) = item.description() else {
        return vec![
            Span::styled(marker, marker_style),
            Span::styled(item.label(), label_style),
        ];
    };
    vec![
        Span::styled(marker, marker_style),
        Span::styled(item.label(), label_style),
        Span::styled("  ·  ", detail_style),
        Span::styled(description, detail_style),
    ]
}

pub(crate) fn item_style(
    context: RenderContext<'_>,
    selected: bool,
    hovered: bool,
    pressed: bool,
) -> Style {
    if selected || hovered || pressed {
        return crate::render::interaction_style(
            context,
            crate::render::InteractionState {
                target: crate::render::InteractionTarget::Rest,
                selected,
                hovered,
                pressed,
            },
        );
    }
    Style::default().fg(context.muted())
}

fn dashed_rule(width: u16, title: Option<&str>, color: Color) -> Line<'static> {
    let width = usize::from(width);
    let prefix = title
        .map(|title| format!("╌╌ {title} "))
        .unwrap_or_default();
    let prefix = prefix.chars().take(width).collect::<String>();
    let remaining = width.saturating_sub(prefix.width());
    Line::from(Span::styled(
        format!("{prefix}{}", "╌".repeat(remaining)),
        Style::default().fg(color),
    ))
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;

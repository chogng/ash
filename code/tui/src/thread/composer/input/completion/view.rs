mod mention {
    use super::super::MentionPopupView;
    use super::super::mention::MentionMatchKind;
    use crate::render::RenderContext;
    use crate::render::bottom_anchored_area;
    use crate::render::horizontal_margin;
    use ratatui::Frame;
    use ratatui::layout::Rect;
    use ratatui::style::Modifier;
    use ratatui::style::Style;
    use ratatui::text::Line;
    use ratatui::text::Span;
    use ratatui::widgets::Paragraph;

    #[derive(Clone, Copy)]
    struct PopupLayout {
        area: Rect,
        first_path: usize,
        visible_rows: usize,
    }

    pub(crate) fn draw(
        frame: &mut Frame<'_>,
        area: Rect,
        popup: Option<MentionPopupView<'_>>,
        hovered: Option<usize>,
        pressed: Option<usize>,
        context: RenderContext<'_>,
    ) {
        let Some(popup) = popup else {
            return;
        };
        let Some(layout) = popup_layout(area, popup.matches.len(), popup.selected) else {
            return;
        };
        let lines = if popup.matches.is_empty() {
            vec![Line::from(Span::styled(
                if popup.searching {
                    "Searching files and plugins…"
                } else {
                    "No matching files or plugins"
                },
                Style::default().fg(context.muted()),
            ))]
        } else {
            popup
                .matches
                .iter()
                .enumerate()
                .skip(layout.first_path)
                .take(layout.visible_rows)
                .map(|(index, mention_match)| {
                    let base_style =
                        super::item_style(index, popup.selected, hovered, pressed, context);
                    let mut matched_indices = mention_match.indices.iter().peekable();
                    let mut spans = vec![Span::styled("+ ", base_style)];
                    spans.extend(mention_match.label.chars().enumerate().map(
                        |(char_index, character)| {
                            let mut style = base_style;
                            if matched_indices
                                .peek()
                                .is_some_and(|matched| **matched == char_index)
                            {
                                matched_indices.next();
                                style = style.fg(context.foreground()).add_modifier(Modifier::BOLD);
                            }
                            Span::styled(character.to_string(), style)
                        },
                    ));
                    if mention_match.kind == MentionMatchKind::Plugin {
                        spans.push(Span::styled("  plugin", base_style));
                    }
                    Line::from(spans)
                })
                .collect()
        };
        super::clear_popup(frame, area, layout.area, context);
        frame.render_widget(Paragraph::new(lines), layout.area);
    }

    pub(crate) fn mention_index_at(
        area: Rect,
        popup: Option<MentionPopupView<'_>>,
        column: u16,
        row: u16,
    ) -> Option<usize> {
        let popup = popup?;
        if popup.matches.is_empty() {
            return None;
        }
        let layout = popup_layout(area, popup.matches.len(), popup.selected)?;
        if column < layout.area.x
            || column >= layout.area.right()
            || row < layout.area.y
            || row >= layout.area.bottom()
        {
            return None;
        }
        let index = layout.first_path + usize::from(row - layout.area.y);
        (index < popup.matches.len()).then_some(index)
    }

    fn popup_layout(area: Rect, path_count: usize, selected: usize) -> Option<PopupLayout> {
        let max_rows = area.height.saturating_sub(2).min(6) as usize;
        if max_rows == 0 {
            return None;
        }
        let visible_rows = path_count.clamp(1, max_rows);
        let first_path = selected
            .saturating_add(1)
            .saturating_sub(max_rows)
            .min(path_count.saturating_sub(visible_rows));
        Some(PopupLayout {
            area: horizontal_margin(bottom_anchored_area(area, visible_rows as u16), 2),
            first_path,
            visible_rows,
        })
    }
}

mod skill {
    use super::super::SkillCompletionView;
    use super::description_height;
    use super::description_popup_layout;
    use crate::render::RenderContext;
    use crate::render::horizontal_margin;
    use ratatui::Frame;
    use ratatui::layout::Rect;
    use ratatui::style::Style;
    use ratatui::text::Line;
    use ratatui::text::Span;
    use ratatui::widgets::Paragraph;
    use ratatui::widgets::Wrap;
    use unicode_width::UnicodeWidthStr;

    pub(crate) fn draw(
        frame: &mut Frame<'_>,
        area: Rect,
        popup: Option<SkillCompletionView<'_>>,
        hovered: Option<usize>,
        pressed: Option<usize>,
        context: RenderContext<'_>,
    ) {
        let Some(popup) = popup else {
            return;
        };
        let popup_width = horizontal_margin(area, 2).width;
        let item_heights = if popup.items.is_empty() {
            vec![1]
        } else {
            popup
                .items
                .iter()
                .map(|item| {
                    let label_width = format!("${}  ", item.name()).width().min(u16::MAX as usize);
                    description_height(
                        item.description(),
                        popup_width.saturating_sub(label_width as u16),
                    )
                })
                .collect()
        };
        let Some(layout) = description_popup_layout(area, popup.selected, &item_heights) else {
            return;
        };
        super::clear_popup(frame, area, layout.area, context);
        if popup.items.is_empty() {
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    "No matching Skills",
                    Style::default().fg(context.muted()),
                ))),
                layout.area,
            );
            return;
        }

        let mut y = layout.area.y;
        for (offset, height) in layout.item_heights.iter().copied().enumerate() {
            let index = layout.first_item + offset;
            let item = &popup.items[index];
            let style = super::item_style(index, popup.selected, hovered, pressed, context);
            let label = format!("${}  ", item.name());
            let label_width = label.width().min(usize::from(layout.area.width)) as u16;
            frame.render_widget(
                Paragraph::new(Span::styled(label, style)),
                Rect::new(layout.area.x, y, label_width, 1),
            );
            let description_area = Rect::new(
                layout.area.x.saturating_add(label_width),
                y,
                layout.area.width.saturating_sub(label_width),
                height,
            );
            frame.render_widget(
                Paragraph::new(Span::styled(item.description(), style)).wrap(Wrap { trim: true }),
                description_area,
            );
            y = y.saturating_add(height);
        }
    }

    pub(crate) fn skill_index_at(
        area: Rect,
        popup: Option<SkillCompletionView<'_>>,
        column: u16,
        row: u16,
    ) -> Option<usize> {
        let popup = popup?;
        if popup.items.is_empty() {
            return None;
        }
        let popup_width = horizontal_margin(area, 2).width;
        let item_heights = popup
            .items
            .iter()
            .map(|item| {
                let label_width = format!("${}  ", item.name()).width().min(u16::MAX as usize);
                description_height(
                    item.description(),
                    popup_width.saturating_sub(label_width as u16),
                )
            })
            .collect::<Vec<_>>();
        let layout = description_popup_layout(area, popup.selected, &item_heights)?;
        if column < layout.area.x
            || column >= layout.area.right()
            || row < layout.area.y
            || row >= layout.area.bottom()
        {
            return None;
        }
        layout.item_at(row)
    }
}

mod slash {
    use super::super::SlashCommandsView;
    use super::description_height;
    use super::description_popup_layout;
    use super::draw_position;
    use crate::render::RenderContext;
    use crate::render::horizontal_margin;
    use ratatui::Frame;
    use ratatui::layout::Rect;
    use ratatui::style::Style;
    use ratatui::text::Line;
    use ratatui::text::Span;
    use ratatui::widgets::Paragraph;
    use ratatui::widgets::Scrollbar;
    use ratatui::widgets::ScrollbarOrientation;
    use ratatui::widgets::ScrollbarState;
    use ratatui::widgets::Wrap;

    const COMMAND_COLUMN_WIDTH: usize = 26;
    const COMMAND_COLUMN_DISPLAY_WIDTH: u16 = COMMAND_COLUMN_WIDTH as u16 + 1;

    struct SlashPopupLayout {
        list: super::DescriptionPopupLayout,
        scrollbar_area: Option<Rect>,
    }

    pub(crate) fn draw(
        frame: &mut Frame<'_>,
        area: Rect,
        popup: Option<SlashCommandsView<'_>>,
        hovered: Option<usize>,
        pressed: Option<usize>,
        context: RenderContext<'_>,
    ) {
        let language = context.language();
        let Some(popup) = popup else {
            return;
        };
        let Some(layout) = popup_layout(area, popup, language) else {
            return;
        };
        super::clear_popup(frame, area, layout.list.area, context);
        draw_position(
            frame,
            area,
            layout.list.area,
            popup.selected,
            popup.commands.len(),
            context,
        );
        if popup.commands.is_empty() {
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    context.localize("No matching commands"),
                    Style::default().fg(context.muted()),
                ))),
                layout.list.area,
            );
            return;
        }

        let mut y = layout.list.area.y;
        for (offset, height) in layout.list.item_heights.iter().copied().enumerate() {
            let index = layout.list.first_item + offset;
            let command = &popup.commands[index];
            let command_style = super::item_style(index, popup.selected, hovered, pressed, context);
            let command_width = COMMAND_COLUMN_DISPLAY_WIDTH.min(layout.list.area.width);
            frame.render_widget(
                Paragraph::new(Span::styled(
                    format!("/{:<width$}", command.name, width = COMMAND_COLUMN_WIDTH),
                    command_style,
                )),
                Rect::new(layout.list.area.x, y, command_width, 1),
            );
            frame.render_widget(
                Paragraph::new(Span::styled(description(command, language), command_style))
                    .wrap(Wrap { trim: true }),
                Rect::new(
                    layout.list.area.x.saturating_add(command_width),
                    y,
                    layout.list.area.width.saturating_sub(command_width),
                    height,
                ),
            );
            y = y.saturating_add(height);
        }
        draw_scrollbar(frame, popup.commands.len(), &layout, context);
    }

    pub(crate) fn command_index_at(
        area: Rect,
        popup: Option<SlashCommandsView<'_>>,
        column: u16,
        row: u16,
        language: crate::nls::Language,
    ) -> Option<usize> {
        let popup = popup?;
        if popup.commands.is_empty() {
            return None;
        }
        let layout = popup_layout(area, popup, language)?;
        if column < layout.list.area.x
            || column >= layout.list.area.right()
            || row < layout.list.area.y
            || row >= layout.list.area.bottom()
        {
            return None;
        }
        layout.list.item_at(row)
    }

    pub(crate) fn contains(
        area: Rect,
        popup: Option<SlashCommandsView<'_>>,
        column: u16,
        row: u16,
        language: crate::nls::Language,
    ) -> bool {
        let Some(popup) = popup else {
            return false;
        };
        popup_layout(area, popup, language).is_some_and(|layout| {
            let position = ratatui::layout::Position::new(column, row);
            layout.list.area.contains(position)
                || layout
                    .scrollbar_area
                    .is_some_and(|scrollbar| scrollbar.contains(position))
        })
    }

    fn description(
        command: &ash_slash_commands::SlashCommandDefinition,
        language: crate::nls::Language,
    ) -> std::borrow::Cow<'_, str> {
        if command
            .name
            .parse::<super::super::super::slash_commands::TuiSlashCommandAction>()
            .is_ok_and(|action| action.definition().description == command.description)
        {
            crate::nls::localize(language, &command.description)
        } else {
            std::borrow::Cow::Borrowed(&command.description)
        }
    }

    fn popup_layout(
        area: Rect,
        popup: SlashCommandsView<'_>,
        language: crate::nls::Language,
    ) -> Option<SlashPopupLayout> {
        let popup_width = horizontal_margin(area, 2).width;
        let description_width = popup_width.saturating_sub(COMMAND_COLUMN_DISPLAY_WIDTH);
        let item_heights = if popup.commands.is_empty() {
            vec![1]
        } else {
            popup
                .commands
                .iter()
                .map(|command| {
                    description_height(&description(command, language), description_width)
                })
                .collect()
        };
        let list = description_popup_layout(area, popup.selected, &item_heights)?;
        let scrollable = popup.commands.len() > list.item_heights.len();
        let scrollbar_area = scrollable.then(|| {
            Rect::new(
                area.right().saturating_sub(1),
                list.area.y,
                1,
                list.area.height,
            )
        });
        Some(SlashPopupLayout {
            list,
            scrollbar_area,
        })
    }

    fn draw_scrollbar(
        frame: &mut Frame<'_>,
        command_count: usize,
        layout: &SlashPopupLayout,
        context: RenderContext<'_>,
    ) {
        let visible_items = layout.list.item_heights.len();
        let Some(scrollbar_area) = layout.scrollbar_area else {
            return;
        };
        let scroll_positions = command_count
            .saturating_sub(visible_items)
            .saturating_add(1);
        let mut state = ScrollbarState::new(scroll_positions)
            .position(layout.list.first_item)
            .viewport_content_length(visible_items);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .begin_symbol(None)
            .end_symbol(None)
            .track_symbol(Some("│"))
            .track_style(Style::default().fg(context.border()))
            .thumb_symbol("┃")
            .thumb_style(Style::default().fg(context.muted()));
        frame.render_stateful_widget(scrollbar, scrollbar_area, &mut state);
    }
}

use super::CompletionView;
use crate::render::RenderContext;
use crate::render::bottom_anchored_area;
use crate::render::horizontal_margin;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

const MAX_VISIBLE_DESCRIPTION_ITEMS: usize = 6;
const MAX_DESCRIPTION_LINES: usize = 2;

fn clear_popup(
    frame: &mut Frame<'_>,
    available_area: Rect,
    content_area: Rect,
    context: RenderContext<'_>,
) {
    let surface_top = content_area.y.saturating_sub(1);
    let surface_area = Rect::new(
        available_area.x,
        surface_top,
        available_area.width,
        content_area.bottom().saturating_sub(surface_top),
    );
    frame.render_widget(Clear, surface_area);
    frame.render_widget(
        Block::default().style(Style::default().bg(context.background())),
        surface_area,
    );
    frame.render_widget(
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(context.border())),
        horizontal_margin(surface_area, 2),
    );
}

fn draw_position(
    frame: &mut Frame<'_>,
    available_area: Rect,
    content_area: Rect,
    selected: usize,
    item_count: usize,
    context: RenderContext<'_>,
) {
    let position = if item_count == 0 {
        " 0 ".to_owned()
    } else {
        format!(" {}/{} ", selected.min(item_count - 1) + 1, item_count)
    };
    let surface_top = content_area.y.saturating_sub(1);
    let border_area = horizontal_margin(
        Rect::new(available_area.x, surface_top, available_area.width, 1),
        2,
    );
    let Ok(width) = u16::try_from(position.len()) else {
        return;
    };
    if width > border_area.width {
        return;
    }
    let area = Rect::new(
        border_area.right().saturating_sub(width),
        border_area.y,
        width,
        1,
    );
    frame.render_widget(
        Paragraph::new(position).style(
            Style::default()
                .fg(context.muted())
                .bg(context.background()),
        ),
        area,
    );
}

struct DescriptionPopupLayout {
    area: Rect,
    first_item: usize,
    item_heights: Vec<u16>,
}

impl DescriptionPopupLayout {
    fn item_at(&self, row: u16) -> Option<usize> {
        let relative_row = row.saturating_sub(self.area.y);
        let mut item_start = 0;
        for (offset, height) in self.item_heights.iter().copied().enumerate() {
            if relative_row < item_start + height {
                return Some(self.first_item + offset);
            }
            item_start += height;
        }
        None
    }
}

fn description_height(description: &str, width: u16) -> u16 {
    if description.is_empty() || width == 0 {
        return 1;
    }
    Paragraph::new(description)
        .wrap(Wrap { trim: true })
        .line_count(width)
        .clamp(1, MAX_DESCRIPTION_LINES) as u16
}

fn description_popup_layout(
    area: Rect,
    selected: usize,
    item_heights: &[u16],
) -> Option<DescriptionPopupLayout> {
    let max_height = area.height.saturating_sub(2);
    if max_height == 0 || item_heights.is_empty() {
        return None;
    }

    let selected = selected.min(item_heights.len() - 1);
    let height = |index: usize| item_heights[index].clamp(1, max_height);
    let mut first_item = selected;
    let mut last_item = selected + 1;
    let mut visible_height = height(selected);
    let mut visible_items = 1;
    while first_item > 0 && visible_items < MAX_VISIBLE_DESCRIPTION_ITEMS {
        let previous_height = height(first_item - 1);
        if visible_height + previous_height > max_height {
            break;
        }
        first_item -= 1;
        visible_height += previous_height;
        visible_items += 1;
    }
    while last_item < item_heights.len() && visible_items < MAX_VISIBLE_DESCRIPTION_ITEMS {
        let next_height = height(last_item);
        if visible_height + next_height > max_height {
            break;
        }
        visible_height += next_height;
        last_item += 1;
        visible_items += 1;
    }

    Some(DescriptionPopupLayout {
        area: horizontal_margin(bottom_anchored_area(area, visible_height), 2),
        first_item,
        item_heights: (first_item..last_item).map(height).collect(),
    })
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    completion: Option<CompletionView<'_>>,
    hovered: Option<usize>,
    pressed: Option<usize>,
    context: RenderContext<'_>,
) {
    match completion {
        Some(CompletionView::Slash(view)) => {
            slash::draw(frame, area, Some(view), hovered, pressed, context)
        }
        Some(CompletionView::Mention(view)) => {
            mention::draw(frame, area, Some(view), hovered, pressed, context)
        }
        Some(CompletionView::Skill(view)) => {
            skill::draw(frame, area, Some(view), hovered, pressed, context)
        }
        None => {}
    }
}

fn item_style(
    index: usize,
    selected: usize,
    hovered: Option<usize>,
    pressed: Option<usize>,
    context: RenderContext<'_>,
) -> ratatui::style::Style {
    if index == selected || hovered == Some(index) || pressed == Some(index) {
        ratatui::style::Style::default().fg(context.focus())
    } else {
        ratatui::style::Style::default().fg(context.muted())
    }
}

pub(crate) fn index_at(
    area: Rect,
    completion: Option<CompletionView<'_>>,
    column: u16,
    row: u16,
    language: crate::nls::Language,
) -> Option<usize> {
    match completion {
        Some(CompletionView::Slash(view)) => {
            slash::command_index_at(area, Some(view), column, row, language)
        }
        Some(CompletionView::Mention(view)) => {
            mention::mention_index_at(area, Some(view), column, row)
        }
        Some(CompletionView::Skill(view)) => skill::skill_index_at(area, Some(view), column, row),
        None => None,
    }
}

pub(crate) fn contains(
    area: Rect,
    completion: Option<CompletionView<'_>>,
    column: u16,
    row: u16,
    language: crate::nls::Language,
) -> bool {
    match completion {
        Some(CompletionView::Slash(view)) => {
            slash::contains(area, Some(view), column, row, language)
        }
        Some(CompletionView::Mention(view)) => {
            mention::mention_index_at(area, Some(view), column, row).is_some()
        }
        Some(CompletionView::Skill(view)) => {
            skill::skill_index_at(area, Some(view), column, row).is_some()
        }
        None => false,
    }
}

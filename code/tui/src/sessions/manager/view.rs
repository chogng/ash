//! Dashboard geometry, rendering and pointer hits built from logical manager items.

use super::ManagerItem;
use super::SessionGroup;
use super::SessionManagerTarget;
use super::SessionManagerView;
use super::manager_items;
use super::manager_status_label;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::selection_marker;
use crate::render::truncate_to_width;
use crate::sessions::color::session_color;
use crate::widgets::grouped_list::more_line;
use crate::widgets::grouped_list::pad_to_width;
use crate::widgets::grouped_list::viewport;
use crate::widgets::panel;
use crate::widgets::panel::PanelLayout;
use ash_protocol::Session;
use ash_protocol::SessionManagerActivity;
use ash_protocol::SessionManagerStatus;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use std::collections::BTreeSet;
use std::time::Duration;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

const WORKING_FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub(crate) fn draw_manager(
    frame: &mut Frame<'_>,
    area: Rect,
    view: SessionManagerView<'_>,
    hovered: Option<&SessionManagerTarget>,
    pressed: Option<&SessionManagerTarget>,
    context: RenderContext<'_>,
) {
    if area.is_empty() {
        return;
    }
    let layout = manager_layout(area, &view);
    let grouping = Line::from(vec![
        Span::styled(
            format!(
                "{}: {}  ",
                context.localize("Group"),
                context.localize(view.grouping.label())
            ),
            Style::default().fg(context.muted()),
        ),
        Span::styled("g", crate::render::action_style(context)),
    ]);
    panel::draw_header(
        frame,
        layout.header,
        Line::styled(
            context.localize("Dashboard"),
            Style::default().fg(context.foreground()),
        ),
        grouping,
        context.muted(),
    );
    if !layout.details.is_empty() {
        frame.render_widget(
            Paragraph::new(vec![Line::from("│"); usize::from(layout.divider.height)])
                .style(Style::default().fg(context.muted())),
            layout.divider,
        );
        draw_summary(frame, layout.details, &view, context);
        frame.render_widget(
            Paragraph::new(table_line(
                "    ",
                Span::raw(context.localize("Sessions").into_owned()),
                &context.localize("Status"),
                &context.localize("Updated"),
                layout.list.width,
                context,
            )),
            Rect {
                y: layout.list.y - 1,
                height: 1,
                ..layout.list
            },
        );
    }
    for (row_area, row) in &layout.rows {
        let line = match row {
            ManagerRow::Item(ManagerItem::Heading { group, count }) => group_line(
                group,
                *count,
                if *count == 0 {
                    GroupDisclosure::None
                } else if view.collapsed.contains(group) {
                    GroupDisclosure::Collapsed
                } else {
                    GroupDisclosure::Expanded
                },
                manager_state(
                    &SessionManagerTarget::Group(group.clone()),
                    view.selected,
                    view.focused,
                    hovered,
                    pressed,
                ),
                usize::from(row_area.width),
                context,
            ),
            ManagerRow::Item(ManagerItem::Session(session)) => {
                let state = manager_state(
                    &SessionManagerTarget::Session(session.session_id.clone()),
                    view.selected,
                    view.focused,
                    hovered,
                    pressed,
                );
                if layout.details.is_empty() {
                    session_line(
                        session,
                        state,
                        view.animation_frame,
                        view.now_unix_ms,
                        usize::from(row_area.width),
                        context,
                    )
                } else {
                    table_session_line(
                        session,
                        state,
                        view.animation_frame,
                        view.now_unix_ms,
                        row_area.width,
                        context,
                    )
                }
            }
            ManagerRow::Gap => Line::default(),
            ManagerRow::More { direction, count } => {
                more_line(*direction, *count, usize::from(row_area.width), context)
            }
        };
        frame.render_widget(Paragraph::new(line), *row_area);
    }
}

pub(crate) fn pointer_target_at(
    area: Rect,
    view: SessionManagerView<'_>,
    position: Position,
) -> Option<SessionManagerTarget> {
    manager_layout(area, &view)
        .rows
        .iter()
        .find_map(|(area, row)| area.contains(position).then(|| row.target()).flatten())
}

// Decorative rows exist only in the layout. State and keyboard navigation use ManagerItem.
enum ManagerRow<'a> {
    Item(ManagerItem<'a>),
    Gap,
    More { direction: char, count: usize },
}

impl ManagerRow<'_> {
    fn target(&self) -> Option<SessionManagerTarget> {
        match self {
            Self::Item(item) => Some(item.target()),
            Self::Gap | Self::More { .. } => None,
        }
    }
}

/// A prepared layout owns every visible row's bounds, including gaps and overflow notices.
/// Drawing and hit testing use this same calculation; no caller reconstructs row offsets.
struct ManagerLayout<'a> {
    header: Rect,
    list: Rect,
    divider: Rect,
    details: Rect,
    rows: Vec<(Rect, ManagerRow<'a>)>,
}

fn manager_layout<'a>(area: Rect, view: &SessionManagerView<'a>) -> ManagerLayout<'a> {
    let panel = PanelLayout::new(area, 0);
    let header = Rect::new(area.x, panel.title.y, area.width, panel.title.height);
    let body = Rect {
        // The manager owns the full-width status-marker column; the panel owns vertical spacing.
        x: area.x,
        width: area.width,
        ..panel.body
    };
    let (list, divider, details) = if area.width < 96 || body.height < 3 {
        (body, Rect::default(), Rect::default())
    } else {
        let list_width = area.width / 3 * 2;
        (
            Rect::new(body.x, body.y + 1, list_width, body.height - 1),
            Rect::new(body.x + list_width, body.y, 1, body.height),
            Rect::new(
                body.x + list_width + 2,
                body.y,
                area.width - list_width - 3,
                body.height,
            ),
        )
    };
    let mut rows = Vec::new();
    for item in manager_items(view.sessions, view.pinned, view.collapsed, view.grouping) {
        if matches!(item, ManagerItem::Heading { .. }) && !rows.is_empty() {
            rows.push(ManagerRow::Gap);
        }
        rows.push(ManagerRow::Item(item));
    }
    let selected_row = rows.iter().position(|row| {
        row.target()
            .as_ref()
            .is_some_and(|target| Some(target) == view.selected)
    });
    let visible_rows = usize::from(list.height);
    let viewport = viewport(rows.len(), selected_row, visible_rows);
    let mut visible = Vec::new();
    if viewport.start > 0 && visible_rows > 1 {
        visible.push(ManagerRow::More {
            direction: '↑',
            count: viewport.start,
        });
    }
    let remaining = rows.len() - viewport.end;
    visible.extend(
        rows.into_iter()
            .skip(viewport.start)
            .take(viewport.end - viewport.start),
    );
    if remaining > 0 && visible_rows > 1 {
        visible.push(ManagerRow::More {
            direction: '↓',
            count: remaining,
        });
    }
    let rows = visible
        .into_iter()
        .take(visible_rows)
        .enumerate()
        .map(|(index, row)| {
            let y = list.y
                + u16::try_from(index).expect("visible row index must fit the terminal height");
            (Rect::new(list.x, y, list.width, 1), row)
        })
        .collect();
    ManagerLayout {
        header,
        list,
        divider,
        details,
        rows,
    }
}

fn table_line(
    prefix: &str,
    title: Span<'_>,
    status: &str,
    updated: &str,
    width: u16,
    context: RenderContext<'_>,
) -> Line<'static> {
    let width = usize::from(width);
    let status_width = 16;
    let updated_width = 10;
    let title_width = width.saturating_sub(status_width + updated_width + prefix.width() + 2);
    Line::from(vec![
        Span::raw(prefix.to_owned()),
        Span::styled(
            pad_to_width(&truncate_to_width(&title.content, title_width), title_width),
            title.style,
        ),
        Span::raw(format!(
            " {} {}",
            pad_to_width(&truncate_to_width(status, status_width), status_width),
            pad_to_width(&truncate_to_width(updated, updated_width), updated_width),
        )),
    ])
    .style(Style::default().fg(context.muted()))
}

fn table_session_line<'a>(
    session: &'a Session,
    state: InteractionState,
    animation_frame: usize,
    now_unix_ms: u64,
    width: u16,
    context: RenderContext<'_>,
) -> Line<'a> {
    let prefix = format!(
        "{}{} ",
        selection_marker(state.selected),
        status_icon(session.manager.status, animation_frame)
    );
    table_line(
        &prefix,
        Span::styled(
            &session.title,
            Style::default()
                .fg(session_color(&session.session_id, context))
                .patch(interaction_style(context, state)),
        ),
        &context.localize(manager_status_label(session.manager.status)),
        &elapsed_label(session, now_unix_ms, context),
        width,
        context,
    )
    .style(
        Style::default()
            .fg(context.muted())
            .patch(interaction_style(context, state)),
    )
}

fn draw_summary(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &SessionManagerView<'_>,
    context: RenderContext<'_>,
) {
    let muted = Style::default().fg(context.muted());
    let heading = Style::default()
        .fg(context.foreground())
        .add_modifier(Modifier::BOLD);
    let mut lines = vec![
        Line::styled(context.localize("Session details").into_owned(), heading),
        Line::default(),
    ];
    match view.selected {
        Some(SessionManagerTarget::Session(id)) => {
            if let Some(session) = view
                .sessions
                .iter()
                .find(|session| &session.session_id == id)
            {
                lines.push(Line::styled(
                    session.title.clone(),
                    heading.fg(session_color(id, context)),
                ));
                lines.push(Line::styled(
                    context
                        .localize(manager_status_label(session.manager.status))
                        .into_owned(),
                    muted,
                ));
                if !activity_text(session).is_empty() {
                    lines.push(Line::default());
                    lines.push(Line::styled(
                        context.localize("Activity").into_owned(),
                        heading,
                    ));
                    crate::render::push_owned_lines(
                        &crate::render::styled_text_lines(activity_text(session), muted),
                        &mut lines,
                    );
                }
                lines.push(Line::default());
                lines.push(Line::styled(
                    context.localize("Project").into_owned(),
                    heading,
                ));
                let project = match &session.execution_target {
                    Some(ash_protocol::SessionExecutionTarget::Local { root }) => {
                        root.to_string_lossy().into_owned()
                    }
                    Some(ash_protocol::SessionExecutionTarget::Ssh { host, root }) => {
                        format!("{host}:{root}")
                    }
                    None => context.localize("No project").into_owned(),
                };
                lines.push(Line::styled(project, muted));
                let model = session
                    .model
                    .as_ref()
                    .map(|model| format!("{}/{}", model.provider, model.model))
                    .unwrap_or_else(|| context.localize("No model selected").into_owned());
                lines.push(Line::styled(
                    format!("{}: {model}", context.localize("Model")),
                    muted,
                ));
                lines.push(Line::default());
                lines.push(Line::styled(
                    format!("{}: {}", context.localize("Threads"), session.threads.len()),
                    muted,
                ));
            }
        }
        Some(SessionManagerTarget::Group(group)) => {
            let members =
                manager_items(view.sessions, view.pinned, &BTreeSet::new(), view.grouping)
                    .into_iter()
                    .find_map(|row| match row {
                        ManagerItem::Heading {
                            group: candidate,
                            count,
                        } if &candidate == group => Some(count),
                        _ => None,
                    })
                    .unwrap_or_default();
            lines.push(group_line(
                group,
                members,
                GroupDisclosure::None,
                InteractionState::default(),
                usize::from(area.width),
                context,
            ));
        }
        None => lines.push(Line::styled(
            context.localize("No sessions yet").into_owned(),
            muted,
        )),
    }
    frame.render_widget(
        Paragraph::new(crate::render::wrap_lines(lines, usize::from(area.width))),
        area,
    );
}

fn session_line<'a>(
    session: &'a Session,
    state: InteractionState,
    animation_frame: usize,
    now_unix_ms: u64,
    width: usize,
    context: RenderContext<'_>,
) -> Line<'a> {
    let icon = status_icon(session.manager.status, animation_frame);
    let elapsed = elapsed_label(session, now_unix_ms, context);
    let elapsed_width = elapsed.width();
    let icon_width = icon.width().unwrap_or(1);
    let indent = 2;
    let after_icon = width.saturating_sub(indent + icon_width + 1);
    let time_gap = usize::from(after_icon > elapsed_width);
    let body_width = after_icon.saturating_sub(elapsed_width + time_gap);
    let middle = activity_text(session);
    let (name_width, middle_gap, middle_width) = column_widths(body_width, !middle.is_empty());
    let name = pad_to_width(&truncate_to_width(&session.title, name_width), name_width);
    let middle = pad_to_width(&truncate_to_width(middle, middle_width), middle_width);
    let row_style = if state.selected || state.hovered || state.pressed {
        interaction_style(context, state)
    } else {
        Style::default().fg(context.muted())
    };

    Line::from(vec![
        Span::styled(selection_marker(state.selected), row_style),
        Span::styled(icon.to_string(), row_style),
        Span::raw(" "),
        Span::styled(
            name,
            Style::default()
                .fg(session_color(&session.session_id, context))
                .patch(interaction_style(context, state)),
        ),
        Span::raw(" ".repeat(middle_gap)),
        Span::styled(middle, row_style),
        Span::raw(" ".repeat(time_gap)),
        Span::styled(elapsed, row_style),
    ])
    .style(row_style)
}

enum GroupDisclosure {
    None,
    Collapsed,
    Expanded,
}

fn group_line(
    group: &SessionGroup,
    count: usize,
    disclosure: GroupDisclosure,
    state: InteractionState,
    width: usize,
    context: RenderContext<'_>,
) -> Line<'static> {
    let label = match group {
        SessionGroup::LocalProject(_)
        | SessionGroup::RemoteProject { .. }
        | SessionGroup::Model(_) => group.label().into_owned(),
        _ => context.localize(&group.label()).into_owned(),
    };
    let prefix = selection_marker(state.selected);
    let available = width.saturating_sub(prefix.width());
    let marker = match disclosure {
        GroupDisclosure::None => "",
        GroupDisclosure::Collapsed => "+",
        GroupDisclosure::Expanded => "-",
    };
    let marker = match available {
        0 => String::new(),
        1 => marker.to_owned(),
        _ if !marker.is_empty() => format!(" {marker}"),
        _ => String::new(),
    };
    let count = truncate_to_width(
        &format!(" ({count})"),
        available.saturating_sub(marker.width()),
    );
    let suffix = format!("{count}{marker}");
    let label_width = width.saturating_sub(prefix.width() + suffix.width());
    let label = truncate_to_width(&label, label_width);
    let style = Style::default()
        .fg(context.muted())
        .patch(interaction_style(context, state));
    let heading = Style::default()
        .fg(context.foreground())
        .add_modifier(Modifier::BOLD)
        .patch(interaction_style(context, state));
    let padding = width.saturating_sub(prefix.width() + label.width() + suffix.width());
    Line::from(vec![
        Span::styled(prefix, style),
        Span::styled(label, heading),
        Span::styled(suffix, style.remove_modifier(Modifier::BOLD)),
        Span::raw(" ".repeat(padding)),
    ])
    .style(style)
}

fn manager_state(
    target: &SessionManagerTarget,
    selected: Option<&SessionManagerTarget>,
    focused: bool,
    hovered: Option<&SessionManagerTarget>,
    pressed: Option<&SessionManagerTarget>,
) -> InteractionState {
    InteractionState {
        target: InteractionTarget::Rest,
        selected: focused && selected == Some(target),
        hovered: hovered == Some(target),
        pressed: pressed == Some(target),
    }
}

fn column_widths(body_width: usize, has_middle: bool) -> (usize, usize, usize) {
    if !has_middle || body_width < 12 {
        return (body_width, 0, 0);
    }
    let name_width = (body_width / 3).clamp(8, 28).min(body_width);
    let middle_gap = usize::from(body_width > name_width);
    let middle_width = body_width.saturating_sub(name_width + middle_gap);
    (name_width, middle_gap, middle_width)
}

fn activity_text(session: &Session) -> &str {
    match &session.manager.activity {
        Some(SessionManagerActivity::Operation { text })
        | Some(SessionManagerActivity::Question { text })
        | Some(SessionManagerActivity::Failure { text }) => text,
        None => session.manager.summary.as_deref().unwrap_or_default(),
    }
}

fn elapsed_label(session: &Session, now_unix_ms: u64, context: RenderContext<'_>) -> String {
    if session.manager.status_changed_at_unix_ms == 0 {
        return String::new();
    }
    let elapsed = whole_hour_label(Duration::from_millis(
        now_unix_ms.saturating_sub(session.manager.status_changed_at_unix_ms),
    ));
    if elapsed.is_empty() {
        return elapsed;
    }
    if session.manager.status == SessionManagerStatus::Completed {
        format!("{elapsed} {}", context.localize("ago"))
    } else {
        elapsed
    }
}

fn whole_hour_label(duration: Duration) -> String {
    let hours = duration.as_secs() / 3_600;
    if hours == 0 {
        return String::new();
    }
    let days = hours / 24;
    let remaining_hours = hours % 24;
    match (days, remaining_hours) {
        (0, hours) => format!("{hours}h"),
        (days, 0) => format!("{days}d"),
        (days, hours) => format!("{days}d {hours:02}h"),
    }
}

fn status_icon(status: SessionManagerStatus, animation_frame: usize) -> char {
    match status {
        SessionManagerStatus::Idle => '○',
        SessionManagerStatus::NeedsInput => '?',
        SessionManagerStatus::Working => WORKING_FRAMES[animation_frame % WORKING_FRAMES.len()],
        SessionManagerStatus::ReadyForReview => '◆',
        SessionManagerStatus::Completed | SessionManagerStatus::Failed => '●',
        SessionManagerStatus::Stopped => '■',
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;

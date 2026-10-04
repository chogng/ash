use super::SessionGrouping;
use crate::keymap::bindings;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::selection_marker;
use crate::render::truncate_to_width;
#[cfg(test)]
use crate::widgets::grouped_list::Viewport as ManagerViewport;
use crate::widgets::grouped_list::more_line;
use crate::widgets::grouped_list::pad_to_width;
use crate::widgets::grouped_list::viewport as manager_viewport;
use crate::widgets::panel;
use crate::widgets::panel::PanelLayout;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerActivity;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

const ANIMATION_INTERVAL: Duration = Duration::from_millis(80);
const WORKING_FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

#[derive(Debug)]
pub(crate) struct SessionManagerState {
    grouping: SessionGrouping,
    selected: Option<SessionManagerPointerTarget>,
    collapsed: BTreeSet<SessionGroup>,
    selected_archived: bool,
    focused: bool,
    pinned: BTreeSet<SessionId>,
    animation_frame: usize,
    last_animation_at: Option<Instant>,
    now_unix_ms: u64,
}

impl Default for SessionManagerState {
    fn default() -> Self {
        Self {
            grouping: SessionGrouping::default(),
            selected: None,
            collapsed: BTreeSet::from([SessionGroup::Archived]),
            selected_archived: false,
            focused: false,
            pinned: BTreeSet::new(),
            animation_frame: 0,
            last_animation_at: None,
            now_unix_ms: current_unix_millis(),
        }
    }
}

impl SessionManagerState {
    pub(crate) const fn grouping(&self) -> SessionGrouping {
        self.grouping
    }

    pub(crate) fn set_grouping(&mut self, grouping: SessionGrouping, sessions: &[Session]) {
        if self.grouping == grouping {
            return;
        }
        self.grouping = grouping;
        // Group identities belong to one grouping; keep an archived selection visible too.
        self.collapsed = BTreeSet::from([SessionGroup::Archived]);
        if self.selected_archived {
            self.collapsed.remove(&SessionGroup::Archived);
        }
        self.reconcile(sessions);
    }

    pub(crate) fn reconcile(&mut self, sessions: &[Session]) {
        self.pinned.retain(|session_id| {
            sessions
                .iter()
                .any(|session| &session.session_id == session_id)
        });
        let rows = manager_rows(sessions, &self.pinned, &self.collapsed, self.grouping);
        if self.selected.as_ref().is_some_and(|selected| {
            rows.iter()
                .any(|row| row.target().as_ref() == Some(selected))
        }) {
            self.update_selected_status(sessions);
            return;
        }
        self.selected = if self.selected_archived {
            Some(SessionManagerPointerTarget::Group(SessionGroup::Archived))
        } else {
            rows.iter()
                .find(|row| matches!(row, ManagerRow::Session(_)))
                .or_else(|| rows.first())
                .and_then(ManagerRow::target)
        };
        self.update_selected_status(sessions);
    }

    pub(crate) fn focus(&mut self) {
        self.focused = true;
    }

    pub(crate) fn blur(&mut self) {
        self.focused = false;
    }

    pub(crate) fn focused(&self) -> bool {
        self.focused
    }

    #[cfg(test)]
    pub(crate) fn select_next(&mut self, sessions: &[Session]) -> bool {
        self.select_offset(sessions, 1)
    }

    pub(super) fn navigate(
        &mut self,
        sessions: &[Session],
        navigation: crate::widgets::navigation::Navigation,
    ) {
        use crate::widgets::navigation::Navigation;
        let delta = match navigation {
            Navigation::Previous => -1,
            Navigation::Next => 1,
            Navigation::PagePrevious => -12,
            Navigation::PageNext => 12,
            Navigation::First => isize::MIN,
            Navigation::Last => isize::MAX,
        };
        self.select_offset(sessions, delta);
    }

    pub(crate) fn selected_session(&self) -> Option<&SessionId> {
        match self.selected.as_ref() {
            Some(SessionManagerPointerTarget::Session(id)) => Some(id),
            _ => None,
        }
    }

    pub(crate) fn focus_pointer(
        &mut self,
        sessions: &[Session],
        target: &SessionManagerPointerTarget,
    ) -> bool {
        if !manager_rows(sessions, &self.pinned, &self.collapsed, self.grouping)
            .iter()
            .any(|row| row.target().as_ref() == Some(target))
        {
            return false;
        }
        self.selected = Some(target.clone());
        self.focused = true;
        self.update_selected_status(sessions);
        true
    }

    pub(super) fn selected_group(&self) -> Option<SessionGroup> {
        match self.selected.as_ref() {
            Some(SessionManagerPointerTarget::Group(group)) => Some(group.clone()),
            _ => None,
        }
    }

    pub(crate) fn toggle_group(&mut self, group: SessionGroup) {
        if !self.collapsed.remove(&group) {
            self.collapsed.insert(group.clone());
        }
        self.selected = Some(SessionManagerPointerTarget::Group(group));
        self.selected_archived = false;
    }

    pub(super) fn toggle_selected_group(&mut self) {
        if let Some(group) = self.selected_group() {
            self.toggle_group(group);
        }
    }

    pub(super) fn expand_selected_group(&mut self) {
        if let Some(group) = self.selected_group() {
            self.collapsed.remove(&group);
        }
    }

    pub(super) fn collapse_selected_group(&mut self) {
        if let Some(group) = self.selected_group() {
            self.collapsed.insert(group);
        }
    }

    pub(super) fn selected_group_expanded(&self) -> bool {
        self.selected_group()
            .is_some_and(|group| !self.collapsed.contains(&group))
    }

    pub(super) fn selected_is_archived(&self) -> bool {
        self.selected_archived
    }

    fn update_selected_status(&mut self, sessions: &[Session]) {
        self.selected_archived = self.selected_session().is_some_and(|id| {
            sessions.iter().any(|session| {
                &session.session_id == id && session.status == SessionStatus::Archived
            })
        });
    }

    pub(super) fn selected_archive_ids(&self, sessions: &[Session]) -> Vec<SessionId> {
        let Some(selected) = self.selected_session() else {
            return Vec::new();
        };
        sessions
            .iter()
            .filter(|session| {
                &session.session_id == selected && session.status == SessionStatus::Active
            })
            .map(|session| session.session_id.clone())
            .collect()
    }

    pub(crate) fn selection_hint(&self) -> &'static crate::widgets::key_hint::KeyHints {
        if self.selected_group().is_some() {
            if self.selected_group_expanded() {
                &bindings::COLLAPSE_HINTS
            } else {
                &bindings::EXPAND_HINTS
            }
        } else if self.selected_archived {
            &bindings::ARCHIVED_HINTS
        } else if self.selected.is_some() {
            &bindings::SESSION_HINTS
        } else {
            &bindings::INPUT_HINTS
        }
    }

    pub(crate) fn status_hint(&self) -> &'static crate::widgets::key_hint::KeyHints {
        if self.focused {
            self.selection_hint()
        } else {
            &bindings::RETURN_HINTS
        }
    }

    pub(crate) fn inline_status_hint(&self) -> &'static crate::widgets::key_hint::KeyHints {
        if !self.focused || self.selected.is_none() {
            &bindings::INLINE_DASHBOARD_RETURN_HINTS
        } else if self.selected_group().is_some() {
            self.selection_hint()
        } else if self.selected_archived {
            &bindings::INLINE_ARCHIVED_HINTS
        } else {
            &bindings::INLINE_SESSION_HINTS
        }
    }

    pub(super) fn toggle_selected_pin(&mut self) -> bool {
        if self.selected_archived {
            return false;
        }
        let Some(selected) = self.selected_session().cloned() else {
            return false;
        };
        if !self.pinned.remove(&selected) {
            self.pinned.insert(selected);
        }
        true
    }

    pub(crate) fn refresh_time(&mut self, now: Instant, sessions: &[Session]) -> bool {
        let next_unix_ms = current_unix_millis();
        let elapsed_label_changed = self.now_unix_ms / 1_000 != next_unix_ms / 1_000;
        self.now_unix_ms = next_unix_ms;
        if !sessions
            .iter()
            .any(|session| session.manager.status == SessionManagerStatus::Working)
        {
            self.last_animation_at = None;
            return elapsed_label_changed;
        }
        let Some(last_animation_at) = self.last_animation_at else {
            self.last_animation_at = Some(now);
            return elapsed_label_changed;
        };
        let elapsed = now.saturating_duration_since(last_animation_at);
        let steps = elapsed.as_millis() / ANIMATION_INTERVAL.as_millis();
        if steps == 0 {
            return elapsed_label_changed;
        }
        self.animation_frame = (self.animation_frame
            + usize::try_from(steps).unwrap_or(usize::MAX))
            % WORKING_FRAMES.len();
        self.last_animation_at = Some(
            last_animation_at
                + ANIMATION_INTERVAL.saturating_mul(u32::try_from(steps).unwrap_or(u32::MAX)),
        );
        true
    }

    pub(crate) fn view<'a>(&'a self, sessions: &'a [Session]) -> SessionManagerView<'a> {
        SessionManagerView {
            grouping: self.grouping,
            sessions,
            selected: self.selected.as_ref(),
            collapsed: &self.collapsed,
            focused: self.focused,
            pinned: &self.pinned,
            animation_frame: self.animation_frame,
            now_unix_ms: self.now_unix_ms,
        }
    }

    fn select_offset(&mut self, sessions: &[Session], delta: isize) -> bool {
        let selectable = manager_rows(sessions, &self.pinned, &self.collapsed, self.grouping)
            .into_iter()
            .filter_map(|row| row.target())
            .collect::<Vec<_>>();
        let index = self
            .selected
            .as_ref()
            .and_then(|selected| selectable.iter().position(|row| row == selected));
        let next = index
            .map(|index| {
                index
                    .saturating_add_signed(delta)
                    .min(selectable.len().saturating_sub(1))
            })
            .unwrap_or(0);
        let changed = index != Some(next);
        self.selected = selectable.get(next).cloned();
        self.update_selected_status(sessions);
        changed
    }
}

pub(super) fn manager_status_label(status: SessionManagerStatus) -> &'static str {
    match status {
        SessionManagerStatus::Idle => "idle",
        SessionManagerStatus::NeedsInput => "needs input",
        SessionManagerStatus::Working => "working",
        SessionManagerStatus::ReadyForReview => "ready for review",
        SessionManagerStatus::Completed => "completed",
        SessionManagerStatus::Failed => "failed",
        SessionManagerStatus::Stopped => "stopped",
    }
}

pub(crate) struct SessionManagerView<'a> {
    grouping: SessionGrouping,
    sessions: &'a [Session],
    selected: Option<&'a SessionManagerPointerTarget>,
    collapsed: &'a BTreeSet<SessionGroup>,
    focused: bool,
    pinned: &'a BTreeSet<SessionId>,
    animation_frame: usize,
    now_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionManagerPointerTarget {
    Session(SessionId),
    Group(SessionGroup),
}

pub(crate) fn draw_manager(
    frame: &mut Frame<'_>,
    area: Rect,
    view: SessionManagerView<'_>,
    hovered: Option<&SessionManagerPointerTarget>,
    pressed: Option<&SessionManagerPointerTarget>,
    context: RenderContext<'_>,
) {
    if area.is_empty() {
        return;
    }
    let layout = manager_layout(area);
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
    let area = layout.list;
    let rows = manager_rows(view.sessions, view.pinned, view.collapsed, view.grouping);
    if rows.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::styled(
                context.localize("No sessions yet"),
                Style::default().fg(context.muted()),
            )),
            area,
        );
        return;
    }
    let visible_rows = usize::from(area.height);
    let selected_row = rows.iter().position(|row| {
        row.target()
            .as_ref()
            .is_some_and(|target| Some(target) == view.selected)
    });
    let viewport = manager_viewport(rows.len(), selected_row, visible_rows);
    let mut lines = Vec::with_capacity(visible_rows);
    if viewport.start > 0 && visible_rows > 1 {
        lines.push(more_line(
            '↑',
            viewport.start,
            usize::from(area.width),
            context,
        ));
    }
    lines.extend(
        rows[viewport.start..viewport.end]
            .iter()
            .map(|row| match row {
                ManagerRow::Heading { group, count } => group_line(
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
                        &SessionManagerPointerTarget::Group(group.clone()),
                        view.selected,
                        view.focused,
                        hovered,
                        pressed,
                    ),
                    usize::from(area.width),
                    context,
                ),
                ManagerRow::Session(session) if layout.details.is_empty() => session_line(
                    session,
                    manager_state(
                        &SessionManagerPointerTarget::Session(session.session_id.clone()),
                        view.selected,
                        view.focused,
                        hovered,
                        pressed,
                    ),
                    view.animation_frame,
                    view.now_unix_ms,
                    usize::from(area.width),
                    context,
                ),
                ManagerRow::Session(session) => table_session_line(
                    session,
                    manager_state(
                        &SessionManagerPointerTarget::Session(session.session_id.clone()),
                        view.selected,
                        view.focused,
                        hovered,
                        pressed,
                    ),
                    view.animation_frame,
                    view.now_unix_ms,
                    area.width,
                    context,
                ),
                ManagerRow::Gap => Line::default(),
            }),
    );
    if viewport.end < rows.len() && visible_rows > 1 {
        lines.push(more_line(
            '↓',
            rows.len() - viewport.end,
            usize::from(area.width),
            context,
        ));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

pub(crate) fn pointer_target_at(
    area: Rect,
    view: SessionManagerView<'_>,
    position: ratatui::layout::Position,
) -> Option<SessionManagerPointerTarget> {
    let area = manager_layout(area).list;
    if !area.contains(position) {
        return None;
    }
    let rows = manager_rows(view.sessions, view.pinned, view.collapsed, view.grouping);
    let selected_row = rows.iter().position(|row| {
        row.target()
            .as_ref()
            .is_some_and(|target| Some(target) == view.selected)
    });
    let visible_rows = usize::from(area.height);
    let viewport = manager_viewport(rows.len(), selected_row, visible_rows);
    let mut row = usize::from(position.y - area.y);
    if viewport.start > 0 && visible_rows > 1 {
        row = row.checked_sub(1)?;
    }
    let index = viewport.start.saturating_add(row);
    (index < viewport.end)
        .then(|| rows[index].target())
        .flatten()
}

/// Rendering and hit testing use the same split. Narrow terminals keep the list readable;
/// the existing details and preview actions still expose the selected Session in full.
struct ManagerLayout {
    header: Rect,
    list: Rect,
    divider: Rect,
    details: Rect,
}

fn manager_layout(area: Rect) -> ManagerLayout {
    let panel = PanelLayout::new(area, 0);
    let header = Rect::new(area.x, panel.title.y, area.width, panel.title.height);
    let body = Rect {
        // The manager owns the full-width status-marker column; the panel owns vertical spacing.
        x: area.x,
        width: area.width,
        ..panel.body
    };
    if area.width < 96 || body.height < 3 {
        return ManagerLayout {
            header,
            list: body,
            divider: Rect::default(),
            details: Rect::default(),
        };
    }
    let list_width = area.width / 3 * 2;
    ManagerLayout {
        header,
        list: Rect::new(body.x, body.y + 1, list_width, body.height - 1),
        divider: Rect::new(body.x + list_width, body.y, 1, body.height),
        details: Rect::new(
            body.x + list_width + 2,
            body.y,
            area.width - list_width - 3,
            body.height,
        ),
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
            session_title_style(&session.session_id, state, context),
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
        Some(SessionManagerPointerTarget::Session(id)) => {
            if let Some(session) = view
                .sessions
                .iter()
                .find(|session| &session.session_id == id)
            {
                lines.push(Line::styled(
                    session.title.clone(),
                    heading.patch(session_title_style(
                        id,
                        InteractionState::default(),
                        context,
                    )),
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
        Some(SessionManagerPointerTarget::Group(group)) => {
            let members = manager_rows(view.sessions, view.pinned, &BTreeSet::new(), view.grouping)
                .into_iter()
                .find_map(|row| match row {
                    ManagerRow::Heading {
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

#[derive(Clone)]
enum ManagerRow<'a> {
    Heading { group: SessionGroup, count: usize },
    Session(&'a Session),
    Gap,
}

impl ManagerRow<'_> {
    fn target(&self) -> Option<SessionManagerPointerTarget> {
        match self {
            Self::Heading { group, .. } => Some(SessionManagerPointerTarget::Group(group.clone())),
            Self::Session(session) => Some(SessionManagerPointerTarget::Session(
                session.session_id.clone(),
            )),
            Self::Gap => None,
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum SessionGroup {
    LocalProject(std::path::PathBuf),
    RemoteProject { host: String, root: String },
    NoProject,
    Model(String),
    NoModel,
    Archived,
    Pinned,
    NeedsInput,
    Working,
    ReadyForReview,
    Failed,
    Stopped,
    Completed,
    Idle,
}

impl SessionGroup {
    const ALL: [Self; 9] = [
        Self::Pinned,
        Self::NeedsInput,
        Self::Working,
        Self::ReadyForReview,
        Self::Failed,
        Self::Stopped,
        Self::Completed,
        Self::Idle,
        Self::Archived,
    ];

    fn label(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::LocalProject(root) => return root.to_string_lossy(),
            Self::RemoteProject { host, root } => return format!("{host}:{root}").into(),
            Self::Model(model) => return model.as_str().into(),
            Self::NoProject => "No project",
            Self::NoModel => "No model selected",
            Self::Archived => "Archived",
            Self::Pinned => "Pinned",
            Self::NeedsInput => "Needs input",
            Self::Working => "Working",
            Self::ReadyForReview => "Ready for review",
            Self::Failed => "Failed",
            Self::Stopped => "Stopped",
            Self::Completed => "Completed",
            Self::Idle => "Idle",
        }
        .into()
    }

    fn includes(&self, session: &Session, pinned: &BTreeSet<SessionId>) -> bool {
        if session.status == SessionStatus::Archived {
            return self == &Self::Archived;
        }
        let is_pinned = pinned.contains(&session.session_id);
        match self {
            Self::LocalProject(_)
            | Self::RemoteProject { .. }
            | Self::NoProject
            | Self::Model(_)
            | Self::NoModel => false,
            Self::Archived => false,
            Self::Pinned => is_pinned,
            Self::NeedsInput => {
                !is_pinned && session.manager.status == SessionManagerStatus::NeedsInput
            }
            Self::Working => !is_pinned && session.manager.status == SessionManagerStatus::Working,
            Self::ReadyForReview => {
                !is_pinned && session.manager.status == SessionManagerStatus::ReadyForReview
            }
            Self::Failed => !is_pinned && session.manager.status == SessionManagerStatus::Failed,
            Self::Stopped => !is_pinned && session.manager.status == SessionManagerStatus::Stopped,
            Self::Completed => {
                !is_pinned && session.manager.status == SessionManagerStatus::Completed
            }
            Self::Idle => !is_pinned && session.manager.status == SessionManagerStatus::Idle,
        }
    }
}

fn manager_rows<'a>(
    sessions: &'a [Session],
    pinned: &BTreeSet<SessionId>,
    collapsed: &BTreeSet<SessionGroup>,
    grouping: SessionGrouping,
) -> Vec<ManagerRow<'a>> {
    let mut rows = Vec::new();
    let groups = match grouping {
        SessionGrouping::Status => SessionGroup::ALL
            .into_iter()
            .map(|group| {
                let members = sessions
                    .iter()
                    .filter(|session| group.includes(session, pinned))
                    .collect::<Vec<_>>();
                (group, members)
            })
            .collect::<Vec<_>>(),
        SessionGrouping::Project | SessionGrouping::Model => {
            let mut groups = BTreeMap::<SessionGroup, Vec<&Session>>::new();
            for session in sessions {
                let group = if session.status == SessionStatus::Archived {
                    SessionGroup::Archived
                } else if pinned.contains(&session.session_id) {
                    SessionGroup::Pinned
                } else {
                    match grouping {
                        SessionGrouping::Project => match &session.execution_target {
                            Some(ash_protocol::SessionExecutionTarget::Local { root }) => {
                                SessionGroup::LocalProject(root.clone())
                            }
                            Some(ash_protocol::SessionExecutionTarget::Ssh { host, root }) => {
                                SessionGroup::RemoteProject {
                                    host: host.clone(),
                                    root: root.clone(),
                                }
                            }
                            None => SessionGroup::NoProject,
                        },
                        SessionGrouping::Model => match &session.model {
                            Some(model) => {
                                SessionGroup::Model(format!("{}/{}", model.provider, model.model))
                            }
                            None => SessionGroup::NoModel,
                        },
                        SessionGrouping::Status => unreachable!("status groups have a fixed order"),
                    }
                };
                groups.entry(group).or_default().push(session);
            }
            let pinned = groups.remove(&SessionGroup::Pinned);
            let archived = groups.remove(&SessionGroup::Archived).unwrap_or_default();
            let mut ordered = Vec::new();
            if let Some(pinned) = pinned {
                ordered.push((SessionGroup::Pinned, pinned));
            }
            ordered.extend(groups);
            ordered.push((SessionGroup::Archived, archived));
            ordered
        }
    };
    for (group, group_sessions) in groups {
        if group_sessions.is_empty() && group != SessionGroup::Archived {
            continue;
        }
        // Spacing belongs to the row map so drawing, scrolling and pointer hits agree.
        // Keyboard navigation only visits rows with a target.
        if !rows.is_empty() {
            rows.push(ManagerRow::Gap);
        }
        rows.push(ManagerRow::Heading {
            group: group.clone(),
            count: group_sessions.len(),
        });
        if !collapsed.contains(&group) {
            rows.extend(group_sessions.into_iter().map(ManagerRow::Session));
        }
    }
    rows
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
            session_title_style(&session.session_id, state, context),
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

fn session_title_style(
    id: &SessionId,
    state: InteractionState,
    context: RenderContext<'_>,
) -> Style {
    // A fixed hash and fixed theme-token order keep identity colors stable across
    // renames, grouping, restarts and terminal color depths. Different IDs may share a color.
    let hash = id
        .as_str()
        .bytes()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    let colors = [
        context.accent(),
        context.keyword(),
        context.string(),
        context.function(),
        context.variable(),
    ];
    Style::default()
        .fg(colors[(hash % colors.len() as u64) as usize])
        .patch(interaction_style(context, state))
}

fn manager_state(
    target: &SessionManagerPointerTarget,
    selected: Option<&SessionManagerPointerTarget>,
    focused: bool,
    hovered: Option<&SessionManagerPointerTarget>,
    pressed: Option<&SessionManagerPointerTarget>,
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

fn current_unix_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_millis();
    u64::try_from(millis).expect("Unix millisecond timestamp must fit u64")
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

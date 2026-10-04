//! Dashboard selection, grouping and expansion state; independent of terminal geometry.

mod view;

pub(crate) use view::draw_manager;
pub(crate) use view::pointer_target_at;

use super::SessionGrouping;
use crate::keymap::bindings;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerStatus;
use ash_protocol::SessionStatus;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const ANIMATION_INTERVAL: Duration = Duration::from_millis(80);

#[derive(Debug)]
pub(crate) struct SessionManagerState {
    grouping: SessionGrouping,
    selected: Option<SessionManagerTarget>,
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
        let rows = manager_items(sessions, &self.pinned, &self.collapsed, self.grouping);
        if self
            .selected
            .as_ref()
            .is_some_and(|selected| rows.iter().any(|row| &row.target() == selected))
        {
            self.update_selected_status(sessions);
            return;
        }
        self.selected = if self.selected_archived {
            Some(SessionManagerTarget::Group(SessionGroup::Archived))
        } else {
            rows.iter()
                .find(|row| matches!(row, ManagerItem::Session(_)))
                .or_else(|| rows.first())
                .map(ManagerItem::target)
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
            Some(SessionManagerTarget::Session(id)) => Some(id),
            _ => None,
        }
    }

    pub(crate) fn focus_target(
        &mut self,
        sessions: &[Session],
        target: &SessionManagerTarget,
    ) -> bool {
        if !manager_items(sessions, &self.pinned, &self.collapsed, self.grouping)
            .iter()
            .any(|row| &row.target() == target)
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
            Some(SessionManagerTarget::Group(group)) => Some(group.clone()),
            _ => None,
        }
    }

    pub(crate) fn toggle_group(&mut self, group: SessionGroup) {
        if !self.collapsed.remove(&group) {
            self.collapsed.insert(group.clone());
        }
        self.selected = Some(SessionManagerTarget::Group(group));
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
        // Count elapsed animation ticks here; the view owns the glyph sequence and its period.
        self.animation_frame = self
            .animation_frame
            .wrapping_add(usize::try_from(steps).expect("animation ticks must fit usize"));
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
        let selectable = manager_items(sessions, &self.pinned, &self.collapsed, self.grouping)
            .into_iter()
            .map(|item| item.target())
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
    selected: Option<&'a SessionManagerTarget>,
    collapsed: &'a BTreeSet<SessionGroup>,
    focused: bool,
    pinned: &'a BTreeSet<SessionId>,
    animation_frame: usize,
    now_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
/// A logical selection shared by keyboard actions and pointer hits.
pub(crate) enum SessionManagerTarget {
    Session(SessionId),
    Group(SessionGroup),
}

#[derive(Clone)]
enum ManagerItem<'a> {
    Heading { group: SessionGroup, count: usize },
    Session(&'a Session),
}

impl ManagerItem<'_> {
    fn target(&self) -> SessionManagerTarget {
        match self {
            Self::Heading { group, .. } => SessionManagerTarget::Group(group.clone()),
            Self::Session(session) => SessionManagerTarget::Session(session.session_id.clone()),
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

fn manager_items<'a>(
    sessions: &'a [Session],
    pinned: &BTreeSet<SessionId>,
    collapsed: &BTreeSet<SessionGroup>,
    grouping: SessionGrouping,
) -> Vec<ManagerItem<'a>> {
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
        rows.push(ManagerItem::Heading {
            group: group.clone(),
            count: group_sessions.len(),
        });
        if !collapsed.contains(&group) {
            rows.extend(group_sessions.into_iter().map(ManagerItem::Session));
        }
    }
    rows
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

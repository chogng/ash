use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use ash_protocol::Session;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_utils_elapsed::format_compact_duration;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

pub(crate) const DEFAULT_MAX_ROWS: usize = 4;
const MARKER_WIDTH: usize = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentThreadRow {
    pub(crate) thread_id: ThreadId,
    pub(crate) label: String,
    pub(crate) completed_turn_duration_ms: u64,
    pub(crate) active_turn_started_at_unix_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub(crate) struct AgentThreadSwitcher {
    rows: Vec<AgentThreadRow>,
    selected: Option<ThreadId>,
    viewed: Option<ThreadId>,
    viewport_start: usize,
    focused: bool,
    now_unix_ms: u64,
}

impl AgentThreadSwitcher {
    pub(crate) fn reconcile(
        &mut self,
        session: Option<&Session>,
        viewed_thread: Option<&ThreadId>,
    ) {
        self.refresh_elapsed();
        self.rows = session.map(switchable_rows).unwrap_or_default();
        self.viewed = viewed_thread
            .filter(|viewed| self.rows.iter().any(|row| &row.thread_id == *viewed))
            .cloned();
        let selected_is_valid = self
            .selected
            .as_ref()
            .is_some_and(|selected| self.rows.iter().any(|row| &row.thread_id == selected));
        if !selected_is_valid {
            self.selected = viewed_thread
                .filter(|viewed| self.rows.iter().any(|row| &row.thread_id == *viewed))
                .cloned()
                .or_else(|| self.rows.first().map(|row| row.thread_id.clone()));
        }
        self.keep_selection_visible(DEFAULT_MAX_ROWS);
        if self.rows.is_empty() {
            self.focused = false;
        }
    }

    pub(crate) fn focus(&mut self) -> bool {
        if self.rows.is_empty() {
            return false;
        }
        self.focused = true;
        true
    }

    pub(crate) fn blur(&mut self) {
        self.focused = false;
    }

    pub(crate) fn focused(&self) -> bool {
        self.focused
    }

    pub(crate) fn navigate(&mut self, navigation: crate::widgets::navigation::Navigation) {
        let Some(last) = self.rows.len().checked_sub(1) else {
            return;
        };
        let index = navigation.offset(self.selected_index().unwrap_or(0), last, DEFAULT_MAX_ROWS);
        self.selected = Some(self.rows[index].thread_id.clone());
        self.keep_selection_visible(DEFAULT_MAX_ROWS);
    }

    pub(crate) fn selected(&self) -> Option<&ThreadId> {
        self.selected.as_ref()
    }

    pub(crate) fn focus_pointer(&mut self, thread_id: &ThreadId) -> bool {
        if !self.rows.iter().any(|row| &row.thread_id == thread_id) {
            return false;
        }
        self.selected = Some(thread_id.clone());
        self.focused = true;
        self.keep_selection_visible(DEFAULT_MAX_ROWS);
        true
    }

    pub(crate) fn view(&self) -> AgentThreadSwitcherView<'_> {
        let end = self
            .viewport_start
            .saturating_add(DEFAULT_MAX_ROWS)
            .min(self.rows.len());
        AgentThreadSwitcherView {
            rows: &self.rows[self.viewport_start..end],
            selected: self.selected.as_ref(),
            viewed: self.viewed.as_ref(),
            focused: self.focused,
            now_unix_ms: self.now_unix_ms,
        }
    }

    pub(crate) fn desired_rows(&self) -> u16 {
        u16::try_from(self.rows.len().min(DEFAULT_MAX_ROWS)).unwrap_or(u16::MAX)
    }

    pub(crate) fn refresh_elapsed(&mut self) -> bool {
        let now_unix_ms = current_unix_millis();
        let visible_second_changed =
            !self.rows.is_empty() && self.now_unix_ms / 1_000 != now_unix_ms / 1_000;
        self.now_unix_ms = now_unix_ms;
        visible_second_changed
    }

    fn selected_index(&self) -> Option<usize> {
        let selected = self.selected.as_ref()?;
        self.rows.iter().position(|row| &row.thread_id == selected)
    }

    fn keep_selection_visible(&mut self, max_rows: usize) {
        let Some(index) = self.selected_index() else {
            self.viewport_start = 0;
            return;
        };
        if index < self.viewport_start {
            self.viewport_start = index;
        } else if index >= self.viewport_start.saturating_add(max_rows) {
            self.viewport_start = index.saturating_add(1).saturating_sub(max_rows);
        }
    }
}

pub(crate) struct AgentThreadSwitcherView<'a> {
    pub(crate) rows: &'a [AgentThreadRow],
    pub(crate) selected: Option<&'a ThreadId>,
    pub(crate) viewed: Option<&'a ThreadId>,
    pub(crate) focused: bool,
    pub(crate) now_unix_ms: u64,
}

pub(crate) fn draw_agent_thread_switcher(
    frame: &mut Frame<'_>,
    area: Rect,
    view: AgentThreadSwitcherView<'_>,
    hovered: Option<&ThreadId>,
    pressed: Option<&ThreadId>,
    context: RenderContext<'_>,
) {
    let lines = view
        .rows
        .iter()
        .map(|row| {
            let selected = view.selected == Some(&row.thread_id);
            let active = view.viewed == Some(&row.thread_id);
            let hovered = hovered == Some(&row.thread_id);
            let pressed = pressed == Some(&row.thread_id);
            let marker = if active { '●' } else { '○' };
            let style = if view.focused && selected || active || hovered || pressed {
                interaction_style(
                    context,
                    InteractionState {
                        target: if active {
                            InteractionTarget::Active
                        } else {
                            InteractionTarget::Rest
                        },
                        selected: view.focused && selected,
                        hovered,
                        pressed,
                    },
                )
            } else {
                Style::default().fg(context.muted())
            };
            let active_turn_duration_ms = row
                .active_turn_started_at_unix_ms
                .map(|started_at| view.now_unix_ms.saturating_sub(started_at))
                .unwrap_or_default();
            let elapsed = row
                .completed_turn_duration_ms
                .saturating_add(active_turn_duration_ms);
            Line::styled(
                row_text(
                    marker,
                    &row.label,
                    &format_compact_duration(Duration::from_millis(elapsed)),
                    usize::from(area.width),
                ),
                style,
            )
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
}

pub(crate) fn pointer_target_at(
    area: Rect,
    view: AgentThreadSwitcherView<'_>,
    position: ratatui::layout::Position,
) -> Option<ThreadId> {
    if !area.contains(position) {
        return None;
    }
    view.rows
        .get(usize::from(position.y - area.y))
        .map(|row| row.thread_id.clone())
}

fn row_text(marker: char, label: &str, elapsed: &str, width: usize) -> String {
    let elapsed_width = elapsed.width();
    let name_width = width.saturating_sub(MARKER_WIDTH + elapsed_width + 1);
    let name = truncate_to_width(label, name_width);
    let left = format!("{marker} {name}");
    let gap = width
        .saturating_sub(left.width() + elapsed_width)
        .max(usize::from(width > left.width() + elapsed_width));
    format!("{left}{}{elapsed}", " ".repeat(gap))
}

fn truncate_to_width(text: &str, width: usize) -> String {
    text.chars()
        .scan(0, |used, character| {
            let character_width = character.width().unwrap_or(0);
            (*used + character_width <= width).then(|| {
                *used += character_width;
                character
            })
        })
        .collect()
}

fn current_unix_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_millis();
    u64::try_from(millis).expect("Unix millisecond timestamp must fit u64")
}

fn switchable_rows(session: &Session) -> Vec<AgentThreadRow> {
    let child_rows = session
        .threads
        .iter()
        .filter(|thread| {
            thread.status == ThreadStatus::Active
                && thread.parent_thread_id.is_some()
                && thread.forked_from_id.is_none()
        })
        .map(|thread| AgentThreadRow {
            thread_id: thread.thread_id.clone(),
            label: thread.title.to_lowercase(),
            completed_turn_duration_ms: thread.completed_turn_duration_ms,
            active_turn_started_at_unix_ms: thread.active_turn_started_at_unix_ms,
        })
        .collect::<Vec<_>>();
    if child_rows.is_empty() {
        return Vec::new();
    }

    let mut rows = Vec::with_capacity(child_rows.len().saturating_add(1));
    if let Some(root) = session.threads.iter().find(|thread| {
        thread.thread_id.as_str() == session.session_id.as_str()
            && thread.status == ThreadStatus::Active
    }) {
        rows.push(AgentThreadRow {
            thread_id: root.thread_id.clone(),
            label: "main".into(),
            completed_turn_duration_ms: root.completed_turn_duration_ms,
            active_turn_started_at_unix_ms: root.active_turn_started_at_unix_ms,
        });
    }
    rows.extend(child_rows);
    rows
}

#[cfg(test)]
#[path = "agent_switcher_tests.rs"]
mod tests;

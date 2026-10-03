use super::browsing;
use crate::app::App;
use crate::app::chat_view::Content;
use crate::app::chat_view::MIN_TRANSCRIPT_ROWS;
use crate::app::chat_view::Presentation;
use crate::app::chat_view::SessionAreas;
use crate::app::chat_view::session_areas;
use crate::thread::composer as chat_input;
use ratatui::layout::Rect;

const STATUSLINE_ROWS: u16 = 2;
const PANEL_FOOTER_ROWS: u16 = 2;
const ACTIVE_TRANSCRIPT_ROWS: u16 = 8;

pub(in crate::app) fn layout(app: &App, area: Rect) -> Layout {
    let minimum = if browsing(app) {
        MIN_TRANSCRIPT_ROWS
    } else {
        0
    };
    layout_with_minimum(app, area, minimum)
}

pub(super) fn height(app: &App, screen: Rect) -> u16 {
    let areas = layout(app, screen);
    let controls = screen
        .height
        .saturating_sub(areas.session.transcript.height);
    // A stable live area keeps completed blocks adjacent in the main-screen history.
    controls
        .saturating_add(ACTIVE_TRANSCRIPT_ROWS)
        .min(screen.height)
        .max(1)
}

fn layout_with_minimum(app: &App, terminal_area: Rect, min_transcript_rows: u16) -> Layout {
    if let Some(panel) = app.command_panel() {
        return Layout {
            session: command_panel_areas(
                terminal_area,
                super::panel::desired_height(panel, terminal_area.width),
                PANEL_FOOTER_ROWS,
            ),
            input: Rect::default(),
        };
    }
    if app.session_preview().is_some() {
        let session = session_areas(terminal_area, 0, 0, 0, 0, 1, 1, 0, min_transcript_rows);
        return Layout {
            input: Rect::default(),
            session,
        };
    }
    let content = if app.session_manager_view().is_some() || app.issue_manager().is_some() {
        Content::Navigation
    } else {
        Content::Conversation
    };
    let chat = crate::app::chat_view::layout(
        app,
        terminal_area,
        Presentation {
            chrome: chat_input::ChatInputChrome::Standard,
            margin: 0,
            placeholder: None,
            content,
            footer_rows: match content {
                Content::Conversation => STATUSLINE_ROWS,
                Content::Navigation => PANEL_FOOTER_ROWS,
            },
            min_transcript_rows,
        },
    );
    let mut session = chat.session;
    if matches!(content, Content::Conversation) {
        // Inline context hints replace the second status row rather than reserving another row.
        session.statusline.height += session.hintline.height;
    }
    Layout {
        session,
        input: chat.input,
    }
}

pub(in crate::app) struct Layout {
    pub(in crate::app) session: SessionAreas,
    pub(in crate::app) input: Rect,
}

impl Layout {
    pub(in crate::app) fn completion_area(&self) -> Rect {
        Rect {
            x: self.session.transcript.x,
            y: self.session.transcript.y,
            width: self.session.transcript.width,
            height: self.input.y.saturating_sub(self.session.transcript.y),
        }
    }

    pub(in crate::app) fn transient_area(&self) -> Rect {
        Rect {
            x: self.session.transcript.x,
            y: self.session.transcript.y,
            width: self.session.transcript.width,
            height: self
                .session
                .hintline
                .y
                .saturating_sub(self.session.transcript.y),
        }
    }
}

const MIN_MANAGER_ROWS: u16 = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::app) struct ManagerAreas {
    pub(in crate::app) welcome: Rect,
    pub(in crate::app) sessions: Rect,
}

pub(in crate::app) fn manager_areas(area: Rect, welcome_desired_rows: u16) -> ManagerAreas {
    let sessions_rows = MIN_MANAGER_ROWS.min(area.height);
    let available_above_sessions = area.height.saturating_sub(sessions_rows);
    let gap_rows = u16::from(available_above_sessions > 0);
    let welcome_rows = welcome_desired_rows.min(available_above_sessions.saturating_sub(gap_rows));
    let sessions_y = area.y.saturating_add(welcome_rows).saturating_add(gap_rows);
    ManagerAreas {
        welcome: Rect {
            height: welcome_rows,
            ..area
        },
        sessions: Rect {
            y: sessions_y,
            height: area
                .y
                .saturating_add(area.height)
                .saturating_sub(sessions_y),
            ..area
        },
    }
}

pub(in crate::app) fn command_panel_areas(
    area: Rect,
    desired_rows: u16,
    hint_rows: u16,
) -> SessionAreas {
    let hint_rows = hint_rows.min(area.height);
    let panel_rows = desired_rows.min(area.height.saturating_sub(hint_rows));
    let panel_y = area
        .bottom()
        .saturating_sub(hint_rows)
        .saturating_sub(panel_rows);
    SessionAreas {
        transcript: Rect::new(area.x, area.y, area.width, panel_y.saturating_sub(area.y)),
        composer: Rect::new(area.x, panel_y, area.width, panel_rows),
        hintline: Rect::new(
            area.x,
            area.bottom().saturating_sub(hint_rows),
            area.width,
            hint_rows,
        ),
        ..SessionAreas::default()
    }
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;

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
    if app.session_manager_view().is_some() {
        return screen.height.max(1);
    }
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
                super::panel::desired_height(panel, terminal_area.width, app.render_context()),
                PANEL_FOOTER_ROWS,
            ),
            input: Rect::default(),
        };
    }
    if app.session_preview().is_some() {
        let session = session_areas(terminal_area, 0, 0, 0, 0, 0, 1, 1, 0, min_transcript_rows);
        return Layout {
            input: Rect::default(),
            session,
        };
    }
    if app.session_manager_view().is_some() {
        return Layout {
            input: Rect::default(),
            session: session_areas(terminal_area, 0, 0, 0, 0, 0, 0, 1, 0, 0),
        };
    }
    let content = if app.issue_manager().is_some()
        || matches!(
            app.inline.sessions.screen(),
            Some(crate::sessions::SessionScreen::Home)
        ) {
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
    Layout {
        session: chat.session,
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
                .footer
                .hintline
                .y
                .saturating_sub(self.session.transcript.y),
        }
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
        footer: crate::app::footer::Layout::hints(Rect::new(
            area.x,
            area.bottom().saturating_sub(hint_rows),
            area.width,
            hint_rows,
        )),
        ..SessionAreas::default()
    }
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;

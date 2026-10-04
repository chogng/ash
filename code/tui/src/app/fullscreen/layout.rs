use crate::app::App;
use crate::app::chat_view::Content;
use crate::app::chat_view::MIN_TRANSCRIPT_ROWS;
use crate::app::chat_view::Presentation;
use crate::app::chat_view::SessionAreas;
use crate::app::chat_view::session_areas;
use crate::thread::composer as chat_input;
use ratatui::layout::Rect;

pub(in crate::app) fn layout(app: &App, terminal_area: Rect) -> Layout {
    let header_rows = terminal_area.height.saturating_sub(8).min(2);
    let header = Rect::new(
        terminal_area.x + 2.min(terminal_area.width),
        terminal_area.y,
        terminal_area.width.saturating_sub(4),
        header_rows.min(1),
    );
    let terminal_area = Rect::new(
        terminal_area.x,
        terminal_area.y + header_rows,
        terminal_area.width,
        terminal_area.height.saturating_sub(header_rows),
    );
    if app.issue_manager().is_some() {
        let footer_rows = terminal_area.height.min(1);
        return Layout {
            top_statusline: header,
            input: Rect::default(),
            session: SessionAreas {
                transcript: Rect {
                    height: terminal_area.height.saturating_sub(footer_rows),
                    ..terminal_area
                },
                hintline: Rect::new(
                    terminal_area.x,
                    terminal_area.bottom().saturating_sub(footer_rows),
                    terminal_area.width,
                    footer_rows,
                ),
                ..SessionAreas::default()
            },
        };
    }
    if app.session_preview().is_some() {
        let session = session_areas(terminal_area, 0, 0, 0, 0, 0, 1, 1, 0, MIN_TRANSCRIPT_ROWS);
        return Layout {
            top_statusline: header,
            input: Rect::default(),
            session,
        };
    }
    let chat = crate::app::chat_view::layout(
        app,
        terminal_area,
        Presentation {
            chrome: chat_input::ChatInputChrome::Mode(app.collaboration_mode()),
            margin: 2,
            placeholder: Some("Build anything"),
            content: if app.fullscreen.home_visible() || app.session_manager_view().is_some() {
                Content::Navigation
            } else {
                Content::Conversation
            },
            footer_rows: 2,
            min_transcript_rows: MIN_TRANSCRIPT_ROWS,
        },
    );
    Layout {
        top_statusline: header,
        session: chat.session,
        input: chat.input,
    }
}

pub(in crate::app) struct Layout {
    pub(in crate::app) top_statusline: Rect,
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
}

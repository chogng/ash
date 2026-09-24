use super::browsing;
use super::output::tail;
use crate::app::App;
use crate::render::Renderable;
use crate::thread::composer as chat_input;
use crate::thread::composer::ChatComposerSurface;
use crate::thread::goal;
use crate::thread::interaction::approval;
use crate::thread::interaction::query;
use crate::thread::plan;
use crate::thread::queue;
use ratatui::layout::Rect;

const BOTTOM_ROWS: u16 = 2;

pub(in crate::app) fn layout(app: &App, area: Rect) -> Layout {
    let minimum = if browsing(app) {
        MIN_TRANSCRIPT_ROWS
    } else {
        0
    };
    layout_with_minimum(app, area, minimum)
}

pub(super) fn height(app: &App, screen: Rect) -> u16 {
    if browsing(app) || app.overlay().is_some() || app.completion_visible() {
        return screen.height;
    }
    let areas = layout(app, screen);
    let controls = screen
        .height
        .saturating_sub(areas.session.transcript.height);
    let rows = tail(app).iter().fold(0usize, |rows, cell| {
        rows.saturating_add(cell.height(
            screen.width,
            app.render_context(),
            app.transcript_render_cache(),
        ))
    });
    controls
        .saturating_add(rows.min(u16::MAX as usize) as u16)
        .min(screen.height)
        .max(1)
}

fn layout_with_minimum(app: &App, terminal_area: Rect, min_transcript_rows: u16) -> Layout {
    if app.session_preview().is_some() {
        let session = session_areas(terminal_area, 0, 0, 0, 0, 1, 1, 0, 0, min_transcript_rows);
        return Layout {
            input: Rect::default(),
            session,
        };
    }
    if let Some(panel) = app.command_panel() {
        return Layout {
            session: command_panel_areas(
                terminal_area,
                super::panel::desired_height(panel, terminal_area.width),
                BOTTOM_ROWS,
            ),
            input: Rect::default(),
        };
    }
    let input_view = app.chat_composer_view();
    let input_rows = ChatComposerSurface {
        chrome: chat_input::ChatInputChrome::Rules,
        view: &input_view,
        cursor: chat_input::ChatInputCursor::Hidden,
        focus: chat_input::ChatInputFocus::Blurred,
    }
    .desired_height(terminal_area.width, app.render_context());
    let approval_rows = app
        .approval_view()
        .map(approval::desired_height)
        .unwrap_or_default();
    let query_rows = app
        .query_view()
        .map(query::desired_height)
        .unwrap_or_default();
    let composer_rows = if approval_rows > 0 {
        approval_rows
    } else {
        input_rows
    };
    let queue_rows = if app.session_manager_view().is_some() {
        0
    } else {
        let queue_view = app.queue_view();
        queue::desired_height(&queue_view, queue::DEFAULT_MAX_VISIBLE_ITEMS)
    };
    let session = session_areas(
        terminal_area,
        if app.session_manager_view().is_some() {
            0
        } else {
            goal::desired_height(app.goal_view())
        },
        if app.session_manager_view().is_some() {
            0
        } else {
            plan::desired_height(app.plan_view())
        },
        queue_rows,
        query_rows,
        composer_rows,
        BOTTOM_ROWS,
        app.agent_thread_switcher_rows(),
        u16::from(app.status_indicator().is_some()),
        min_transcript_rows,
    );
    let input = if approval_rows > 0 {
        Rect {
            y: session.composer.bottom(),
            height: 0,
            ..session.composer
        }
    } else {
        let height = input_rows.min(session.composer.height);
        Rect {
            y: session.composer.bottom().saturating_sub(height),
            height,
            ..session.composer
        }
    };
    Layout { session, input }
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
                .bottom
                .y
                .saturating_sub(self.session.transcript.y),
        }
    }
}

pub(super) const MIN_TRANSCRIPT_ROWS: u16 = 4;
const MIN_MANAGER_ROWS: u16 = 4;
const TOP_TIP_ROWS: u16 = 1;

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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(in crate::app) struct SessionAreas {
    pub(in crate::app) transcript: Rect,
    pub(in crate::app) goal: Rect,
    pub(in crate::app) plan: Rect,
    pub(in crate::app) queue: Rect,
    pub(in crate::app) request: Rect,
    pub(in crate::app) top_tip: Rect,
    pub(in crate::app) status_indicator: Rect,
    pub(in crate::app) composer: Rect,
    pub(in crate::app) bottom: Rect,
    pub(in crate::app) agent_thread_switcher: Rect,
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
        bottom: Rect::new(
            area.x,
            area.bottom().saturating_sub(hint_rows),
            area.width,
            hint_rows,
        ),
        ..SessionAreas::default()
    }
}

pub(in crate::app) fn session_areas(
    area: Rect,
    goal_desired_rows: u16,
    plan_desired_rows: u16,
    queue_desired_rows: u16,
    request_desired_rows: u16,
    composer_desired_rows: u16,
    bottom_desired_rows: u16,
    switcher_desired_rows: u16,
    status_desired_rows: u16,
    min_transcript_rows: u16,
) -> SessionAreas {
    let switcher_rows = switcher_desired_rows.min(area.height);
    let available_above_switcher = area.height.saturating_sub(switcher_rows);
    let bottom_rows = bottom_desired_rows.min(available_above_switcher);
    let available_above_bottom = available_above_switcher.saturating_sub(bottom_rows);
    let switcher_gap_rows =
        u16::from(switcher_rows > 0 && bottom_rows > 0).min(available_above_bottom);
    let available_above_gap = available_above_bottom.saturating_sub(switcher_gap_rows);
    let transcript_rows = min_transcript_rows.min(available_above_gap);
    let available_chrome = available_above_gap.saturating_sub(transcript_rows);
    let top_tip_rows = TOP_TIP_ROWS.min(available_chrome);
    let available_input = available_chrome.saturating_sub(top_tip_rows);
    let composer_rows = composer_desired_rows.min(available_input);
    let request_rows = request_desired_rows.min(available_input.saturating_sub(composer_rows));
    let available_inline = available_input
        .saturating_sub(composer_rows)
        .saturating_sub(request_rows);
    let status_rows = status_desired_rows.min(available_inline);
    let available_inline = available_inline.saturating_sub(status_rows);
    let queue_rows = queue_desired_rows.min(available_inline);
    let plan_rows = plan_desired_rows.min(available_inline.saturating_sub(queue_rows));
    let goal_rows = goal_desired_rows.min(
        available_inline
            .saturating_sub(queue_rows)
            .saturating_sub(plan_rows),
    );
    let bottom = area.y.saturating_add(area.height);
    let switcher_y = bottom.saturating_sub(switcher_rows);
    let bottom_y = switcher_y
        .saturating_sub(switcher_gap_rows)
        .saturating_sub(bottom_rows);
    let composer_y = bottom_y.saturating_sub(composer_rows);
    let top_tip_y = composer_y.saturating_sub(top_tip_rows);
    let status_y = top_tip_y.saturating_sub(status_rows);
    let request_y = status_y.saturating_sub(request_rows);
    let queue_y = request_y.saturating_sub(queue_rows);
    let plan_y = queue_y.saturating_sub(plan_rows);
    let goal_y = plan_y.saturating_sub(goal_rows);

    SessionAreas {
        transcript: Rect {
            height: goal_y.saturating_sub(area.y),
            ..area
        },
        goal: Rect {
            y: goal_y,
            height: goal_rows,
            ..area
        },
        plan: Rect {
            y: plan_y,
            height: plan_rows,
            ..area
        },
        queue: Rect {
            y: queue_y,
            height: queue_rows,
            ..area
        },
        request: Rect {
            y: request_y,
            height: request_rows,
            ..area
        },
        status_indicator: Rect {
            y: status_y,
            height: status_rows,
            ..area
        },
        top_tip: Rect {
            y: top_tip_y,
            height: top_tip_rows,
            ..area
        },
        composer: Rect {
            y: composer_y,
            height: composer_rows,
            ..area
        },
        bottom: Rect {
            y: bottom_y,
            height: bottom_rows,
            ..area
        },
        agent_thread_switcher: Rect {
            y: switcher_y,
            height: switcher_rows,
            ..area
        },
    }
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;

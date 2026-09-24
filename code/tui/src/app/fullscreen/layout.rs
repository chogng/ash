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
            header,
            input: Rect::default(),
            session: SessionAreas {
                transcript: Rect {
                    height: terminal_area.height.saturating_sub(footer_rows),
                    ..terminal_area
                },
                bottom: Rect::new(
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
        let session = session_areas(terminal_area, 0, 0, 0, 0, 1, 1, 0, 0, MIN_TRANSCRIPT_ROWS);
        return Layout {
            header,
            input: Rect::default(),
            session,
        };
    }
    let input_view = app.chat_composer_view();
    let input_rows = ChatComposerSurface {
        view: &input_view,
        cursor: chat_input::ChatInputCursor::Hidden,
        focus: chat_input::ChatInputFocus::Blurred,
        chrome: chat_input::ChatInputChrome::Box,
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
    let queue_rows = if app.fullscreen.home_visible() || app.session_manager_view().is_some() {
        0
    } else {
        let queue_view = app.queue_view();
        queue::desired_height(&queue_view, queue::DEFAULT_MAX_VISIBLE_ITEMS)
    };
    let session = session_areas(
        terminal_area,
        if app.fullscreen.home_visible() || app.session_manager_view().is_some() {
            0
        } else {
            goal::desired_height(app.goal_view())
        },
        if app.fullscreen.home_visible() || app.session_manager_view().is_some() {
            0
        } else {
            plan::desired_height(app.plan_view())
        },
        queue_rows,
        query_rows,
        composer_rows,
        BOTTOM_ROWS,
        if app.fullscreen.home_visible() {
            0
        } else {
            app.agent_thread_switcher_rows()
        },
        u16::from(!app.fullscreen.home_visible() && app.status_indicator().is_some()),
        MIN_TRANSCRIPT_ROWS.min(
            terminal_area
                .height
                .saturating_sub(composer_rows + BOTTOM_ROWS + TOP_TIP_ROWS),
        ),
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
    Layout {
        header,
        session,
        input,
    }
}

pub(in crate::app) struct Layout {
    pub(in crate::app) header: Rect,
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

pub(super) const MIN_TRANSCRIPT_ROWS: u16 = 4;
const TOP_TIP_ROWS: u16 = 1;

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
    let transcript_rows = if request_desired_rows > 0 {
        min_transcript_rows.min(
            available_above_gap.saturating_sub(
                TOP_TIP_ROWS
                    .saturating_add(composer_desired_rows)
                    .saturating_add(request_desired_rows),
            ),
        )
    } else {
        min_transcript_rows.min(available_above_gap)
    };
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

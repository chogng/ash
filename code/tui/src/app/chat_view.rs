//! Shared chat controls: sizing, region allocation and rendering inside a mode-owned page.

use crate::app::App;
use crate::render::RenderContext;
use crate::render::Renderable;
use crate::thread::composer as chat_input;
use crate::thread::composer::ChatComposerSurface;
use crate::thread::goal;
use crate::thread::interaction::approval;
use crate::thread::interaction::query;
use crate::thread::plan;
use crate::thread::queue;
use ratatui::Frame;
use ratatui::layout::Rect;

pub(super) const MIN_TRANSCRIPT_ROWS: u16 = 4;
const TIPLINE_ROWS: u16 = 1;

#[derive(Clone, Copy)]
pub(super) enum Content {
    Conversation,
    Navigation,
}

pub(super) struct Presentation {
    pub(super) chrome: chat_input::ChatInputChrome,
    pub(super) margin: u16,
    pub(super) placeholder: Option<&'static str>,
    pub(super) content: Content,
    pub(super) footer_rows: u16,
    pub(super) min_transcript_rows: u16,
}

pub(super) struct Layout {
    pub(super) session: SessionAreas,
    pub(super) input: Rect,
}

pub(super) fn layout(app: &App, area: Rect, presentation: Presentation) -> Layout {
    let input_view = app.chat_composer_view();
    let input_rows = ChatComposerSurface {
        chrome: presentation.chrome,
        view: &input_view,
        cursor: chat_input::ChatInputCursor::Hidden,
        focus: chat_input::ChatInputFocus::Blurred,
        placeholder: presentation.placeholder,
    }
    .desired_height(
        area.width.saturating_sub(presentation.margin * 2),
        app.render_context(),
    );
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
    let (goal_rows, plan_rows, queue_rows) = match presentation.content {
        Content::Conversation => (
            goal::desired_height(app.goal_view()),
            plan::desired_height(app.plan_view()),
            queue::desired_height(&app.queue_view(), queue::DEFAULT_MAX_VISIBLE_ITEMS),
        ),
        Content::Navigation => (0, 0, 0),
    };
    let session = session_areas(
        area,
        goal_rows,
        plan_rows,
        queue_rows,
        query_rows,
        app.turn_progress()
            .map_or(0, |progress| progress.desired_height()),
        composer_rows,
        presentation.footer_rows,
        match presentation.content {
            Content::Conversation => app.agent_thread_switcher_rows(),
            Content::Navigation => 0,
        },
        presentation.min_transcript_rows,
    );
    let height = if approval_rows > 0 {
        0
    } else {
        input_rows.min(session.composer.height)
    };
    let input = crate::render::horizontal_margin(
        Rect {
            y: session.composer.bottom().saturating_sub(height),
            height,
            ..session.composer
        },
        presentation.margin,
    );
    Layout { session, input }
}

#[derive(Clone, Copy)]
pub(super) enum Target<'a> {
    Approval(usize),
    Query(usize),
    Queue(queue::QueueId),
    AgentThread(&'a ash_protocol::ThreadId),
}

#[derive(Default)]
pub(super) struct Pointer<'a> {
    pub(super) hovered: Option<Target<'a>>,
    pub(super) pressed: Option<Target<'a>>,
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    app: &App,
    session: &SessionAreas,
    input: Rect,
    chrome: chat_input::ChatInputChrome,
    placeholder: Option<&'static str>,
    pointer: Pointer<'_>,
    context: RenderContext<'_>,
) {
    if let Some(progress) = app.turn_progress() {
        progress.draw(frame, session.progress, context);
    }
    if let Some(approval) = app.approval_view() {
        approval::draw(
            frame,
            session.composer,
            approval,
            match pointer.hovered {
                Some(Target::Approval(index)) => Some(index),
                _ => None,
            },
            match pointer.pressed {
                Some(Target::Approval(index)) => Some(index),
                _ => None,
            },
            context,
        );
    } else {
        let input_view = app.chat_composer_view();
        ChatComposerSurface {
            chrome,
            view: &input_view,
            cursor: if app.accepts_input() && app.chat_input_focused() {
                chat_input::ChatInputCursor::Visible
            } else {
                chat_input::ChatInputCursor::Hidden
            },
            focus: if app.chat_input_focused() {
                chat_input::ChatInputFocus::Focused
            } else {
                chat_input::ChatInputFocus::Blurred
            },
            placeholder,
        }
        .render(frame, input, context);
    }
    if let Some(query) = app.query_view() {
        query::draw(
            frame,
            session.request,
            query,
            match pointer.hovered {
                Some(Target::Query(index)) => Some(index),
                _ => None,
            },
            match pointer.pressed {
                Some(Target::Query(index)) => Some(index),
                _ => None,
            },
            context,
        );
    }
    goal::draw(frame, session.goal, app.goal_view(), context);
    plan::draw(frame, session.plan, app.plan_view(), context);
    queue::draw(
        frame,
        session.queue,
        &app.queue_view(),
        queue::DEFAULT_MAX_VISIBLE_ITEMS,
        match pointer.hovered {
            Some(Target::Queue(id)) => Some(id),
            _ => None,
        },
        match pointer.pressed {
            Some(Target::Queue(id)) => Some(id),
            _ => None,
        },
        context,
    );
    if let Some(switcher) = app.agent_thread_switcher_view() {
        crate::thread::draw_agent_thread_switcher(
            frame,
            chat_input::content_area(session.agent_thread_switcher),
            switcher,
            match pointer.hovered {
                Some(Target::AgentThread(id)) => Some(id),
                _ => None,
            },
            match pointer.pressed {
                Some(Target::AgentThread(id)) => Some(id),
                _ => None,
            },
            context,
        );
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(in crate::app) struct SessionAreas {
    pub(in crate::app) transcript: Rect,
    pub(in crate::app) goal: Rect,
    pub(in crate::app) plan: Rect,
    pub(in crate::app) queue: Rect,
    pub(in crate::app) request: Rect,
    pub(in crate::app) progress: Rect,
    pub(in crate::app) tipline: Rect,
    pub(in crate::app) composer: Rect,
    pub(in crate::app) footer: super::footer::Layout,
    pub(in crate::app) agent_thread_switcher: Rect,
}

pub(in crate::app) fn session_areas(
    area: Rect,
    goal_desired_rows: u16,
    plan_desired_rows: u16,
    queue_desired_rows: u16,
    request_desired_rows: u16,
    progress_desired_rows: u16,
    composer_desired_rows: u16,
    bottom_desired_rows: u16,
    switcher_desired_rows: u16,
    min_transcript_rows: u16,
) -> SessionAreas {
    let switcher_rows = switcher_desired_rows.min(area.height);
    let available_above_switcher = area.height.saturating_sub(switcher_rows);
    let bottom_rows = bottom_desired_rows.min(available_above_switcher);
    let available_above_bottom = available_above_switcher.saturating_sub(bottom_rows);
    let switcher_gap_rows =
        u16::from(switcher_rows > 0 && bottom_rows > 0).min(available_above_bottom);
    let available_above_gap = available_above_bottom.saturating_sub(switcher_gap_rows);
    // Browsing history must not hide a pending question that fits with its input.
    let transcript_rows = if request_desired_rows > 0 {
        min_transcript_rows.min(
            available_above_gap.saturating_sub(
                TIPLINE_ROWS
                    .saturating_add(progress_desired_rows)
                    .saturating_add(composer_desired_rows)
                    .saturating_add(request_desired_rows),
            ),
        )
    } else {
        min_transcript_rows.min(available_above_gap)
    };
    let available_chrome = available_above_gap.saturating_sub(transcript_rows);
    // Status stays outside history so scrolling cannot hide the running turn or its stop key.
    // Questions and input take priority on short terminals; the status precedes optional tips.
    let progress_rows = progress_desired_rows.min(
        available_chrome
            .saturating_sub(composer_desired_rows)
            .saturating_sub(request_desired_rows),
    );
    let tipline_rows = if request_desired_rows > 0 || progress_rows > 0 {
        TIPLINE_ROWS.min(
            available_chrome
                .saturating_sub(progress_rows)
                .saturating_sub(composer_desired_rows)
                .saturating_sub(request_desired_rows),
        )
    } else {
        TIPLINE_ROWS.min(available_chrome)
    };
    let available_input = available_chrome
        .saturating_sub(tipline_rows)
        .saturating_sub(progress_rows);
    let composer_rows = composer_desired_rows.min(available_input);
    let request_rows = request_desired_rows.min(available_input.saturating_sub(composer_rows));
    let available_inline = available_input
        .saturating_sub(composer_rows)
        .saturating_sub(request_rows);
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
    let tipline_y = composer_y.saturating_sub(tipline_rows);
    let progress_y = tipline_y.saturating_sub(progress_rows);
    let request_y = progress_y.saturating_sub(request_rows);
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
        progress: Rect {
            y: progress_y,
            height: progress_rows,
            ..area
        },
        tipline: Rect {
            y: tipline_y,
            height: tipline_rows,
            ..area
        },
        composer: Rect {
            y: composer_y,
            height: composer_rows,
            ..area
        },
        footer: super::footer::Layout::new(Rect {
            y: bottom_y,
            height: bottom_rows,
            ..area
        }),
        agent_thread_switcher: Rect {
            y: switcher_y,
            height: switcher_rows,
            ..area
        },
    }
}

#[cfg(test)]
#[path = "chat_view_tests.rs"]
mod tests;

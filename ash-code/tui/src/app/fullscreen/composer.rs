use super::layout::Layout;
use crate::app::App;
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
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

pub(super) fn draw(
    frame: &mut Frame<'_>,
    app: &App,
    areas: &Layout,
    context: crate::render::RenderContext<'_>,
) {
    let hovered = app.fullscreen.pointer.hovered();
    let pressed = app.fullscreen.pointer.pressed();
    let cursor = if app.accepts_input() && app.chat_input_focused() {
        chat_input::ChatInputCursor::Visible
    } else {
        chat_input::ChatInputCursor::Hidden
    };
    let focus = if app.chat_input_focused() {
        chat_input::ChatInputFocus::Focused
    } else {
        chat_input::ChatInputFocus::Blurred
    };
    let input_view = app.chat_composer_view();
    if let Some(approval) = app.approval_view() {
        let hovered = match hovered {
            Some(super::pointer::PointerTarget::Approval(index)) => Some(*index),
            _ => None,
        };
        let pressed = match pressed {
            Some(super::pointer::PointerTarget::Approval(index)) => Some(*index),
            _ => None,
        };
        approval::draw(
            frame,
            areas.session.composer,
            approval,
            hovered,
            pressed,
            context,
        );
    } else {
        ChatComposerSurface {
            view: &input_view,
            cursor,
            focus,
            chrome: chat_input::ChatInputChrome::Box,
        }
        .render(frame, areas.input, context);
        let border = chat_input::ChatInputChrome::Box.border_area(areas.input);
        if border.height >= 3 && border.width >= 8 {
            let model = crate::render::truncate_with_ellipsis(
                &context.localize(app.status_line().model_label()),
                usize::from(border.width.saturating_sub(6)),
            );
            let label = Line::from(format!(" {model} "));
            let width = label.width() as u16;
            frame.render_widget(
                Paragraph::new(label).style(Style::default().fg(context.muted())),
                Rect::new(border.right() - 2 - width, border.bottom() - 1, width, 1),
            );
        }
    }
    if let Some(query) = app.query_view() {
        let hovered = match hovered {
            Some(super::pointer::PointerTarget::Query(index)) => Some(*index),
            _ => None,
        };
        let pressed = match pressed {
            Some(super::pointer::PointerTarget::Query(index)) => Some(*index),
            _ => None,
        };
        query::draw(
            frame,
            areas.session.request,
            query,
            hovered,
            pressed,
            context,
        );
    }
    if !app.fullscreen.home_visible() && app.session_manager_view().is_none() {
        goal::draw(frame, areas.session.goal, app.goal_view(), context);
        plan::draw(frame, areas.session.plan, app.plan_view(), context);
        let queue_view = app.queue_view();
        queue::draw(
            frame,
            areas.session.queue,
            &queue_view,
            queue::DEFAULT_MAX_VISIBLE_ITEMS,
            match hovered {
                Some(super::pointer::PointerTarget::Queue(id)) => Some(*id),
                _ => None,
            },
            match pressed {
                Some(super::pointer::PointerTarget::Queue(id)) => Some(*id),
                _ => None,
            },
            context,
        );
    }
    super::footer::draw(frame, areas.session.bottom, app, context);
    if !app.fullscreen.home_visible()
        && let Some(agent_thread_switcher) = app.agent_thread_switcher_view()
    {
        crate::thread::draw_agent_thread_switcher(
            frame,
            chat_input::content_area(areas.session.agent_thread_switcher),
            agent_thread_switcher,
            match hovered {
                Some(super::pointer::PointerTarget::AgentThread(thread_id)) => Some(thread_id),
                _ => None,
            },
            match pressed {
                Some(super::pointer::PointerTarget::AgentThread(thread_id)) => Some(thread_id),
                _ => None,
            },
            context,
        );
    }
    if !app.fullscreen.home_visible()
        && let Some(indicator) = app.status_indicator()
    {
        indicator.draw(frame, areas.session.status_indicator, context);
    }
    super::footer::draw_tip(frame, areas.session.top_tip, app, context);
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod tests;

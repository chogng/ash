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
use ash_protocol::CollaborationMode;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
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
            chrome: chat_input::ChatInputChrome::Mode(app.collaboration_mode()),
            view: &input_view,
            cursor,
            focus,
            placeholder: Some("Build anything"),
        }
        .render(frame, areas.input, context);
        if let Some(labels) = labels(app, areas.input, context) {
            frame.render_widget(
                Paragraph::new(labels.model).style(Style::default().fg(context.muted())),
                labels.model_area,
            );
            let interaction = app.fullscreen.pointer.interaction_state(
                &super::pointer::PointerTarget::ComposerSetting(Target::Mode),
            );
            let style = Style::default()
                .fg(context.mode_color(app.collaboration_mode()))
                .patch(crate::render::interaction_style(context, interaction));
            frame.render_widget(Paragraph::new(labels.mode).style(style), labels.mode_area);
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::app) enum Target {
    Mode,
}

struct Labels {
    model: String,
    mode: String,
    model_area: Rect,
    mode_area: Rect,
}

// Drawing and pointer input share these boundaries, including localized and narrow labels.
fn labels(app: &App, input: Rect, context: crate::render::RenderContext<'_>) -> Option<Labels> {
    if input.height < 3 || input.width < 8 {
        return None;
    }
    let mode = match app.collaboration_mode() {
        CollaborationMode::Agent => String::new(),
        mode @ (CollaborationMode::Plan
        | CollaborationMode::Debug
        | CollaborationMode::Multitask
        | CollaborationMode::Ask) => {
            format!(
                " {} ",
                context.localize(chat_input::options::mode_label(mode))
            )
        }
    };
    let mode_width = crate::render::display_width(&mode) as u16;
    if mode_width + 4 > input.width {
        return None;
    }
    let model = crate::render::truncate_with_ellipsis(
        &context.localize(app.status_line().model_label()),
        usize::from(input.width.saturating_sub(mode_width + 6)),
    );
    let model = if model.is_empty() {
        String::new()
    } else if mode.is_empty() {
        format!(" {model} ")
    } else {
        format!(" {model} ·")
    };
    let model_width = crate::render::display_width(&model) as u16;
    let mode_area = Rect::new(
        input.right() - mode_width,
        input.bottom() - 1,
        mode_width,
        1,
    );
    Some(Labels {
        model,
        mode,
        model_area: Rect::new(mode_area.x - model_width, mode_area.y, model_width, 1),
        mode_area,
    })
}

pub(super) fn target_at(
    app: &App,
    input: Rect,
    position: ratatui::layout::Position,
) -> Option<Target> {
    labels(app, input, app.render_context())
        .filter(|labels| labels.mode_area.contains(position))
        .map(|_| Target::Mode)
}

pub(super) fn activate(app: &mut App, target: Target) {
    match target {
        Target::Mode => app.open_mode_picker(),
    }
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod tests;

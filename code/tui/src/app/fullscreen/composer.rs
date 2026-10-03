use super::layout::Layout;
use crate::app::App;
use crate::thread::composer as chat_input;
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
    fn pointer_target(
        target: Option<&super::pointer::PointerTarget>,
    ) -> Option<crate::app::chat_view::Target<'_>> {
        match target {
            Some(super::pointer::PointerTarget::Approval(index)) => {
                Some(crate::app::chat_view::Target::Approval(*index))
            }
            Some(super::pointer::PointerTarget::Query(index)) => {
                Some(crate::app::chat_view::Target::Query(*index))
            }
            Some(super::pointer::PointerTarget::Queue(id)) => {
                Some(crate::app::chat_view::Target::Queue(*id))
            }
            Some(super::pointer::PointerTarget::AgentThread(id)) => {
                Some(crate::app::chat_view::Target::AgentThread(id))
            }
            _ => None,
        }
    }
    crate::app::chat_view::draw(
        frame,
        app,
        &areas.session,
        areas.input,
        chat_input::ChatInputChrome::Mode(app.collaboration_mode()),
        Some("Build anything"),
        crate::app::chat_view::Pointer {
            hovered: pointer_target(app.fullscreen.pointer.hovered()),
            pressed: pointer_target(app.fullscreen.pointer.pressed()),
        },
        context,
    );
    if app.approval_view().is_none()
        && let Some(labels) = labels(app, areas.input, context)
    {
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
    super::footer::draw(frame, areas, app, context);
    super::footer::draw_tip(frame, areas.session.tipline, app, context);
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
    let mode = app
        .status_line()
        .mode_label(app.collaboration_mode())
        .map(|label| format!(" {} ", context.localize(label)))
        .unwrap_or_default();
    let mode_width = crate::render::display_width(&mode) as u16;
    if mode_width + 4 > input.width {
        return None;
    }
    let model = app
        .status_line()
        .composer_model_label()
        .map(|label| {
            crate::render::truncate_with_ellipsis(
                &context.localize(label),
                usize::from(input.width.saturating_sub(mode_width + 6)),
            )
        })
        .unwrap_or_default();
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

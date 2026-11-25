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
        chat_input::ChatInputChrome::Fullscreen,
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
    }
}

struct Labels {
    model: String,
    model_area: Rect,
}

// Drawing and pointer input share these boundaries, including localized and narrow labels.
fn labels(app: &App, input: Rect, context: crate::render::RenderContext<'_>) -> Option<Labels> {
    if input.height < 3 || input.width < 8 {
        return None;
    }
    let model = app
        .status_line()
        .composer_model_label()
        .map(|label| {
            crate::render::truncate_with_ellipsis(
                &context.localize(label),
                usize::from(input.width.saturating_sub(6)),
            )
        })
        .unwrap_or_default();
    let model = if model.is_empty() {
        String::new()
    } else {
        format!(" {model} ")
    };
    let model_width = crate::render::display_width(&model) as u16;
    Some(Labels {
        model,
        model_area: Rect::new(
            input.right() - model_width,
            input.bottom() - 1,
            model_width,
            1,
        ),
    })
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod tests;

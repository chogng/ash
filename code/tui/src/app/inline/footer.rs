use super::layout::Layout;
use crate::app::App;
use ash_memory_diagnostics::ProcessResourceDemand;
use ratatui::Frame;
use ratatui::layout::Rect;

pub(super) fn process_resource_demand(app: &App, areas: &Layout) -> ProcessResourceDemand {
    if app
        .command_panel()
        .is_some_and(|panel| super::panel::process_resources_visible(panel, areas.session.composer))
    {
        return ProcessResourceDemand::Detailed;
    }
    if !crate::app::footer::chat_visible(app) {
        return ProcessResourceDemand::Disabled;
    }
    let area = crate::render::horizontal_margin(areas.session.statusline, 2);
    if area.is_empty() || area.height < 2 {
        return ProcessResourceDemand::Disabled;
    }
    app.status_line()
        .visible_process_resources(usize::from(area.width), app.status_line_runtime())
        .map_or(
            ProcessResourceDemand::Disabled,
            ProcessResourceDemand::Summary,
        )
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    areas: &Layout,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    let context_hints = crate::app::footer::context_hintline_active(app);
    if crate::app::footer::chat_visible(app) {
        let statusline = crate::render::horizontal_margin(areas.session.statusline, 2);
        crate::status::draw_info(
            frame,
            Rect {
                height: statusline.height.saturating_sub(1),
                ..statusline
            },
            app.status_line(),
            app.status_line_runtime(),
            context,
        );
        if !context_hints {
            crate::status::draw_policy(
                frame,
                crate::render::horizontal_margin(areas.session.hintline, 2),
                app.status_line(),
                app.approval_mode_status(),
                context,
            );
        }
    }
    if context_hints {
        crate::app::footer::draw(frame, areas.session.hintline, app, context);
    }
}

pub(super) fn draw_tip(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    crate::app::footer::draw_tip(frame, area, app, app.screen_navigation_tip(), context);
}

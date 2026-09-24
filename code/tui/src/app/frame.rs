use crate::app::App;
use crate::app::fullscreen;
use crate::app::inline;
use ash_memory_diagnostics::ProcessResourceDemand;
use ratatui::Frame;
use ratatui::layout::Rect;

#[cfg(test)]
pub(crate) fn draw(frame: &mut Frame<'_>, app: &App) {
    draw_with_links(frame, app, &std::cell::RefCell::default());
}

pub(crate) fn draw_with_links(
    frame: &mut Frame<'_>,
    app: &App,
    links: &std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>,
) {
    match app.screen_mode() {
        crate::terminal::ScreenMode::Fullscreen => fullscreen::draw(frame, app, links),
        crate::terminal::ScreenMode::Inline => inline::draw(frame, app, links),
    }
}

pub(crate) fn process_resource_demand(app: &App, area: Rect) -> ProcessResourceDemand {
    match app.screen_mode() {
        crate::terminal::ScreenMode::Fullscreen => fullscreen::process_resource_demand(app, area),
        crate::terminal::ScreenMode::Inline => inline::process_resource_demand(app, area),
    }
}

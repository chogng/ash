use super::draw;
use super::header;
use crate::app::App;
use crate::terminal::TerminalSession;
use std::io;

pub(in crate::app) fn draw_terminal(terminal: &mut TerminalSession, app: &App) -> io::Result<()> {
    let screen = terminal.screen_area()?;
    // Reanchoring a shorter viewport creates empty rows when the screen is restored.
    // Keep the inline viewport at the terminal's full height across all UI states.
    terminal.set_inline_height(screen.height.max(1))?;
    terminal.draw(|frame, links| draw(frame, app, links))
}

pub(in crate::app) fn finish(terminal: &mut TerminalSession, app: &App) -> io::Result<()> {
    let screen = terminal.screen_area()?;
    // The live screen may have been resized or reflowed. Return to the shell
    // screen before writing the conversation once into its terminal history.
    terminal.prepare_inline_history()?;
    let header =
        header::history_buffer(screen.width, u16::MAX, app.welcome(), app.render_context());
    terminal.append_history(usize::from(header.area.height), |target, offset, _links| {
        for row in 0..target.area.height {
            for column in 0..target.area.width {
                target[(column, row)] = header[(column, offset as u16 + row)].clone();
            }
        }
    })?;
    for view in app.visible_transcript_views() {
        let context = app.render_context();
        let cache = app.transcript_render_cache();
        terminal.append_history(
            view.height(screen.width, context, cache),
            |buffer, offset, links| {
                view.render_rows(buffer, offset, context.with_hyperlinks(links), cache);
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;

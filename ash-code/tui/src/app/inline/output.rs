use super::browsing;
use super::draw;
use super::header;
use super::layout::height;
use crate::app::App;
use crate::terminal::TerminalSession;
use crate::thread::transcript::CellView;
use ash_protocol::ThreadId;
use std::collections::BTreeSet;
use std::io;

/// Records terminal output for the currently displayed conversation, independently of redraws.
#[derive(Default)]
pub(in crate::app) struct Output {
    thread: Option<ThreadId>,
    emitted: BTreeSet<String>,
    first: Option<String>,
    header_written: bool,
}

impl Output {
    pub(in crate::app) fn draw(
        &mut self,
        terminal: &mut TerminalSession,
        app: &App,
    ) -> io::Result<()> {
        self.select_thread(app.screen_thread_id());
        let screen = terminal.screen_area()?;
        // Release the completed reply's rows before inserting it, so it stays visible above input.
        terminal.set_inline_height(height(app, screen))?;
        if !self.header_written {
            let header =
                header::history_buffer(screen.width, u16::MAX, app.welcome(), app.render_context());
            terminal.append_history(
                usize::from(header.area.height),
                |target, offset, _links| {
                    for row in 0..target.area.height {
                        for column in 0..target.area.width {
                            target[(column, row)] = header[(column, offset as u16 + row)].clone();
                        }
                    }
                },
            )?;
            self.header_written = true;
        }
        if !browsing(app) {
            for view in self.pending(app) {
                let context = app.render_context();
                let cache = app.transcript_render_cache();
                terminal.append_history(
                    view.height(screen.width, context, cache),
                    |buffer, offset, links| {
                        view.render_rows(buffer, offset, context.with_hyperlinks(links), cache);
                    },
                )?;
                self.record(&view);
            }
        }
        terminal.draw(|frame, links| draw(frame, app, links))
    }

    fn pending<'a>(&self, app: &'a App) -> Vec<CellView<'a>> {
        let prefix = app.history_prefix();
        // Older pages stay in the transcript browser, preserving the order of terminal output.
        let start = self
            .first
            .as_ref()
            .and_then(|first| {
                prefix
                    .iter()
                    .position(|cell| cell.cell_id().as_str() == first)
            })
            .unwrap_or_default();
        prefix[start..]
            .iter()
            .filter(|cell| !self.emitted.contains(cell.cell_id().as_str()))
            .map(|cell| cell.history_view())
            .collect()
    }

    pub(in crate::app) fn finish(
        &mut self,
        terminal: &mut TerminalSession,
        app: &App,
    ) -> io::Result<()> {
        self.draw(terminal, app)?;
        let width = terminal.screen_area()?.width;
        // Quitting a history browser must also retain output finalized while it was open.
        for view in self.pending(app).into_iter().chain(tail(app)) {
            let context = app.render_context();
            let cache = app.transcript_render_cache();
            terminal.append_history(
                view.height(width, context, cache),
                |buffer, offset, links| {
                    view.render_rows(buffer, offset, context.with_hyperlinks(links), cache);
                },
            )?;
        }
        Ok(())
    }

    fn record(&mut self, view: &CellView<'_>) {
        let id = view
            .cell_id
            .as_ref()
            .expect("history cells have stable identities");
        self.emitted.insert(id.clone());
        self.first.get_or_insert_with(|| id.clone());
    }

    fn select_thread(&mut self, thread: &ThreadId) {
        if self.thread.as_ref() != Some(thread) {
            *self = Self {
                thread: Some(thread.clone()),
                ..Self::default()
            };
        }
    }
}

pub(super) fn tail(app: &App) -> Vec<CellView<'_>> {
    let prefix = app
        .history_prefix()
        .iter()
        .map(|cell| cell.cell_id().as_str())
        .collect::<BTreeSet<_>>();
    app.visible_transcript_views()
        .into_iter()
        .filter(|view| {
            !view
                .cell_id
                .as_deref()
                .is_some_and(|id| prefix.contains(id))
        })
        .collect()
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;

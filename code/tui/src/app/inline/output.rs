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

/// Commits finished content to the main screen once; mutable content stays in the viewport.
#[derive(Default)]
pub(in crate::app) struct Output {
    thread: Option<ThreadId>,
    emitted: BTreeSet<String>,
    first: Option<String>,
    header_written: bool,
    overlay_screen: Option<ratatui::layout::Rect>,
    main_viewport_top: u16,
}

impl Output {
    pub(in crate::app) fn draw(
        &mut self,
        terminal: &mut TerminalSession,
        app: &App,
    ) -> io::Result<()> {
        self.select_thread(app.screen_thread_id());
        let expanded = expanded(app);
        if expanded {
            if self.overlay_screen.is_none() {
                self.overlay_screen = Some(terminal.screen_area()?);
                self.main_viewport_top = terminal.area()?.y;
            }
        } else if let Some(before) = self.overlay_screen.take() {
            let after = terminal.screen_area()?;
            if after.height < before.height {
                self.replay_clipped_history(app, before, after.height);
            }
        }
        terminal.set_inline_overlay(expanded)?;
        if expanded {
            return terminal.draw(|frame, links| draw(frame, app, links));
        }

        let screen = terminal.screen_area()?;
        terminal.set_inline_height(height(app, screen))?;
        self.write_header(terminal, app, screen.width)?;
        for view in self.pending(app) {
            self.write_view(terminal, app, &view, screen.width)?;
            self.record(&view);
        }
        terminal.draw(|frame, links| self.draw_tail(frame, app, links))?;
        self.main_viewport_top = terminal.area()?.y;
        Ok(())
    }

    pub(in crate::app) fn finish(
        &mut self,
        terminal: &mut TerminalSession,
        app: &App,
    ) -> io::Result<()> {
        self.select_thread(app.screen_thread_id());
        if let Some(before) = self.overlay_screen.take() {
            let after = terminal.screen_area()?;
            if after.height < before.height {
                self.replay_clipped_history(app, before, after.height);
            }
        }
        terminal.set_inline_overlay(false)?;
        let width = terminal.screen_area()?.width;
        terminal.set_inline_height(1)?;
        self.write_header(terminal, app, width)?;
        for view in self.pending(app).into_iter().chain(self.tail(app)) {
            self.write_view(terminal, app, &view, width)?;
        }
        Ok(())
    }

    fn draw_tail(
        &self,
        frame: &mut ratatui::Frame<'_>,
        app: &App,
        links: &std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>,
    ) {
        super::draw_content(frame, app, links, super::Transcript::Tail(self.tail(app)));
    }

    fn tail<'a>(&self, app: &'a App) -> Vec<CellView<'a>> {
        // A transcript echo can be committed before the start request completes.
        // Learning its active Turn must not bring already-written content back into the viewport.
        tail(app)
            .into_iter()
            .filter(|view| {
                !view
                    .cell_id
                    .as_ref()
                    .is_some_and(|id| self.emitted.contains(id))
            })
            .collect()
    }

    fn write_header(
        &mut self,
        terminal: &mut TerminalSession,
        app: &App,
        width: u16,
    ) -> io::Result<()> {
        if self.header_written {
            return Ok(());
        }
        let header = header::history_buffer(width, u16::MAX, app.welcome(), app.render_context());
        terminal.append_history(usize::from(header.area.height), |target, offset, _links| {
            for row in 0..target.area.height {
                for column in 0..target.area.width {
                    target[(column, row)] = header[(column, offset as u16 + row)].clone();
                }
            }
        })?;
        self.header_written = true;
        Ok(())
    }

    fn write_view(
        &self,
        terminal: &mut TerminalSession,
        app: &App,
        view: &CellView<'_>,
        width: u16,
    ) -> io::Result<()> {
        let context = app.render_context();
        let cache = app.transcript_render_cache();
        terminal.append_history(
            view.height(width, context, cache),
            |buffer, offset, links| {
                view.render_rows(buffer, offset, context.with_hyperlinks(links), cache);
            },
        )
    }

    fn pending<'a>(&self, app: &'a App) -> Vec<CellView<'a>> {
        let prefix = app.history_prefix();
        // Older pages stay in the transcript browser, preserving terminal output order.
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

    fn replay_clipped_history(
        &mut self,
        app: &App,
        previous: ratatui::layout::Rect,
        current_height: u16,
    ) {
        let context = app.render_context();
        let cache = app.transcript_render_cache();
        let committed = app
            .history_prefix()
            .iter()
            .filter(|cell| self.emitted.contains(cell.cell_id().as_str()))
            .map(|cell| {
                let view = cell.history_view();
                (
                    cell.cell_id().as_str().to_owned(),
                    view.height(previous.width, context, cache),
                )
            })
            .collect::<Vec<_>>();
        let header_rows = if self.header_written {
            usize::from(header::desired_height(previous.width))
        } else {
            0
        };
        let total = header_rows.saturating_add(committed.iter().map(|(_, rows)| *rows).sum());
        let mut end = i64::from(self.main_viewport_top) - total as i64 + header_rows as i64;
        for (id, rows) in committed {
            end += rows as i64;
            if end > i64::from(current_height) {
                self.emitted.remove(&id);
            }
        }
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

pub(super) fn expanded(app: &App) -> bool {
    browsing(app)
        || app.command_panel().is_some()
        || app.overlay().is_some()
        || app.completion_visible()
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

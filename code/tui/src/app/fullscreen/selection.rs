use crate::render::RenderContext;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::style::Modifier;
use std::time::Duration;
use std::time::Instant;

use crate::app::App;
use crate::host::Event as HostEvent;
use crate::terminal::text::ScreenSelectionRange;
use crate::thread::Event as ThreadEvent;

const MULTI_CLICK_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScreenSelectionOutcome {
    Click {
        position: Position,
        count: ClickCount,
    },
    Selection(ScreenSelectionRange),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClickCount {
    Single,
    Double,
    Triple,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ScreenSelection {
    anchor: Option<Position>,
    focus: Option<Position>,
    dragging: bool,
    click_sequence: Option<ClickSequence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ClickSequence {
    position: Position,
    count: ClickCount,
    completed_at: Instant,
}

impl ScreenSelection {
    pub(crate) fn begin(&mut self, position: Position) {
        self.anchor = Some(position);
        self.focus = Some(position);
        self.dragging = false;
    }

    pub(crate) fn drag(&mut self, position: Position) {
        let Some(anchor) = self.anchor else {
            return;
        };
        self.focus = Some(position);
        self.dragging |= position != anchor;
        if self.dragging {
            self.click_sequence = None;
        }
    }

    pub(crate) fn finish(
        &mut self,
        position: Position,
        now: Instant,
    ) -> Option<ScreenSelectionOutcome> {
        let anchor = self.anchor?;
        self.focus = Some(position);
        self.dragging |= position != anchor;
        if self.dragging {
            self.click_sequence = None;
            Some(ScreenSelectionOutcome::Selection(
                ScreenSelectionRange::new(anchor, position),
            ))
        } else {
            self.anchor = None;
            self.focus = None;
            let count = self.next_click_count(position, now);
            self.click_sequence = Some(ClickSequence {
                position,
                count,
                completed_at: now,
            });
            Some(ScreenSelectionOutcome::Click { position, count })
        }
    }

    fn next_click_count(&self, position: Position, now: Instant) -> ClickCount {
        let Some(previous) = self.click_sequence else {
            return ClickCount::Single;
        };
        let close_position =
            previous.position.y == position.y && previous.position.x.abs_diff(position.x) <= 1;
        let within_interval = now
            .checked_duration_since(previous.completed_at)
            .is_some_and(|elapsed| elapsed <= MULTI_CLICK_INTERVAL);
        if !close_position || !within_interval {
            return ClickCount::Single;
        }
        match previous.count {
            ClickCount::Single => ClickCount::Double,
            ClickCount::Double => ClickCount::Triple,
            ClickCount::Triple => ClickCount::Single,
        }
    }

    pub(crate) fn select(&mut self, range: ScreenSelectionRange) {
        self.anchor = Some(range.start);
        self.focus = Some(range.end);
        self.dragging = true;
    }

    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn range(&self) -> Option<ScreenSelectionRange> {
        self.dragging.then(|| {
            ScreenSelectionRange::new(
                self.anchor.expect("a dragging selection has an anchor"),
                self.focus.expect("a dragging selection has a focus"),
            )
        })
    }

    pub(crate) fn draw(&self, buffer: &mut Buffer, context: RenderContext<'_>) {
        let Some(range) = self.range() else {
            return;
        };
        let foreground = context.screen_selection_foreground();
        let background = context.screen_selection_background();
        let area = buffer.area;
        for row in area.y..area.bottom() {
            for column in area.x..area.right() {
                let position = Position::new(column, row);
                if range.contains(position)
                    && let Some(cell) = buffer.cell_mut(position)
                {
                    cell.fg = foreground;
                    cell.bg = background;
                    cell.modifier.remove(Modifier::REVERSED);
                }
            }
        }
    }
}

pub(super) fn apply_screen_selection(
    app: &mut App,
    range: ScreenSelectionRange,
    read: impl FnOnce(ScreenSelectionRange) -> Option<String>,
    write: impl FnOnce(&str) -> Result<(), String>,
) {
    app.fullscreen.selection.select(range);
    let Some(text) = read(range) else {
        return;
    };
    let char_count = text.chars().count();
    match write(&text) {
        Ok(()) => app.update(HostEvent::TopTipNoticeShown(format!(
            "Copied {char_count} chars to clipboard"
        ))),
        Err(error) => app.update(ThreadEvent::FailureReported(error)),
    }
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;

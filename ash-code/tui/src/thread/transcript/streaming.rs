//! Owns the visible source boundary and commit deadlines of live transcript messages.
//! Canonical text remains in TranscriptModel; rendering never advances this state.
mod chunking;
mod render;

pub(super) use render::StreamingRender;

use self::chunking::ChunkingPolicy;
use super::CellView;
use super::MessageRole;
use super::TranscriptCell;
use super::TranscriptCellId;
use super::model::CellLifecycle;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::ops::Range;
use std::time::Duration;
use std::time::Instant;

const COMMIT_INTERVAL: Duration = Duration::from_millis(40);
const MAX_QUEUED_LINES: usize = 1024;

#[derive(Debug, Default)]
pub(crate) struct StreamDisplay {
    messages: BTreeMap<TranscriptCellId, Message>,
    queue: VecDeque<QueuedLine>,
    policy: ChunkingPolicy,
    deadline: Option<Instant>,
    next_order: u64,
    next_commit: Option<Instant>,
}

#[derive(Debug)]
struct Message {
    source: String,
    shown: usize,
    turn_id: Option<TurnId>,
    finished: bool,
}

#[derive(Debug)]
struct QueuedLine {
    cell_id: TranscriptCellId,
    source: Range<usize>,
    arrived: Instant,
    order: u64,
}

impl StreamDisplay {
    /// Snapshots and restored threads are already visible; only subsequent appends animate.
    pub(crate) fn install(&mut self, cells: &[TranscriptCell]) {
        *self = Self::default();
        for cell in cells.iter().filter(|cell| is_stream(cell)) {
            let source = cell.history_view().text().into_owned();
            self.messages.insert(
                cell.cell_id().clone(),
                Message {
                    shown: source.len(),
                    source,
                    turn_id: cell.turn_id().cloned(),
                    finished: false,
                },
            );
        }
    }

    pub(crate) fn update(&mut self, cells: &[TranscriptCell], now: Instant) {
        let live = cells
            .iter()
            .filter(|cell| is_stream(cell))
            .map(|cell| cell.cell_id())
            .collect::<BTreeSet<_>>();
        self.messages.retain(|id, _| live.contains(id));
        self.queue.retain(|line| live.contains(&line.cell_id));
        let mut flush_backlog = false;
        for cell in cells.iter().filter(|cell| is_stream(cell)) {
            let id = cell.cell_id();
            let source = cell.history_view().text().into_owned();
            let message = self.messages.entry(id.clone()).or_insert_with(|| Message {
                source: String::new(),
                shown: 0,
                turn_id: cell.turn_id().cloned(),
                finished: false,
            });
            if message.source == source {
                continue;
            }
            if message.finished || !source.starts_with(&message.source) {
                // A replacement is authoritative immediately; it cannot leave an old queue alive.
                message.shown = source.len();
                message.source = source;
                self.queue.retain(|line| &line.cell_id != id);
                continue;
            }
            let mut previous = BTreeMap::new();
            self.queue.retain(|line| {
                if &line.cell_id == id {
                    previous.insert(line.source.start, (line.arrived, line.order));
                    false
                } else {
                    true
                }
            });
            let incoming_lines = source[message.shown..]
                .split_inclusive('\n')
                .take(MAX_QUEUED_LINES)
                .count();
            if self.queue.len().saturating_add(incoming_lines) >= MAX_QUEUED_LINES {
                message.shown = source.len();
                message.source = source;
                flush_backlog = true;
                continue;
            }
            let mut start = message.shown;
            // A mutable final line replaces its queued range and keeps its original arrival time.
            // Queue source offsets remain valid independently of terminal width and Markdown reflow.
            for line in source[start..].split_inclusive('\n') {
                let end = start + line.len();
                let (arrived, order) = previous.remove(&start).unwrap_or_else(|| {
                    self.next_order += 1;
                    (now, self.next_order)
                });
                self.queue.push_back(QueuedLine {
                    cell_id: id.clone(),
                    source: start..end,
                    arrived,
                    order,
                });
                start = end;
            }
            message.source = source;
        }
        self.queue.make_contiguous().sort_by_key(|line| line.order);
        if flush_backlog {
            self.drain(self.queue.len());
            self.deadline = None;
            self.next_commit = Some(now + COMMIT_INTERVAL);
            self.policy = ChunkingPolicy::default();
        } else if self.queue.is_empty() {
            self.deadline = None;
            self.policy.drain_count(0, Duration::ZERO, now);
        } else {
            self.deadline
                .get_or_insert(self.next_commit.map_or(now, |at| at.max(now)));
            // Bursty arrivals can request catch-up before the next normal commit deadline.
            let age = now.saturating_duration_since(self.queue[0].arrived);
            if self.policy.drain_count(self.queue.len(), age, now) > 1 {
                self.deadline = Some(now);
            }
        }
    }

    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub(crate) fn advance(&mut self, now: Instant) -> bool {
        if !self.deadline.is_some_and(|deadline| deadline <= now) {
            return false;
        }
        let Some(first) = self.queue.front() else {
            self.deadline = None;
            return false;
        };
        let count = self.policy.drain_count(
            self.queue.len(),
            now.saturating_duration_since(first.arrived),
            now,
        );
        self.drain(count);
        self.next_commit = Some(now + COMMIT_INTERVAL);
        if self.queue.is_empty() {
            self.deadline = None;
            self.policy.drain_count(0, Duration::ZERO, now);
        } else {
            self.deadline = Some(now + COMMIT_INTERVAL);
        }
        count > 0
    }

    fn drain(&mut self, count: usize) {
        for _ in 0..count {
            let Some(line) = self.queue.pop_front() else {
                break;
            };
            if let Some(message) = self.messages.get_mut(&line.cell_id) {
                message.shown = line.source.end;
            }
        }
    }

    pub(crate) fn finish_turn(&mut self, turn_id: &TurnId) {
        self.finish(Some(turn_id));
    }
    pub(crate) fn finish_all(&mut self) {
        self.finish(None);
    }

    fn finish(&mut self, turn_id: Option<&TurnId>) {
        for message in self
            .messages
            .values_mut()
            .filter(|message| turn_id.is_none() || message.turn_id.as_ref() == turn_id)
        {
            message.shown = message.source.len();
            message.finished = true;
        }
        self.queue.retain(|line| {
            self.messages
                .get(&line.cell_id)
                .is_some_and(|message| !message.finished)
        });
        if self.queue.is_empty() {
            self.deadline = None;
            self.next_commit = None;
            self.policy = ChunkingPolicy::default();
        }
    }

    pub(crate) fn visible<'a>(&self, mut views: Vec<CellView<'a>>) -> Vec<CellView<'a>> {
        views.retain_mut(|view| {
            let Some(message) = self.messages.get(view.cell.cell_id()) else {
                return true;
            };
            view.visible_source_end = Some(message.shown);
            message.shown > 0
        });
        views
    }
}

fn is_stream(cell: &TranscriptCell) -> bool {
    cell.lifecycle() == CellLifecycle::Live
        && matches!(
            cell.history_view().role(),
            MessageRole::Agent | MessageRole::Plan
        )
}

#[cfg(test)]
#[path = "streaming/display_tests.rs"]
mod tests;

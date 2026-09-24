use super::ChatHistoryRenderCache;
use super::ChatHistoryScroll;
use super::TranscriptCellId;
use super::TranscriptScrollAnchor;
use super::TranscriptScrollTarget;
use ash_protocol::ThreadId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;

const MAX_VIEWPORTS: usize = 32;

#[derive(Debug, Default)]
pub(crate) struct Viewport {
    pub(crate) queue: crate::thread::queue::QueueNavigation,
    pub(crate) scroll: ChatHistoryScroll,
    pub(crate) render_cache: ChatHistoryRenderCache,
    pub(crate) expanded_cells: BTreeSet<TranscriptCellId>,
    pub(crate) selected_cell: Option<TranscriptCellId>,
}

impl Viewport {
    pub(crate) fn reconcile(&mut self, cells: &BTreeSet<TranscriptCellId>) {
        self.expanded_cells.retain(|id| cells.contains(id));
        if self
            .selected_cell
            .as_ref()
            .is_some_and(|id| !cells.contains(id))
        {
            self.selected_cell = None;
        }
        if let Some(TranscriptScrollAnchor::Cell { cell_id, .. }) = self.scroll.anchor()
            && !cells.iter().any(|id| id.as_str() == cell_id)
        {
            self.scroll.follow_latest();
        }
    }

    pub(crate) fn toggle_cell(&mut self, cell_id: &TranscriptCellId) -> bool {
        if !self.expanded_cells.remove(cell_id) {
            self.expanded_cells.insert(cell_id.clone());
        }
        self.selected_cell = Some(cell_id.clone());
        self.scroll.apply(TranscriptScrollTarget::Anchor(
            TranscriptScrollAnchor::Cell {
                cell_id: cell_id.as_str().to_owned(),
                line_offset: 0,
            },
        ));
        self.expanded_cells.contains(cell_id)
    }

    pub(crate) fn navigate_cell(
        &mut self,
        cell_ids: &[TranscriptCellId],
        navigation: crate::widgets::navigation::Navigation,
    ) {
        let Some(last) = cell_ids.len().checked_sub(1) else {
            return;
        };
        let current = self
            .selected_cell
            .as_ref()
            .and_then(|id| cell_ids.iter().position(|cell| cell == id))
            .unwrap_or(last);
        let index = navigation.offset(current, last, 12);
        let cell_id = cell_ids[index].clone();
        self.scroll.apply(TranscriptScrollTarget::Anchor(
            TranscriptScrollAnchor::Cell {
                cell_id: cell_id.as_str().to_owned(),
                line_offset: 0,
            },
        ));
        self.selected_cell = Some(cell_id);
    }

    pub(crate) fn select_previous_cell(&mut self, cell_ids: &[TranscriptCellId]) -> bool {
        let next = self
            .selected_cell
            .as_ref()
            .and_then(|selected| cell_ids.iter().position(|cell_id| cell_id == selected))
            .and_then(|index| index.checked_sub(1))
            .or_else(|| cell_ids.len().checked_sub(1));
        let Some(index) = next else {
            return false;
        };
        let cell_id = cell_ids[index].clone();
        self.scroll.apply(TranscriptScrollTarget::Anchor(
            TranscriptScrollAnchor::Cell {
                cell_id: cell_id.as_str().to_owned(),
                line_offset: 0,
            },
        ));
        self.selected_cell = Some(cell_id);
        true
    }

    pub(crate) fn select_next_cell(&mut self, cell_ids: &[TranscriptCellId]) -> bool {
        let next = self
            .selected_cell
            .as_ref()
            .and_then(|selected| cell_ids.iter().position(|cell_id| cell_id == selected))
            .map(|index| index.saturating_add(1))
            .unwrap_or_default();
        let Some(cell_id) = cell_ids.get(next).cloned() else {
            self.selected_cell = None;
            return false;
        };
        self.scroll.apply(TranscriptScrollTarget::Anchor(
            TranscriptScrollAnchor::Cell {
                cell_id: cell_id.as_str().to_owned(),
                line_offset: 0,
            },
        ));
        self.selected_cell = Some(cell_id);
        true
    }
}

#[derive(Debug)]
pub(crate) struct Viewports {
    active: ThreadId,
    states: BTreeMap<ThreadId, Viewport>,
    recent: VecDeque<ThreadId>,
}

impl Viewports {
    pub(crate) fn new(active: ThreadId) -> Self {
        Self {
            active: active.clone(),
            states: BTreeMap::from([(active.clone(), Viewport::default())]),
            recent: VecDeque::from([active]),
        }
    }

    pub(crate) fn switch(&mut self, thread_id: ThreadId) {
        if thread_id != self.active {
            self.active_mut().render_cache.clear();
        }
        self.states.entry(thread_id.clone()).or_default();
        self.active = thread_id.clone();
        self.touch(thread_id);
        self.evict_inactive();
    }

    pub(crate) fn active(&self) -> &Viewport {
        self.states
            .get(&self.active)
            .expect("the active Thread presentation state exists")
    }

    pub(crate) fn active_mut(&mut self) -> &mut Viewport {
        self.states
            .get_mut(&self.active)
            .expect("the active Thread presentation state exists")
    }

    fn touch(&mut self, thread_id: ThreadId) {
        self.recent.retain(|recent| recent != &thread_id);
        self.recent.push_back(thread_id);
    }

    fn evict_inactive(&mut self) {
        while self.states.len() > MAX_VIEWPORTS {
            let thread_id = self
                .recent
                .pop_front()
                .expect("every Thread presentation has a recency entry");
            if thread_id == self.active {
                self.recent.push_back(thread_id);
                continue;
            }
            self.states.remove(&thread_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, thread_id: &ThreadId) -> bool {
        self.states.contains_key(thread_id)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.states.len()
    }
}

#[cfg(test)]
#[path = "viewport_tests.rs"]
mod tests;

#[derive(Debug, Default)]
pub(crate) struct PreviewViewport {
    generation: Option<u64>,
    pub(crate) scroll: ChatHistoryScroll,
    pub(crate) cache: ChatHistoryRenderCache,
}

impl PreviewViewport {
    pub(crate) fn bind(&mut self, generation: Option<u64>) {
        if self.generation != generation {
            *self = Self {
                generation,
                ..Self::default()
            };
        }
    }
}

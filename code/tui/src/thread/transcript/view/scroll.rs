#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TranscriptScrollDirection {
    Up,
    Down,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TranscriptScrollAnchor {
    Header { line_offset: usize },
    Cell { cell_id: String, line_offset: usize },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TranscriptScrollTarget {
    FollowLatest,
    Anchor(TranscriptScrollAnchor),
}

#[derive(Debug, Default)]
pub(crate) struct ChatHistoryScroll {
    position: TranscriptScrollPosition,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
enum TranscriptScrollPosition {
    #[default]
    FollowLatest,
    Anchor(TranscriptScrollAnchor),
}

impl ChatHistoryScroll {
    pub(crate) fn anchor(&self) -> Option<&TranscriptScrollAnchor> {
        match &self.position {
            TranscriptScrollPosition::FollowLatest => None,
            TranscriptScrollPosition::Anchor(anchor) => Some(anchor),
        }
    }

    pub(crate) fn apply(&mut self, target: TranscriptScrollTarget) -> bool {
        let position = match target {
            TranscriptScrollTarget::FollowLatest => TranscriptScrollPosition::FollowLatest,
            TranscriptScrollTarget::Anchor(anchor) => TranscriptScrollPosition::Anchor(anchor),
        };
        if self.position == position {
            return false;
        }
        self.position = position;
        true
    }

    pub(crate) fn follow_latest(&mut self) {
        self.position = TranscriptScrollPosition::FollowLatest;
    }
}

#[cfg(test)]
#[path = "scroll_tests.rs"]
mod tests;

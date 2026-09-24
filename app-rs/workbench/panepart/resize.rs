use std::time::Instant;

use ash_ui_components::Resizable;
use ash_ui_components::SashOrientation;
use zui::ui::HoverPresence;
use zui::ui::Point;
use zui::ui::SplitViewResizeSnapshot;

use crate::PaneSplitId;
use crate::TabInputKey;

/// Active resize gesture for one Workbench PanePart split.
#[derive(Clone, Debug, PartialEq)]
pub struct PaneResizeState {
    tab: TabInputKey,
    split: PaneSplitId,
    resizable: Resizable,
}

impl PaneResizeState {
    pub fn new(
        tab: TabInputKey,
        split: PaneSplitId,
        orientation: SashOrientation,
        snapshot: SplitViewResizeSnapshot,
        point: Point,
        now: Instant,
    ) -> Option<Self> {
        let mut resizable = Resizable::new(orientation);
        resizable.begin_drag(snapshot, point, now).then_some(Self {
            tab,
            split,
            resizable,
        })
    }

    pub const fn tab(&self) -> &TabInputKey {
        &self.tab
    }

    pub const fn split(&self) -> PaneSplitId {
        self.split
    }

    pub const fn orientation(&self) -> SashOrientation {
        self.resizable.orientation()
    }

    pub fn ratio_at(&mut self, point: Point) -> Option<f32> {
        let next = self.resizable.resize_to(point)?;
        let total = next.previous_size() + next.next_size();
        (total.is_finite() && total > 0.0).then(|| (next.previous_size() / total).clamp(0.0, 1.0))
    }

    pub fn finish(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.resizable.end_drag(presence, now)
    }

    pub fn cancel(&mut self) -> bool {
        self.resizable.cancel()
    }
}

use super::ElementId;
use super::InteractionFrame;
use super::UiDispatch;

impl UiDispatch {
    pub(super) fn toggle_expansion(&mut self, id: ElementId) {
        if !self.expanded.remove(&id) {
            self.expanded.insert(id);
        }
    }

    pub(super) fn retain_mounted_view_state(&mut self, frame: &InteractionFrame) -> bool {
        let previous_expansion_count = self.expanded.len();
        let previous_value_count = self.values.len();
        self.expanded.retain(|id| frame.node(*id).is_some());
        self.values.retain(|id, _| frame.node(*id).is_some());
        self.expanded.len() != previous_expansion_count || self.values.len() != previous_value_count
    }

    /// Returns whether a view-local disclosure control is expanded.
    pub fn is_expanded(&self, id: ElementId) -> bool {
        self.expanded.contains(&id)
    }

    pub(super) fn adjust_value(&mut self, id: ElementId, delta: i32, minimum: i32, maximum: i32) {
        assert!(minimum <= maximum, "view value range must be ordered");
        let current = self.values.get(&id).copied().unwrap_or(minimum);
        let next = current.saturating_add(delta).clamp(minimum, maximum);
        if next == minimum {
            self.values.remove(&id);
        } else {
            self.values.insert(id, next);
        }
    }

    /// Returns an integer value retained for a mounted view-local control.
    pub fn value(&self, id: ElementId) -> i32 {
        self.values.get(&id).copied().unwrap_or_default()
    }
}

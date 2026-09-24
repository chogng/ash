/// Stable viewport position relative to one list item.
///
/// Hosts may associate `item_index` with their stable item identity before a reorder, resolve the
/// new index afterwards with [`Self::with_item_index`], and then restore the same visual anchor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ListScrollAnchor {
    pub(super) item_index: usize,
    pub(super) distance_from_item_start: f32,
}

impl ListScrollAnchor {
    pub const fn item_index(self) -> usize {
        self.item_index
    }

    pub const fn distance_from_item_start(self) -> f32 {
        self.distance_from_item_start
    }

    pub const fn with_item_index(mut self, item_index: usize) -> Self {
        self.item_index = item_index;
        self
    }
}

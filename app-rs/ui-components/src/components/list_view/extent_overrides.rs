use std::ops::Range;

use super::extent_index::ListItemExtents;

#[derive(Clone, Copy, Debug, PartialEq)]
struct ListItemExtentOverride {
    index: usize,
    extent: f32,
    cumulative_delta: f32,
}

/// Small sorted overlay used for presentation-time item extent changes.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ListItemExtentOverrides {
    items: Vec<ListItemExtentOverride>,
}

impl ListItemExtentOverrides {
    pub(super) fn new(
        base: &ListItemExtents,
        overrides: impl IntoIterator<Item = (usize, f32)>,
    ) -> Self {
        let mut overrides = overrides.into_iter().collect::<Vec<_>>();
        overrides.sort_unstable_by_key(|(index, _)| *index);
        assert!(
            overrides.windows(2).all(|pair| pair[0].0 != pair[1].0),
            "List item extent override indices must be unique"
        );
        let mut cumulative_delta = 0.0;
        let items = overrides
            .into_iter()
            .map(|(index, extent)| {
                assert!(
                    extent.is_finite() && extent > 0.0,
                    "List item extent override must be positive and finite"
                );
                let base_extent = base
                    .item_extent(index)
                    .expect("List item extent override index must be in range");
                cumulative_delta += extent - base_extent;
                assert!(
                    cumulative_delta.is_finite(),
                    "List item extent override total must be finite"
                );
                ListItemExtentOverride {
                    index,
                    extent,
                    cumulative_delta,
                }
            })
            .collect();
        Self { items }
    }

    pub(super) fn item_extent(&self, index: usize) -> Option<f32> {
        self.items
            .binary_search_by_key(&index, |item| item.index)
            .ok()
            .map(|position| self.items[position].extent)
    }

    pub(super) fn delta_before(&self, index: usize) -> f32 {
        let position = self.items.partition_point(|item| item.index < index);
        position
            .checked_sub(1)
            .map_or(0.0, |position| self.items[position].cumulative_delta)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub(super) fn remove(&mut self, index: usize, base: &ListItemExtents) {
        let Ok(position) = self.items.binary_search_by_key(&index, |item| item.index) else {
            return;
        };
        self.items.remove(position);
        self.recompute_deltas(base);
    }

    pub(super) fn splice(
        &mut self,
        range: Range<usize>,
        inserted_count: usize,
        base: &ListItemExtents,
    ) {
        let removed_count = range.end - range.start;
        self.items.retain_mut(|item| {
            if range.contains(&item.index) {
                return false;
            }
            if item.index >= range.end {
                item.index = item.index - removed_count + inserted_count;
            }
            true
        });
        self.recompute_deltas(base);
    }

    fn recompute_deltas(&mut self, base: &ListItemExtents) {
        let mut cumulative_delta = 0.0;
        for item in &mut self.items {
            let base_extent = base
                .item_extent(item.index)
                .expect("retained list item extent override index");
            cumulative_delta += item.extent - base_extent;
            item.cumulative_delta = cumulative_delta;
        }
    }
}

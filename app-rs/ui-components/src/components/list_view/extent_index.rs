use std::ops::Range;

use super::extent_tree::VariableExtentTree;

/// Fixed or indexed item extents used by [`super::VirtualListLayout`].
#[derive(Clone, Debug, PartialEq)]
pub(super) enum ListItemExtents {
    Fixed { item_count: usize, item_extent: f32 },
    Variable(VariableExtentTree),
}

impl ListItemExtents {
    pub(super) const fn fixed(item_count: usize, item_extent: f32) -> Self {
        Self::Fixed {
            item_count,
            item_extent,
        }
    }

    pub(super) fn variable(item_extents: Vec<f32>) -> Self {
        Self::Variable(VariableExtentTree::new(item_extents))
    }

    pub(super) fn item_count(&self) -> usize {
        match self {
            Self::Fixed { item_count, .. } => *item_count,
            Self::Variable(index) => index.item_count(),
        }
    }

    pub(super) fn item_extent(&self, index: usize) -> Option<f32> {
        match self {
            Self::Fixed {
                item_count,
                item_extent,
            } => (index < *item_count).then_some(*item_extent),
            Self::Variable(extents) => extents.item_extent(index),
        }
    }

    pub(super) fn extent_before(&self, index: usize) -> Option<f32> {
        if index > self.item_count() {
            return None;
        }
        Some(match self {
            Self::Fixed { item_extent, .. } => index as f32 * *item_extent,
            Self::Variable(extents) => extents.extent_before(index),
        })
    }

    pub(super) fn total_extent(&self) -> f32 {
        match self {
            Self::Fixed {
                item_count,
                item_extent,
            } => *item_count as f32 * *item_extent,
            Self::Variable(extents) => extents.total_extent(),
        }
    }

    pub(super) fn extents(&self) -> Vec<f32> {
        match self {
            Self::Fixed {
                item_count,
                item_extent,
            } => vec![*item_extent; *item_count],
            Self::Variable(extents) => extents.extents(),
        }
    }

    pub(super) fn first_item_ending_after(&self, coordinate: f32, item_gap: f32) -> usize {
        if coordinate + item_gap < 0.0 {
            return 0;
        }
        match self {
            Self::Fixed {
                item_count,
                item_extent,
            } => (((coordinate + item_gap) / (*item_extent + item_gap)).floor() as usize)
                .min(*item_count),
            Self::Variable(extents) => {
                extents.prefix_count_at_most(coordinate + item_gap, item_gap)
            }
        }
    }

    pub(super) fn first_item_starting_at_or_after(&self, coordinate: f32, item_gap: f32) -> usize {
        if coordinate <= 0.0 {
            return 0;
        }
        match self {
            Self::Fixed {
                item_count,
                item_extent,
            } => ((coordinate / (*item_extent + item_gap)).ceil() as usize).min(*item_count),
            Self::Variable(extents) => extents.first_prefix_at_or_after(coordinate, item_gap),
        }
    }

    /// Updates one extent in O(log n) after a fixed layout has become variable.
    pub(super) fn update(&mut self, index: usize, item_extent: f32) -> Option<f32> {
        let previous = self.item_extent(index)?;
        if previous == item_extent {
            return Some(previous);
        }
        match self {
            Self::Fixed {
                item_count,
                item_extent: fixed_extent,
            } => {
                let mut item_extents = vec![*fixed_extent; *item_count];
                item_extents[index] = item_extent;
                *self = Self::variable(item_extents);
            }
            Self::Variable(extents) => extents.update(index, item_extent),
        }
        Some(previous)
    }

    pub(super) fn splice(&mut self, range: Range<usize>, replacements: Vec<f32>) {
        assert!(
            range.start <= range.end && range.end <= self.item_count(),
            "List item extent splice range must be ordered and in bounds"
        );
        match self {
            Self::Fixed {
                item_count,
                item_extent,
            } if replacements.iter().all(|extent| extent == item_extent) => {
                *item_count = *item_count - (range.end - range.start) + replacements.len();
            }
            Self::Fixed {
                item_count,
                item_extent,
            } => {
                let mut extents = vec![*item_extent; *item_count];
                extents.splice(range, replacements);
                *self = Self::variable(extents);
            }
            Self::Variable(extents) => extents.splice(range, replacements),
        }
    }
}

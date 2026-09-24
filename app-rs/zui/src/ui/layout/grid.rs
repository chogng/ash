use std::collections::HashSet;
use std::hash::Hash;

use super::SplitViewLayout;
use super::SplitViewOrientation;
use super::SplitViewPane;
use super::SplitViewResizeSnapshot;
use crate::ui::foundation::Rect;

/// Caller-owned recursive input node for one immutable [`GridLayout`].
///
/// Leaf and split identities must each be unique within the tree. The caller owns the tree,
/// preferred sizes, product bindings, and topology changes across frames.
#[derive(Clone, Debug, PartialEq)]
pub enum GridNode<LeafId, SplitId> {
    Leaf {
        id: LeafId,
    },
    Split {
        id: SplitId,
        orientation: SplitViewOrientation,
        panes: Vec<GridPane<LeafId, SplitId>>,
    },
}

impl<LeafId, SplitId> GridNode<LeafId, SplitId> {
    pub const fn leaf(id: LeafId) -> Self {
        Self::Leaf { id }
    }

    pub fn split(
        id: SplitId,
        orientation: SplitViewOrientation,
        panes: Vec<GridPane<LeafId, SplitId>>,
    ) -> Self {
        assert!(
            panes.len() >= 2,
            "Grid split nodes must contain at least two panes"
        );
        Self::Split {
            id,
            orientation,
            panes,
        }
    }
}

/// One child of a [`GridNode::Split`] and its single-axis sizing input.
#[derive(Clone, Debug, PartialEq)]
pub struct GridPane<LeafId, SplitId> {
    node: Box<GridNode<LeafId, SplitId>>,
    sizing: SplitViewPane,
}

impl<LeafId, SplitId> GridPane<LeafId, SplitId> {
    pub fn new(node: GridNode<LeafId, SplitId>, sizing: SplitViewPane) -> Self {
        Self {
            node: Box::new(node),
            sizing,
        }
    }
}

/// Resolved bounds for one visible Grid leaf.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridLeafLayout<LeafId> {
    id: LeafId,
    bounds: Rect,
}

impl<LeafId: Copy> GridLeafLayout<LeafId> {
    pub const fn id(self) -> LeafId {
        self.id
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }
}

/// Resolved bounds and axis for one visible Grid split.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridSplitLayout<SplitId> {
    id: SplitId,
    bounds: Rect,
    orientation: SplitViewOrientation,
}

impl<SplitId: Copy> GridSplitLayout<SplitId> {
    pub const fn id(self) -> SplitId {
        self.id
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn orientation(self) -> SplitViewOrientation {
        self.orientation
    }
}

/// Resolved Sash identity and drag-start geometry inside one Grid split.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridSashLayout<SplitId> {
    split_id: SplitId,
    orientation: SplitViewOrientation,
    previous_index: usize,
    next_index: usize,
    track_bounds: Rect,
    resize: SplitViewResizeSnapshot,
}

impl<SplitId: Copy> GridSashLayout<SplitId> {
    pub const fn split_id(self) -> SplitId {
        self.split_id
    }

    pub const fn orientation(self) -> SplitViewOrientation {
        self.orientation
    }

    pub const fn previous_index(self) -> usize {
        self.previous_index
    }

    pub const fn next_index(self) -> usize {
        self.next_index
    }

    pub const fn track_bounds(self) -> Rect {
        self.track_bounds
    }

    pub const fn resize_snapshot(self) -> SplitViewResizeSnapshot {
        self.resize
    }
}

/// Immutable recursive Pane and Sash geometry for one frame.
///
/// Each split delegates its immediate children to [`SplitViewLayout`], then recursively resolves
/// visible child nodes. The caller retains topology and applies [`GridSashLayout`] resize results
/// to the matching split's preferred sizes.
#[derive(Clone, Debug, PartialEq)]
pub struct GridLayout<LeafId, SplitId> {
    leaves: Vec<GridLeafLayout<LeafId>>,
    splits: Vec<GridSplitLayout<SplitId>>,
    sashes: Vec<GridSashLayout<SplitId>>,
}

impl<LeafId, SplitId> GridLayout<LeafId, SplitId>
where
    LeafId: Copy + Eq + Hash,
    SplitId: Copy + Eq + Hash,
{
    pub fn new(bounds: Rect, root: &GridNode<LeafId, SplitId>) -> Self {
        assert_grid_bounds(bounds);
        validate_unique_identities(root);
        let mut layout = Self {
            leaves: Vec::new(),
            splits: Vec::new(),
            sashes: Vec::new(),
        };
        layout.resolve_node(bounds, root);
        layout
    }

    pub fn leaves(&self) -> &[GridLeafLayout<LeafId>] {
        &self.leaves
    }

    pub fn splits(&self) -> &[GridSplitLayout<SplitId>] {
        &self.splits
    }

    pub fn sashes(&self) -> &[GridSashLayout<SplitId>] {
        &self.sashes
    }

    pub fn leaf(&self, id: LeafId) -> Option<GridLeafLayout<LeafId>> {
        self.leaves.iter().copied().find(|leaf| leaf.id == id)
    }

    pub fn split(&self, id: SplitId) -> Option<GridSplitLayout<SplitId>> {
        self.splits.iter().copied().find(|split| split.id == id)
    }

    fn resolve_node(&mut self, bounds: Rect, node: &GridNode<LeafId, SplitId>) {
        match node {
            GridNode::Leaf { id } => self.leaves.push(GridLeafLayout { id: *id, bounds }),
            GridNode::Split {
                id,
                orientation,
                panes,
            } => {
                self.splits.push(GridSplitLayout {
                    id: *id,
                    bounds,
                    orientation: *orientation,
                });
                let sizing = panes.iter().map(|pane| pane.sizing).collect::<Vec<_>>();
                let split_layout = SplitViewLayout::new(bounds, *orientation, &sizing);
                self.sashes
                    .extend(split_layout.sashes().iter().map(|sash| GridSashLayout {
                        split_id: *id,
                        orientation: *orientation,
                        previous_index: sash.previous_index(),
                        next_index: sash.next_index(),
                        track_bounds: sash.track_bounds(),
                        resize: sash.resize_snapshot(),
                    }));
                for (index, pane) in panes.iter().enumerate() {
                    let pane_bounds = split_layout
                        .pane_bounds(index)
                        .expect("Grid split layout must preserve every pane index");
                    if !pane_bounds.is_empty() {
                        self.resolve_node(pane_bounds, &pane.node);
                    }
                }
            }
        }
    }
}

fn validate_unique_identities<LeafId, SplitId>(root: &GridNode<LeafId, SplitId>)
where
    LeafId: Copy + Eq + Hash,
    SplitId: Copy + Eq + Hash,
{
    let mut leaves = HashSet::new();
    let mut splits = HashSet::new();
    validate_node(root, &mut leaves, &mut splits);
}

fn validate_node<LeafId, SplitId>(
    node: &GridNode<LeafId, SplitId>,
    leaves: &mut HashSet<LeafId>,
    splits: &mut HashSet<SplitId>,
) where
    LeafId: Copy + Eq + Hash,
    SplitId: Copy + Eq + Hash,
{
    match node {
        GridNode::Leaf { id } => {
            assert!(leaves.insert(*id), "Grid leaf identities must be unique");
        }
        GridNode::Split { id, panes, .. } => {
            assert!(
                panes.len() >= 2,
                "Grid split nodes must contain at least two panes"
            );
            assert!(splits.insert(*id), "Grid split identities must be unique");
            for pane in panes {
                validate_node(&pane.node, leaves, splits);
            }
        }
    }
}

fn assert_grid_bounds(bounds: Rect) {
    assert!(
        bounds.origin.x.is_finite() && bounds.origin.y.is_finite(),
        "Grid bounds origin must be finite"
    );
    assert!(
        bounds.size.width.is_finite()
            && bounds.size.height.is_finite()
            && bounds.size.width >= 0.0
            && bounds.size.height >= 0.0,
        "Grid bounds dimensions must be non-negative and finite"
    );
}

#[cfg(test)]
#[path = "grid_tests.rs"]
mod tests;

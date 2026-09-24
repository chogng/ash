use zui::ui::GridLayout;
use zui::ui::GridLeafLayout;
use zui::ui::GridNode;
use zui::ui::GridPane;
use zui::ui::GridSashLayout;
use zui::ui::Rect;
use zui::ui::SplitViewOrientation;
use zui::ui::SplitViewPane;

use crate::PaneGroupId;
use crate::PaneNode;
use crate::PaneSplitDirection;
use crate::PaneSplitId;

/// Geometry projection for a host-owned recursive pane layout.
///
/// The host supplies the immutable [`PaneNode`] for one frame and retains all topology, active
/// state, runtime binding, and split mutations. This wrapper gives application layouts an explicit
/// group boundary without introducing a second geometry algorithm beside [`GridLayout`].
#[derive(Clone, Debug, PartialEq)]
pub struct PaneGroupLayout<LeafId, SplitId> {
    grid: GridLayout<LeafId, SplitId>,
}

impl<LeafId, SplitId> PaneGroupLayout<LeafId, SplitId>
where
    LeafId: Copy + Eq + std::hash::Hash,
    SplitId: Copy + Eq + std::hash::Hash,
{
    /// Returns all visible group leaf bounds in tree order.
    pub fn leaves(&self) -> &[GridLeafLayout<LeafId>] {
        self.grid.leaves()
    }

    /// Returns all owning split sash geometries in tree order.
    pub fn sashes(&self) -> &[GridSashLayout<SplitId>] {
        self.grid.sashes()
    }

    /// Finds one visible group leaf by its host identity.
    pub fn leaf(&self, id: LeafId) -> Option<GridLeafLayout<LeafId>> {
        self.grid.leaf(id)
    }
}

impl PaneGroupLayout<PaneGroupId, PaneSplitId> {
    /// Resolves one Workbench-owned recursive pane geometry tree.
    pub fn for_tree(bounds: Rect, root: &PaneNode) -> Self {
        Self {
            grid: GridLayout::new(bounds, &grid_node(root, bounds)),
        }
    }
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;

fn grid_node(node: &PaneNode, bounds: Rect) -> GridNode<PaneGroupId, PaneSplitId> {
    match node {
        PaneNode::Leaf(id) => GridNode::leaf(*id),
        PaneNode::Split {
            id,
            direction,
            ratio,
            first,
            second,
        } => {
            let orientation = match direction {
                PaneSplitDirection::Horizontal => SplitViewOrientation::Horizontal,
                PaneSplitDirection::Vertical => SplitViewOrientation::Vertical,
            };
            let primary = match orientation {
                SplitViewOrientation::Horizontal => bounds.size.width,
                SplitViewOrientation::Vertical => bounds.size.height,
            };
            let first_size = (primary * *ratio).clamp(0.0, primary.max(0.0));
            let second_size = (primary - first_size).max(0.0);
            let first_bounds = child_bounds(bounds, orientation, 0.0, first_size);
            let second_bounds = child_bounds(bounds, orientation, first_size, second_size);
            let minimum = 48.0;
            GridNode::split(
                *id,
                orientation,
                vec![
                    GridPane::new(
                        grid_node(first, first_bounds),
                        SplitViewPane::new(first_size, minimum, f32::INFINITY),
                    ),
                    GridPane::new(
                        grid_node(second, second_bounds),
                        SplitViewPane::new(second_size, minimum, f32::INFINITY),
                    ),
                ],
            )
        }
    }
}

fn child_bounds(
    bounds: Rect,
    orientation: SplitViewOrientation,
    offset: f32,
    primary_size: f32,
) -> Rect {
    match orientation {
        SplitViewOrientation::Horizontal => Rect::from_xywh(
            bounds.origin.x + offset,
            bounds.origin.y,
            primary_size,
            bounds.size.height,
        ),
        SplitViewOrientation::Vertical => Rect::from_xywh(
            bounds.origin.x,
            bounds.origin.y + offset,
            bounds.size.width,
            primary_size,
        ),
    }
}

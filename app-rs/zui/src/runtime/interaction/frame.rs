use std::collections::HashSet;

use crate::ui::foundation::InteractionSink;
use crate::ui::foundation::Point;
use crate::ui::foundation::Rect;

use super::AccessibilityExpansion;
use super::AccessibilityRole;
use super::AccessibilitySelection;
use super::ElementId;
use super::FocusBehavior;
use super::NodeAction;
use super::UiDispatch;
use super::types::UiNode;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InteractionFrame {
    nodes: Vec<UiNode>,
    modal_root: Option<ElementId>,
}

/// Retained interaction boundary paired with a stable scene prefix.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InteractionFrameCheckpoint {
    node_count: usize,
    modal_root: Option<ElementId>,
}

impl InteractionFrame {
    /// Records the current node prefix and modal scope for later restoration.
    pub const fn checkpoint(&self) -> InteractionFrameCheckpoint {
        InteractionFrameCheckpoint {
            node_count: self.nodes.len(),
            modal_root: self.modal_root,
        }
    }

    /// Discards nodes and modal state appended after `checkpoint`.
    pub fn restore(&mut self, checkpoint: InteractionFrameCheckpoint) {
        assert!(
            checkpoint.node_count <= self.nodes.len(),
            "Interaction checkpoint must describe a prefix of its originating frame"
        );
        self.nodes.truncate(checkpoint.node_count);
        self.modal_root = checkpoint.modal_root;
    }

    pub fn register(&mut self, node: UiNode) {
        debug_assert!(
            self.node(node.id()).is_none(),
            "an element may only be registered once per frame"
        );
        self.nodes.push(node);
    }

    /// Restricts pointer targeting and focus traversal to one modal subtree.
    ///
    /// The root must already be registered. Nodes outside the subtree remain available for
    /// painting and accessibility snapshots, but they are inert for this interaction frame.
    pub fn set_modal_root(&mut self, root: ElementId) {
        debug_assert!(
            self.node(root).is_some(),
            "the modal root must be registered before it becomes active"
        );
        self.modal_root = Some(root);
    }

    pub fn node(&self, id: ElementId) -> Option<&UiNode> {
        self.nodes.iter().find(|node| node.id() == id)
    }

    pub fn target_at(&self, point: Point) -> Option<ElementId> {
        self.nodes
            .iter()
            .rev()
            .find(|node| self.is_in_active_scope(node.id()) && node.contains(point))
            .map(UiNode::id)
    }

    pub fn ancestry(&self, id: ElementId) -> Vec<ElementId> {
        if !self.is_in_active_scope(id) {
            return Vec::new();
        }
        let mut path = Vec::new();
        let mut current = Some(id);
        let mut visited = HashSet::new();
        while let Some(id) = current {
            if !visited.insert(id) {
                return Vec::new();
            }
            path.push(id);
            if self.modal_root == Some(id) {
                break;
            }
            current = self.node(id).and_then(UiNode::parent);
        }
        path.reverse();
        path
    }

    pub(crate) fn is_in_active_scope(&self, id: ElementId) -> bool {
        let Some(modal_root) = self.modal_root else {
            return self.node(id).is_some();
        };
        let mut current = Some(id);
        for _ in 0..self.nodes.len() {
            let Some(id) = current else {
                return false;
            };
            if id == modal_root {
                return true;
            }
            current = self.node(id).and_then(UiNode::parent);
        }
        false
    }

    pub fn focus_order(&self) -> impl Iterator<Item = ElementId> + '_ {
        self.nodes.iter().filter_map(|node| {
            (self.is_in_active_scope(node.id()) && node.focus_behavior() == FocusBehavior::TabStop)
                .then_some(node.id())
        })
    }

    pub fn accessibility_nodes(&self, dispatch: &UiDispatch) -> Vec<AccessibilityNode> {
        self.nodes
            .iter()
            .map(|node| AccessibilityNode {
                id: node.id(),
                parent: node.parent(),
                role: node.role(),
                label: node.label().to_owned(),
                value: node.value().map(str::to_owned),
                selection: node.selection(),
                level: node.level(),
                expansion: node.expansion(),
                bounds: node.bounds(),
                focusable: self.is_in_active_scope(node.id())
                    && node.focus_behavior() == FocusBehavior::TabStop,
                focused: self.is_in_active_scope(node.id()) && dispatch.is_focused(node.id()),
                action: node.action(),
            })
            .collect()
    }
}

impl InteractionSink for InteractionFrame {
    fn register(&mut self, node: UiNode) {
        InteractionFrame::register(self, node);
    }

    fn set_modal_root(&mut self, root: ElementId) {
        InteractionFrame::set_modal_root(self, root);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccessibilityNode {
    pub id: ElementId,
    pub parent: Option<ElementId>,
    pub role: AccessibilityRole,
    pub label: String,
    pub value: Option<String>,
    pub bounds: Rect,
    pub focusable: bool,
    pub focused: bool,
    pub action: NodeAction,
    pub selection: AccessibilitySelection,
    pub level: Option<usize>,
    pub expansion: AccessibilityExpansion,
}

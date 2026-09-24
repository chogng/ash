use crate::ui::InspectionFrame;
use crate::ui::InspectionNodeId;

use super::InspectionSelection;

#[derive(Clone, Debug, Default)]
pub(crate) struct DevToolsViewState {
    collapsed: Vec<InspectionNodeId>,
    hovered_node: Option<InspectionNodeId>,
    pub(crate) scroll_offset: f32,
}

impl DevToolsViewState {
    pub(crate) fn reset(&mut self) {
        self.collapsed.clear();
        self.hovered_node = None;
        self.scroll_offset = 0.0;
    }

    pub(crate) fn is_collapsed(&self, id: InspectionNodeId) -> bool {
        self.collapsed.contains(&id)
    }

    pub(crate) fn toggle(&mut self, id: InspectionNodeId) {
        if let Some(index) = self.collapsed.iter().position(|candidate| *candidate == id) {
            self.collapsed.remove(index);
        } else {
            self.collapsed.push(id);
        }
    }

    pub(crate) fn retain_nodes(&mut self, frame: &InspectionFrame) {
        self.collapsed.retain(|id| frame.node(*id).is_some());
        if self.hovered_node.is_some_and(|id| frame.node(id).is_none()) {
            self.hovered_node = None;
        }
    }

    pub(crate) fn hovered_node(&self) -> Option<InspectionNodeId> {
        self.hovered_node
    }

    pub(crate) fn set_hovered_node(&mut self, id: Option<InspectionNodeId>) -> bool {
        if self.hovered_node == id {
            return false;
        }
        self.hovered_node = id;
        true
    }

    pub(crate) fn reveal_selection(&mut self, selection: Option<&InspectionSelection>) {
        let Some(selection) = selection else {
            return;
        };
        for node in selection.path().iter().take(selection.selected_index()) {
            self.collapsed.retain(|id| *id != node.id());
        }
    }

    pub(crate) fn scroll_by(&mut self, delta: f32) {
        if delta.is_finite() {
            self.scroll_offset = (self.scroll_offset + delta).max(0.0);
        }
    }

    pub(crate) fn set_scroll_offset(&mut self, offset: f32) {
        if offset.is_finite() {
            self.scroll_offset = offset.max(0.0);
        }
    }

    pub(crate) fn ensure_visible(
        &mut self,
        row_index: usize,
        row_height: f32,
        viewport_height: f32,
    ) {
        let top = row_index as f32 * row_height;
        let bottom = top + row_height;
        if top < self.scroll_offset {
            self.scroll_offset = top;
        } else if bottom > self.scroll_offset + viewport_height {
            self.scroll_offset = bottom - viewport_height;
        }
        self.scroll_offset = self.scroll_offset.max(0.0);
    }
}

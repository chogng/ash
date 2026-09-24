use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;

use super::DevToolsRequest;
use super::DevToolsRequestSender;
use super::view_state::DevToolsViewState;
use crate::ui::foundation::Point;
use crate::ui::presentation::InspectionFrame;
use crate::ui::presentation::InspectionNode;
use crate::ui::presentation::InspectionNodeId;
use crate::window::WindowId;

/// A selected node and its complete parent path within one immutable inspection frame.
///
/// The nodes are copied from the frame so a product inspector can retain a selection while it
/// composes its own panel. The selection remains meaningful only for the frame it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct InspectionSelection {
    path: Vec<InspectionNode>,
    selected_index: usize,
}

impl InspectionSelection {
    /// Selects the deepest inspection node at `point` and copies its ancestor path.
    pub fn at(frame: &InspectionFrame, point: Point) -> Option<Self> {
        let target = frame.target_at(point)?;
        Self::from_node(frame, target.id())
    }

    /// Copies the ancestor path for one node in `frame`.
    pub fn from_node(frame: &InspectionFrame, id: InspectionNodeId) -> Option<Self> {
        Self::from_path(frame.ancestry(id).into_iter().cloned().collect())
    }

    /// Creates a selection from an already resolved parent-to-child path.
    pub fn from_path(path: Vec<InspectionNode>) -> Option<Self> {
        if path.is_empty() {
            return None;
        }
        Some(Self {
            selected_index: path.len() - 1,
            path,
        })
    }

    /// Returns the complete parent-to-selected-node path.
    pub fn path(&self) -> &[InspectionNode] {
        &self.path
    }

    /// Returns the currently selected node, if the path is non-empty.
    pub fn target(&self) -> Option<&InspectionNode> {
        self.path.get(self.selected_index)
    }

    /// Returns the index of the selected node within [`Self::path`].
    pub const fn selected_index(&self) -> usize {
        self.selected_index
    }

    /// Retargets the selection to another node in the same parent path.
    pub fn select_index(&mut self, index: usize) -> bool {
        if index >= self.path.len() {
            return false;
        }
        self.selected_index = index;
        true
    }
}

/// Product-neutral state machine shared by interactive native layout inspectors.
///
/// The state owns enablement, picking, hover, and locked selection. The zui host owns the default
/// window, pointer routing, panel layout, and presentation; products may consume the same state
/// to add their own tooling without creating a second inspector session.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InspectorState {
    enabled: bool,
    picking: bool,
    hovered: Option<InspectionSelection>,
    locked: Option<InspectionSelection>,
}

impl InspectorState {
    /// Returns whether the inspector should participate in host input and presentation.
    pub const fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Returns whether pointer picking is active.
    pub const fn is_picking(&self) -> bool {
        self.enabled && self.picking
    }

    /// Enables the inspector and clears any selection from a previous session.
    pub fn open(&mut self) {
        self.enabled = true;
        self.picking = false;
        self.hovered = None;
        self.locked = None;
    }

    /// Toggles the inspector and returns its new enabled state.
    pub fn toggle(&mut self) -> bool {
        if self.enabled {
            self.close();
        } else {
            self.open();
        }
        self.enabled
    }

    /// Disables the inspector and clears its transient and locked selection.
    pub fn close(&mut self) {
        self.enabled = false;
        self.picking = false;
        self.hovered = None;
        self.locked = None;
    }

    /// Stops picking, or closes the inspector when picking is already stopped.
    ///
    /// Returns `true` when the inspector was closed.
    pub fn stop_picking_or_close(&mut self) -> bool {
        if self.picking {
            self.picking = false;
            self.hovered = None;
            false
        } else {
            self.close();
            true
        }
    }

    /// Toggles pointer picking and discards a previous locked selection when picking starts.
    pub fn toggle_picking(&mut self) {
        if !self.enabled {
            return;
        }
        if self.picking {
            self.picking = false;
            self.hovered = None;
        } else {
            self.picking = true;
            self.hovered = None;
            self.locked = None;
        }
    }

    /// Updates the transient hovered selection while picking is active.
    pub fn set_hovered(&mut self, selection: Option<InspectionSelection>) {
        if self.is_picking() && self.locked.is_none() {
            self.hovered = selection;
        } else {
            self.hovered = None;
        }
    }

    /// Locks a selection and stops pointer picking.
    pub fn select(&mut self, selection: Option<InspectionSelection>) {
        if !self.enabled {
            return;
        }
        self.locked = selection;
        self.hovered = None;
        self.picking = false;
    }

    /// Returns the locked selection, if any.
    pub fn locked_selection(&self) -> Option<&InspectionSelection> {
        self.locked.as_ref()
    }

    /// Returns the current locked selection or, while picking, the hovered selection.
    pub fn selection(&self) -> Option<&InspectionSelection> {
        self.locked.as_ref().or(self.hovered.as_ref())
    }

    /// Retargets the current selection to one of its ancestor rows.
    pub fn select_index(&mut self, index: usize) -> bool {
        if !self.enabled {
            return false;
        }
        let Some(mut selection) = self.selection().cloned() else {
            return false;
        };
        if !selection.select_index(index) {
            return false;
        }
        self.locked = Some(selection);
        self.hovered = None;
        self.picking = false;
        true
    }
}

/// Cloneable DevTools session capability associated with one runtime-owned window.
///
/// The runtime owns the session state and the latest immutable inspection frame. Calling
/// `open`, `close`, or `toggle` from a window capability also asks the native ZUI host to create or
/// destroy the default DevTools window. A product may still use the state and frame to build a
/// custom DevTools surface, but the framework supplies a default Inspector view.
#[derive(Clone)]
pub struct DevToolsHandle {
    state: Arc<Mutex<InspectorState>>,
    inspection: Arc<Mutex<Option<InspectionFrame>>>,
    view: Arc<Mutex<DevToolsViewState>>,
    request_sender: Option<DevToolsRequestSender>,
    owner: Option<WindowId>,
}

impl fmt::Debug for DevToolsHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DevToolsHandle")
            .field("state", &self.state)
            .field("inspection", &self.inspection)
            .field("view", &self.view)
            .field("owner", &self.owner)
            .finish_non_exhaustive()
    }
}

impl Default for DevToolsHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl DevToolsHandle {
    /// Creates an independent DevTools session, primarily for a custom host or tests.
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(InspectorState::default())),
            inspection: Arc::new(Mutex::new(None)),
            view: Arc::new(Mutex::new(DevToolsViewState::default())),
            request_sender: None,
            owner: None,
        }
    }

    pub(crate) fn with_request(owner: WindowId, request_sender: DevToolsRequestSender) -> Self {
        Self {
            state: Arc::new(Mutex::new(InspectorState::default())),
            inspection: Arc::new(Mutex::new(None)),
            view: Arc::new(Mutex::new(DevToolsViewState::default())),
            request_sender: Some(request_sender),
            owner: Some(owner),
        }
    }

    fn request_open(&self, open: bool) {
        if let (Some(owner), Some(sender)) = (self.owner, self.request_sender.as_ref()) {
            sender(DevToolsRequest::SetOpen { owner, open });
        }
    }

    /// Returns whether this window's DevTools session is open.
    pub fn is_open(&self) -> bool {
        self.state.lock().expect("devtools state lock").is_enabled()
    }

    /// Returns whether pointer picking is active.
    pub fn is_picking(&self) -> bool {
        self.state.lock().expect("devtools state lock").is_picking()
    }

    /// Opens the DevTools session and clears its previous selection.
    pub fn open(&self) {
        self.state.lock().expect("devtools state lock").open();
        self.inspection
            .lock()
            .expect("devtools inspection lock")
            .take();
        self.reset_view();
        self.request_open(true);
    }

    /// Closes the DevTools session and clears its selection.
    pub fn close(&self) {
        self.close_local();
        self.request_open(false);
    }

    pub(crate) fn close_local(&self) {
        self.state.lock().expect("devtools state lock").close();
        self.inspection
            .lock()
            .expect("devtools inspection lock")
            .take();
        self.reset_view();
    }

    /// Toggles the DevTools session and returns whether it is now open.
    pub fn toggle(&self) -> bool {
        let is_open = self.state.lock().expect("devtools state lock").toggle();
        if !is_open {
            self.inspection
                .lock()
                .expect("devtools inspection lock")
                .take();
            self.reset_view();
        }
        self.request_open(is_open);
        is_open
    }

    /// Stops picking, or closes the session when picking is already stopped.
    ///
    /// Returns `true` when the session was closed.
    pub fn stop_picking_or_close(&self) -> bool {
        let closed = self
            .state
            .lock()
            .expect("devtools state lock")
            .stop_picking_or_close();
        if closed {
            self.inspection
                .lock()
                .expect("devtools inspection lock")
                .take();
            self.reset_view();
            self.request_open(false);
        }
        closed
    }

    /// Toggles pointer picking when the session is open.
    pub fn toggle_picking(&self) {
        self.state
            .lock()
            .expect("devtools state lock")
            .toggle_picking();
    }

    /// Updates the transient hovered selection while picking.
    pub fn set_hovered(&self, selection: Option<InspectionSelection>) {
        self.reveal_selection(selection.as_ref());
        self.state
            .lock()
            .expect("devtools state lock")
            .set_hovered(selection);
    }

    /// Locks a selection and stops pointer picking.
    pub fn select(&self, selection: Option<InspectionSelection>) {
        self.reveal_selection(selection.as_ref());
        self.state
            .lock()
            .expect("devtools state lock")
            .select(selection);
    }

    /// Retargets the current selection to one of its ancestor rows.
    pub fn select_index(&self, index: usize) -> bool {
        let selected = self
            .state
            .lock()
            .expect("devtools state lock")
            .select_index(index);
        if selected {
            self.reveal_selection(self.selection().as_ref());
        }
        selected
    }

    /// Returns the locked selection, if any.
    pub fn locked_selection(&self) -> Option<InspectionSelection> {
        self.state
            .lock()
            .expect("devtools state lock")
            .locked_selection()
            .cloned()
    }

    /// Returns the locked selection or the current hover selection.
    pub fn selection(&self) -> Option<InspectionSelection> {
        self.state
            .lock()
            .expect("devtools state lock")
            .selection()
            .cloned()
    }

    /// Returns the latest inspection frame submitted by the associated product window.
    pub fn inspection(&self) -> Option<InspectionFrame> {
        self.inspection
            .lock()
            .expect("devtools inspection lock")
            .clone()
    }

    /// Replaces the live inspection frame while this session is open.
    pub(crate) fn set_inspection(&self, frame: InspectionFrame) {
        if self.is_open() {
            self.view
                .lock()
                .expect("devtools view lock")
                .retain_nodes(&frame);
            *self.inspection.lock().expect("devtools inspection lock") = Some(frame);
        }
    }

    pub(crate) fn is_collapsed(&self, id: InspectionNodeId) -> bool {
        self.view
            .lock()
            .expect("devtools view lock")
            .is_collapsed(id)
    }

    pub(crate) fn toggle_node_expansion(&self, id: InspectionNodeId) {
        if let Some(frame) = self.inspection()
            && let Some(selection) = InspectionSelection::from_node(&frame, id)
        {
            self.select(Some(selection));
        }
        self.view.lock().expect("devtools view lock").toggle(id);
    }

    pub(crate) fn hovered_tree_node(&self) -> Option<InspectionNodeId> {
        self.view.lock().expect("devtools view lock").hovered_node()
    }

    pub(crate) fn set_hovered_tree_node(&self, id: Option<InspectionNodeId>) -> bool {
        self.view
            .lock()
            .expect("devtools view lock")
            .set_hovered_node(id)
    }

    pub(crate) fn hovered_tree_selection(&self) -> Option<InspectionSelection> {
        let id = self.hovered_tree_node()?;
        let frame = self.inspection()?;
        InspectionSelection::from_node(&frame, id)
    }

    pub(crate) fn scroll_offset(&self) -> f32 {
        self.view.lock().expect("devtools view lock").scroll_offset
    }

    pub(crate) fn scroll_by(&self, delta: f32) {
        self.view
            .lock()
            .expect("devtools view lock")
            .scroll_by(delta);
    }

    pub(crate) fn set_scroll_offset(&self, offset: f32) {
        self.view
            .lock()
            .expect("devtools view lock")
            .set_scroll_offset(offset);
    }

    pub(crate) fn ensure_row_visible(
        &self,
        row_index: usize,
        row_height: f32,
        viewport_height: f32,
    ) {
        self.view
            .lock()
            .expect("devtools view lock")
            .ensure_visible(row_index, row_height, viewport_height);
    }

    fn reset_view(&self) {
        self.view.lock().expect("devtools view lock").reset();
    }

    fn reveal_selection(&self, selection: Option<&InspectionSelection>) {
        self.view
            .lock()
            .expect("devtools view lock")
            .reveal_selection(selection);
    }

    /// Resolves and stores the node currently under `point` while picking.
    pub(crate) fn hover_at(&self, point: Point) {
        let selection = self
            .inspection()
            .as_ref()
            .and_then(|frame| InspectionSelection::at(frame, point));
        self.set_hovered(selection);
    }

    /// Commits the current hover selection and stops picking.
    pub(crate) fn select_hovered(&self) {
        self.select(self.selection());
    }
}

#[cfg(test)]
#[path = "inspection_tests.rs"]
mod tests;

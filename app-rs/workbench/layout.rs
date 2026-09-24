//! Structural Workbench geometry built on backend-neutral [`zui`] layout contracts.
//!
//! The layout types resolve structural Part/Pane geometry only. Application hosts retain content,
//! identity, focus semantics, event routing, and runtime state.

use std::time::Instant;

use ash_ui_components::Resizable;
use ash_ui_components::SashOrientation;
use ash_ui_components::SashState;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollbarPresentation;
use zui::ui::HoverPresence;
use zui::ui::Point;
use zui::ui::SplitViewResizeSnapshot;

use crate::TabContainerState;

#[path = "layout_inspector.rs"]
mod inspector_state;
#[path = "layout_main.rs"]
mod main;
#[path = "layout_tab_container.rs"]
mod tab_container;
#[path = "layout_workbench.rs"]
mod workbench;

/// Logical dimensions of a presentation viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalViewport {
    /// Width in logical UI pixels.
    pub width: f32,
    /// Height in logical UI pixels.
    pub height: f32,
}

impl LogicalViewport {
    /// Converts physical dimensions into logical UI pixels using a validated scale factor.
    pub fn from_physical(width: u32, height: u32, scale_factor: f64) -> Self {
        let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
            scale_factor as f32
        } else {
            1.0
        };
        Self {
            width: width as f32 / scale_factor,
            height: height as f32 / scale_factor,
        }
    }
}

/// Visibility projected by a host into a structural Part layout request.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum PartVisibility {
    /// Do not include the Part leaf in the resolved layout.
    #[default]
    Collapsed,
    /// Include the Part when the available width can preserve both panes.
    Expanded,
}

pub use inspector_state::InspectorPartState;
pub use main::InspectorLayoutSpec;
pub use main::MainLayout;
pub use tab_container::TabContainerLayout;
pub use tab_container::TabContainerLayoutSpec;
pub use workbench::WorkbenchLayout;
pub use workbench::WorkbenchLayoutSpec;

/// Canonical visibility, sizing, and resize-gesture state for Workbench parts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkbenchLayoutState {
    tab_container: TabContainerState,
    inspector: InspectorPartState,
    inspector_resize: Resizable,
}

impl Default for WorkbenchLayoutState {
    fn default() -> Self {
        Self {
            tab_container: TabContainerState::default(),
            inspector: InspectorPartState::default(),
            inspector_resize: Resizable::new(SashOrientation::Vertical),
        }
    }
}

impl WorkbenchLayoutState {
    /// Returns the current Tab Container state for presentation.
    pub const fn tab_container(self) -> TabContainerState {
        self.tab_container
    }

    /// Returns the current inspector state for presentation.
    pub const fn inspector(self) -> InspectorPartState {
        self.inspector
    }

    pub fn toggle_tab_container(&mut self) {
        self.tab_container.toggle();
    }

    pub fn scroll_tab_container(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.tab_container.scroll(command, metrics)
    }

    pub(crate) fn tab_container_scroll_state_mut(&mut self) -> &mut ash_ui_components::ScrollState {
        self.tab_container.scroll_state_mut()
    }

    pub(crate) fn set_tab_container_scrollbar_presentation(
        &mut self,
        presentation: ScrollbarPresentation,
    ) {
        self.tab_container.set_scrollbar_presentation(presentation);
    }

    pub fn expand_inspector(&mut self) {
        self.inspector.expand();
    }

    pub fn collapse_inspector(&mut self) {
        self.inspector.collapse();
    }

    pub const fn tab_container_is_resizing(self) -> bool {
        self.tab_container.is_resizing()
    }

    pub const fn inspector_is_resizing(self) -> bool {
        self.inspector_resize.is_dragging()
    }

    pub fn start_tab_container_resize(
        &mut self,
        viewport_width: f32,
        pointer: Point,
        now: Instant,
    ) -> bool {
        self.tab_container
            .start_resizing(viewport_width, pointer, now)
    }

    pub fn resize_tab_container(&mut self, pointer: Point) -> bool {
        self.tab_container.resize_to(pointer)
    }

    pub fn finish_tab_container_resize(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.tab_container.finish_resizing(presence, now)
    }

    pub fn cancel_tab_container_resize(&mut self) -> bool {
        self.tab_container.cancel_resizing()
    }

    pub fn start_inspector_resize(
        &mut self,
        snapshot: SplitViewResizeSnapshot,
        pointer: Point,
        now: Instant,
    ) -> bool {
        self.inspector_resize.begin_drag(snapshot, pointer, now)
    }

    pub fn resize_inspector(&mut self, pointer: Point) -> bool {
        self.inspector_resize
            .resize_to(pointer)
            .is_some_and(|next| self.inspector.set_preferred_width(next.next_size()))
    }

    pub fn finish_inspector_resize(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.inspector_resize.end_drag(presence, now)
    }

    pub fn cancel_inspector_resize(&mut self) -> bool {
        self.inspector_resize.cancel()
    }

    pub fn tab_sash_pointer_presence(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.tab_container.sash_pointer_presence(presence, now)
    }

    pub fn inspector_sash_pointer_presence(
        &mut self,
        presence: HoverPresence,
        now: Instant,
    ) -> bool {
        self.inspector_resize.pointer_presence(presence, now)
    }

    pub fn advance_sashes(&mut self, now: Instant) -> bool {
        self.tab_container.advance_sash(now) | self.inspector_resize.advance(now)
    }

    pub const fn inspector_sash_state(self) -> SashState {
        self.inspector_resize.presentation()
    }

    pub const fn tab_sash_deadline(self) -> Option<Instant> {
        self.tab_container.sash_deadline()
    }

    pub const fn inspector_sash_deadline(self) -> Option<Instant> {
        self.inspector_resize.next_deadline()
    }
}

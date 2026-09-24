use zui::ui::Rect;
use zui::ui::SplitViewResizeSnapshot;

use super::InspectorLayoutSpec;
use super::LogicalViewport;
use super::MainLayout;
use super::TabContainerLayoutSpec;

const MINIMUM_VIEWPORT_WIDTH: f32 = 240.0;
const MINIMUM_VIEWPORT_HEIGHT: f32 = 180.0;

/// Structural leaves in one Workbench frame.
///
/// The enum describes layout ownership only. Session, Settings, Terminal, and Inspector content
/// remain owned by their application hosts and are mounted into these leaves by the caller.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[cfg(test)]
pub enum WorkbenchPart {
    /// Window titlebar content.
    Titlebar,
    /// Optional body-mounted Tab Container projection.
    SidebarView,
    /// Active Workbench content.
    Main,
    /// Optional right-hand inspection content.
    Inspector,
}

/// Host-neutral sizing policy for the Workbench part tree.
///
/// This value contains layout constraints only. Visibility and preferred sizes are projected by the
/// application host, while the resulting geometry is resolved here so every content part uses the same
/// topology.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkbenchLayoutSpec {
    titlebar_height: f32,
    tab_container: TabContainerLayoutSpec,
    inspector: InspectorLayoutSpec,
}

impl WorkbenchLayoutSpec {
    /// Creates a Workbench sizing policy from the titlebar, Tab Container, and Inspector Part
    /// policies.
    pub const fn new(
        titlebar_height: f32,
        tab_container: TabContainerLayoutSpec,
        inspector: InspectorLayoutSpec,
    ) -> Self {
        Self {
            titlebar_height,
            tab_container,
            inspector,
        }
    }

    /// Resolves the structural Workbench parts for one logical viewport.
    pub fn for_viewport(self, viewport: LogicalViewport) -> Option<WorkbenchLayout> {
        if viewport.width < MINIMUM_VIEWPORT_WIDTH || viewport.height < MINIMUM_VIEWPORT_HEIGHT {
            return None;
        }

        let titlebar = Rect::from_xywh(0.0, 0.0, viewport.width, self.titlebar_height);
        let body = Rect::from_xywh(
            0.0,
            titlebar.bottom(),
            viewport.width,
            (viewport.height - titlebar.size.height).max(0.0),
        );
        let tab_container = self.tab_container.for_bounds(body);
        let main = MainLayout::for_bounds(tab_container.main_bounds(), self.inspector);

        Some(WorkbenchLayout {
            titlebar,
            tab_container: tab_container.tab_container_bounds(),
            tab_container_sash_track: tab_container.sash_track(),
            main: main.active_pane_bounds(),
            inspector: main.inspector_bounds(),
            inspector_sash_track: main.inspector_sash_track(),
            inspector_resize_snapshot: main.inspector_resize_snapshot(),
        })
    }
}

/// Resolved geometry for the Workbench part tree.
///
/// This type owns bounds and resize geometry only. Content, identity, focus semantics, and event
/// routing stay with the host that mounts each part.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkbenchLayout {
    titlebar: Rect,
    tab_container: Option<Rect>,
    tab_container_sash_track: Option<Rect>,
    main: Rect,
    inspector: Option<Rect>,
    inspector_sash_track: Option<Rect>,
    inspector_resize_snapshot: Option<SplitViewResizeSnapshot>,
}

impl WorkbenchLayout {
    #[cfg(test)]
    /// Returns the bounds for a structural Workbench part.
    pub const fn part_bounds(self, part: WorkbenchPart) -> Option<Rect> {
        match part {
            WorkbenchPart::Titlebar => Some(self.titlebar),
            WorkbenchPart::SidebarView => self.tab_container,
            WorkbenchPart::Main => Some(self.main),
            WorkbenchPart::Inspector => self.inspector,
        }
    }

    /// Returns the titlebar bounds.
    pub const fn titlebar(self) -> Rect {
        self.titlebar
    }

    /// Returns the optional body-mounted Tab Container bounds.
    pub const fn tab_container(self) -> Option<Rect> {
        self.tab_container
    }

    /// Returns the sash track for the body-mounted Tab Container.
    pub const fn tab_container_sash_track(self) -> Option<Rect> {
        self.tab_container_sash_track
    }

    /// Returns the active Workbench content bounds.
    pub const fn main(self) -> Rect {
        self.main
    }

    /// Returns the optional Inspector Part bounds.
    pub const fn inspector(self) -> Option<Rect> {
        self.inspector
    }

    /// Returns the sash track for the Inspector Part.
    pub const fn inspector_sash_track(self) -> Option<Rect> {
        self.inspector_sash_track
    }

    /// Returns the resize snapshot matching the resolved Inspector sash.
    pub const fn inspector_resize_snapshot(self) -> Option<SplitViewResizeSnapshot> {
        self.inspector_resize_snapshot
    }
}

#[cfg(test)]
#[path = "layout_workbench_tests.rs"]
mod tests;

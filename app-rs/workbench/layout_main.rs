use zui::ui::GridLayout;
use zui::ui::GridNode;
use zui::ui::GridPane;
use zui::ui::Rect;
use zui::ui::SplitViewLayoutPriority;
use zui::ui::SplitViewOrientation;
use zui::ui::SplitViewPane;
use zui::ui::SplitViewResizeSnapshot;

use super::PartVisibility;

/// Host-neutral sizing policy for one right-hand Inspector beside the main pane.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InspectorLayoutSpec {
    visibility: PartVisibility,
    preferred_width: f32,
    minimum_width: f32,
    maximum_width: f32,
    minimum_main_width: f32,
}

impl InspectorLayoutSpec {
    /// Creates an Inspector sizing policy. The host owns visibility state and persisted width; this
    /// value only projects them into layout geometry for one frame.
    pub const fn new(
        visibility: PartVisibility,
        preferred_width: f32,
        minimum_width: f32,
        maximum_width: f32,
        minimum_main_width: f32,
    ) -> Self {
        Self {
            visibility,
            preferred_width,
            minimum_width,
            maximum_width,
            minimum_main_width,
        }
    }

    /// Returns whether this policy can display the Inspector in the available width.
    pub const fn is_visible_for(self, available_width: f32) -> bool {
        matches!(self.visibility, PartVisibility::Expanded)
            && available_width >= self.minimum_width + self.minimum_main_width
    }

    /// Returns the preferred Inspector width before layout constraints are applied.
    pub const fn preferred_width(self) -> f32 {
        self.preferred_width
    }

    /// Returns the minimum width reserved for the main pane.
    pub const fn minimum_main_width(self) -> f32 {
        self.minimum_main_width
    }

    /// Converts this policy into the generic split-pane sizing consumed by [`zui`].
    pub fn pane_sizing(self, available_width: f32) -> SplitViewPane {
        let inspector =
            SplitViewPane::new(self.preferred_width, self.minimum_width, self.maximum_width);
        if self.is_visible_for(available_width) {
            inspector
        } else {
            inspector.hidden()
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum MainLeafId {
    Main,
    Inspector,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum MainSplitId {
    Root,
}

/// Resolved main-pane and optional right-hand Inspector geometry.
///
/// This type owns only topology and resize geometry. The host retains ownership of terminal,
/// agent, or editor state and may use the returned bounds to compose those domains.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MainLayout {
    active_pane_bounds: Rect,
    inspector_bounds: Option<Rect>,
    inspector_sash_track: Option<Rect>,
    inspector_resize_snapshot: Option<SplitViewResizeSnapshot>,
}

impl MainLayout {
    /// Resolves the active main pane and optional Inspector from a host-neutral sizing policy.
    pub fn for_bounds(bounds: Rect, inspector: InspectorLayoutSpec) -> Self {
        let inspector_is_visible = inspector.is_visible_for(bounds.size.width);
        let active_preferred_width = if inspector_is_visible {
            (bounds.size.width - inspector.preferred_width()).max(0.0)
        } else {
            bounds.size.width
        };
        let root = GridNode::split(
            MainSplitId::Root,
            SplitViewOrientation::Horizontal,
            vec![
                GridPane::new(
                    GridNode::leaf(MainLeafId::Main),
                    SplitViewPane::new(
                        active_preferred_width,
                        inspector.minimum_main_width(),
                        f32::INFINITY,
                    )
                    .with_priority(SplitViewLayoutPriority::High),
                ),
                GridPane::new(
                    GridNode::leaf(MainLeafId::Inspector),
                    inspector.pane_sizing(bounds.size.width),
                ),
            ],
        );
        let layout = GridLayout::new(bounds, &root);
        let inspector_sash = layout.sashes().first().copied();
        let active_pane_bounds = layout
            .leaf(MainLeafId::Main)
            .expect("main grid must retain its active leaf")
            .bounds();
        let inspector_bounds = layout.leaf(MainLeafId::Inspector).map(|leaf| leaf.bounds());
        Self {
            active_pane_bounds,
            inspector_bounds,
            inspector_sash_track: inspector_sash.map(|sash| sash.track_bounds()),
            inspector_resize_snapshot: inspector_sash.map(|sash| sash.resize_snapshot()),
        }
    }

    /// Returns the active main-pane bounds.
    pub const fn active_pane_bounds(self) -> Rect {
        self.active_pane_bounds
    }

    /// Returns the optional Inspector bounds.
    pub const fn inspector_bounds(self) -> Option<Rect> {
        self.inspector_bounds
    }

    /// Returns the sash track used to paint and hit-test the Inspector divider.
    pub const fn inspector_sash_track(self) -> Option<Rect> {
        self.inspector_sash_track
    }

    /// Returns the resize snapshot matching the resolved Inspector sash.
    pub const fn inspector_resize_snapshot(self) -> Option<SplitViewResizeSnapshot> {
        self.inspector_resize_snapshot
    }
}

#[cfg(test)]
#[path = "layout_main_tests.rs"]
mod tests;

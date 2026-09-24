use zui::ui::Rect;
use zui::ui::SplitViewLayout;
use zui::ui::SplitViewLayoutPriority;
use zui::ui::SplitViewOrientation;
use zui::ui::SplitViewPane;
use zui::ui::SplitViewResizeSnapshot;

use super::PartVisibility;

const TAB_PART_PANE_INDEX: usize = 0;
const MAIN_PANE_INDEX: usize = 1;

/// Host-neutral sizing policy for the body-mounted Tab Container.
///
/// The host retains visibility, preferred width, and resize state; this value only projects that
/// state into one frame's split geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabContainerLayoutSpec {
    visibility: PartVisibility,
    preferred_width: f32,
    minimum_width: f32,
    maximum_width: f32,
    minimum_main_width: f32,
}

impl TabContainerLayoutSpec {
    /// Creates a sizing policy for the body-mounted Tab Container.
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

    /// Returns whether the Tab Container can be displayed without violating the main minimum.
    pub const fn is_visible_for(self, available_width: f32) -> bool {
        matches!(self.visibility, PartVisibility::Expanded)
            && available_width >= self.minimum_width + self.minimum_main_width
    }

    /// Resolves the Tab Container and main Part bounds for one host viewport.
    pub fn for_bounds(self, bounds: Rect) -> TabContainerLayout {
        let tab_part_is_visible = self.is_visible_for(bounds.size.width);
        let sidebar_part =
            SplitViewPane::new(self.preferred_width, self.minimum_width, self.maximum_width);
        let sidebar_part = if tab_part_is_visible {
            sidebar_part
        } else {
            sidebar_part.hidden()
        };
        let main_preferred_width = if tab_part_is_visible {
            (bounds.size.width - self.preferred_width).max(0.0)
        } else {
            bounds.size.width
        };
        let main = SplitViewPane::new(main_preferred_width, self.minimum_main_width, f32::INFINITY)
            .with_priority(SplitViewLayoutPriority::High);
        let layout = SplitViewLayout::new(
            bounds,
            SplitViewOrientation::Horizontal,
            &[sidebar_part, main],
        );
        let tab_container_bounds = layout
            .pane_bounds(TAB_PART_PANE_INDEX)
            .filter(|bounds| !bounds.is_empty());
        let main_bounds = layout
            .pane_bounds(MAIN_PANE_INDEX)
            .expect("Tab Container split must retain its main pane");
        let sash = layout.sash(0);
        TabContainerLayout {
            tab_container_bounds,
            main_bounds,
            sash_track: sash.map(|sash| sash.track_bounds()),
            resize_snapshot: sash.map(|sash| sash.resize_snapshot()),
        }
    }
}

/// Resolved Tab Container and main Part geometry for one frame.
///
/// This type owns only bounds and resize geometry. The host retains Tab input state, active
/// identity, interaction semantics, and scene composition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabContainerLayout {
    tab_container_bounds: Option<Rect>,
    main_bounds: Rect,
    sash_track: Option<Rect>,
    resize_snapshot: Option<SplitViewResizeSnapshot>,
}

impl TabContainerLayout {
    /// Returns the optional body-mounted Tab Container bounds.
    pub const fn tab_container_bounds(self) -> Option<Rect> {
        self.tab_container_bounds
    }

    /// Returns the main Part bounds.
    pub const fn main_bounds(self) -> Rect {
        self.main_bounds
    }

    /// Returns the sash track used to paint and hit-test the Tab Container divider.
    pub const fn sash_track(self) -> Option<Rect> {
        self.sash_track
    }

    /// Returns the resize snapshot matching the resolved Tab Container sash.
    pub const fn resize_snapshot(self) -> Option<SplitViewResizeSnapshot> {
        self.resize_snapshot
    }
}

#[cfg(test)]
#[path = "layout_tab_container_tests.rs"]
mod tests;

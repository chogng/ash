//! Layout state and resize controller for the Workbench Sidebar.

use crate::PartVisibility;
use crate::Point;
use crate::Rect;
use crate::Resizable;
use crate::SashOrientation;
use crate::SashState;
use crate::ScrollAxis;
use crate::ScrollCommand;
use crate::ScrollMetrics;
use crate::ScrollState;
use crate::ScrollbarPresentation;
use crate::ScrollbarState;
use crate::TabContainerLayout;
use crate::TabContainerLayoutSpec;
use std::time::Instant;
use zui::ui::HoverPresence;

const DEFAULT_WIDTH: f32 = 200.0;
const MINIMUM_WIDTH: f32 = 160.0;
const MAXIMUM_WIDTH: f32 = 480.0;
const MINIMUM_MAIN_WIDTH: f32 = 240.0;

#[derive(Clone, Copy, Debug, PartialEq)]
enum TabContainerVisibility {
    Collapsed,
    Expanded,
}

/// Runtime layout state for the resizable body-mounted Tab Container.
///
/// The preferred width survives visibility changes and temporary viewport
/// constraints. Pointer routing owns the resize lifecycle and the scene only
/// consumes the effective width returned for its current viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabContainerState {
    visibility: TabContainerVisibility,
    preferred_width: f32,
    resizable: Resizable,
    scroll: ScrollState,
    scrollbar_presentation: ScrollbarPresentation,
}

impl Default for TabContainerState {
    fn default() -> Self {
        Self {
            visibility: TabContainerVisibility::Expanded,
            preferred_width: DEFAULT_WIDTH,
            resizable: Resizable::new(SashOrientation::Vertical),
            scroll: ScrollState::default(),
            scrollbar_presentation: ScrollbarPresentation::new(ScrollbarState::Resting, 0.0),
        }
    }
}

impl TabContainerState {
    #[cfg(test)]
    pub fn expanded() -> Self {
        Self {
            visibility: TabContainerVisibility::Expanded,
            preferred_width: DEFAULT_WIDTH,
            resizable: Resizable::new(SashOrientation::Vertical),
            scroll: ScrollState::default(),
            scrollbar_presentation: ScrollbarPresentation::new(ScrollbarState::Resting, 0.0),
        }
    }

    #[cfg(test)]
    pub fn collapsed() -> Self {
        Self {
            visibility: TabContainerVisibility::Collapsed,
            preferred_width: DEFAULT_WIDTH,
            resizable: Resizable::new(SashOrientation::Vertical),
            scroll: ScrollState::default(),
            scrollbar_presentation: ScrollbarPresentation::new(ScrollbarState::Resting, 0.0),
        }
    }

    pub const fn is_expanded(self) -> bool {
        matches!(self.visibility, TabContainerVisibility::Expanded)
    }

    pub const fn is_resizing(self) -> bool {
        self.resizable.is_dragging()
    }

    pub const fn scroll_state(self) -> ScrollState {
        self.scroll
    }

    pub const fn scrollbar_presentation(self) -> ScrollbarPresentation {
        self.scrollbar_presentation
    }

    pub(crate) fn scroll_state_mut(&mut self) -> &mut ScrollState {
        &mut self.scroll
    }

    pub(crate) fn set_scrollbar_presentation(&mut self, presentation: ScrollbarPresentation) {
        self.scrollbar_presentation = presentation;
    }

    pub fn scroll(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.scroll.apply(command, metrics, ScrollAxis::Vertical)
    }

    pub fn sash_pointer_presence(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.resizable.pointer_presence(presence, now)
    }

    pub fn advance_sash(&mut self, now: Instant) -> bool {
        self.resizable.advance(now)
    }

    pub const fn sash_state(self) -> SashState {
        self.resizable.presentation()
    }

    pub const fn sash_deadline(self) -> Option<Instant> {
        self.resizable.next_deadline()
    }

    pub fn toggle(&mut self) {
        self.visibility = match self.visibility {
            TabContainerVisibility::Collapsed => TabContainerVisibility::Expanded,
            TabContainerVisibility::Expanded => TabContainerVisibility::Collapsed,
        };
        self.resizable.cancel();
    }

    #[cfg(test)]
    pub fn visible_width(self, viewport_width: f32) -> Option<f32> {
        let bounds = self
            .layout(Rect::from_xywh(0.0, 0.0, viewport_width, 1.0))
            .tab_container_bounds()?;
        (bounds.size.width > 0.0).then_some(bounds.size.width)
    }

    pub fn layout(self, bounds: Rect) -> TabContainerLayout {
        self.layout_spec().for_bounds(bounds)
    }

    pub fn layout_spec(self) -> TabContainerLayoutSpec {
        TabContainerLayoutSpec::new(
            if self.is_expanded() {
                PartVisibility::Expanded
            } else {
                PartVisibility::Collapsed
            },
            self.preferred_width,
            MINIMUM_WIDTH,
            MAXIMUM_WIDTH,
            MINIMUM_MAIN_WIDTH,
        )
    }

    pub fn start_resizing(&mut self, viewport_width: f32, pointer: Point, now: Instant) -> bool {
        let layout = self.layout(Rect::from_xywh(0.0, 0.0, viewport_width, 1.0));
        let Some(snapshot) = layout.resize_snapshot() else {
            return false;
        };
        self.resizable.begin_drag(snapshot, pointer, now)
    }

    pub fn resize_to(&mut self, pointer: Point) -> bool {
        let Some(next) = self.resizable.resize_to(pointer) else {
            return false;
        };
        self.preferred_width = next.previous_size();
        true
    }

    pub fn finish_resizing(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.resizable.end_drag(presence, now)
    }

    pub fn cancel_resizing(&mut self) -> bool {
        self.resizable.cancel()
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;

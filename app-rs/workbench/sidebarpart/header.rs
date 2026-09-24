use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::Element;
use crate::Rect;
use crate::TextInputLayoutEngine;
use crate::UiScene;
use zui::ui::UiDispatch;

use super::WorkbenchUiStyle;
use super::mode_switcher::MODE_SWITCHER_HEIGHT;
use super::mode_switcher::ModeSwitcher;
use crate::SidebarMode;

pub const SIDEBAR_HEADER_HEIGHT: f32 = 44.0;
const HEADER_PADDING: f32 = 10.0;

/// Workbench Sidebar header hosting the product mode switcher.
pub struct SidebarHeader {
    bounds: Rect,
    mode_switcher: ModeSwitcher,
}

impl SidebarHeader {
    pub fn new(
        bounds: Rect,
        mode: SidebarMode,
        style: WorkbenchUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Self {
        let switcher_bounds = Rect::from_xywh(
            bounds.origin.x + HEADER_PADDING,
            bounds.origin.y + (bounds.size.height - MODE_SWITCHER_HEIGHT) * 0.5,
            (bounds.size.width - HEADER_PADDING * 2.0).max(1.0),
            MODE_SWITCHER_HEIGHT,
        );
        Self {
            bounds,
            mode_switcher: ModeSwitcher::new(switcher_bounds, mode, style, text_layout, dispatch),
        }
    }
}

impl Component for SidebarHeader {
    fn element(&self) -> ComponentElement {
        Element::leaf("SidebarHeader").in_bounds(self.bounds)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.draw_component(&self.mode_switcher);
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.mode_switcher);
    }
}

use ash_ui_components::InteractionRegion;
use ash_ui_components::Sash;
use ash_ui_components::SashOrientation;
use ash_ui_components::SashState;
use ash_ui_components::SashStyle;
use zui::ui::AccessibilityRole;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CursorFeedback;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::PaintRect;
use zui::ui::Rect;
use zui::ui::SplitViewOrientation;
use zui::ui::UiDispatch;

use crate::PaneGroupId;
use crate::PaneGroupLayout;
use crate::PaneSplitId;
use crate::pane_sash_element_id;

/// Base UI for PanePart split dividers and their interaction regions.
pub struct PanePartSashes<'a> {
    layout: &'a PaneGroupLayout<PaneGroupId, PaneSplitId>,
    parent: ElementId,
    border: Color,
    accent: Color,
    dispatch: &'a UiDispatch,
    active_split: Option<PaneSplitId>,
}

impl<'a> PanePartSashes<'a> {
    pub const fn new(
        layout: &'a PaneGroupLayout<PaneGroupId, PaneSplitId>,
        parent: ElementId,
        border: Color,
        accent: Color,
        dispatch: &'a UiDispatch,
        active_split: Option<PaneSplitId>,
    ) -> Self {
        Self {
            layout,
            parent,
            border,
            accent,
            dispatch,
            active_split,
        }
    }

    fn bounds(&self) -> Rect {
        let mut leaves = self.layout.leaves().iter();
        let Some(first) = leaves.next() else {
            return Rect::from_xywh(0.0, 0.0, 0.0, 0.0);
        };
        leaves.fold(first.bounds(), |bounds, leaf| {
            let leaf = leaf.bounds();
            let left = bounds.origin.x.min(leaf.origin.x);
            let top = bounds.origin.y.min(leaf.origin.y);
            let right = bounds.right().max(leaf.right());
            let bottom = bounds.bottom().max(leaf.bottom());
            Rect::from_xywh(left, top, right - left, bottom - top)
        })
    }
}

impl Component for PanePartSashes<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("PanePartSashes").in_bounds(self.bounds())
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for sash in self.layout.sashes() {
            let track = sash.track_bounds();
            let orientation = match sash.orientation() {
                SplitViewOrientation::Horizontal => SashOrientation::Vertical,
                SplitViewOrientation::Vertical => SashOrientation::Horizontal,
            };
            let identity = pane_sash_element_id(sash.split_id());
            let state = if self.active_split == Some(sash.split_id()) {
                SashState::Active
            } else if self.dispatch.is_hovered(identity) {
                SashState::Hovered
            } else {
                SashState::Resting
            };
            let component = Sash::new(track, orientation, state, SashStyle::new(self.accent));
            let divider = match sash.orientation() {
                SplitViewOrientation::Horizontal => {
                    Rect::from_xywh(track.origin.x - 0.5, track.origin.y, 1.0, track.size.height)
                }
                SplitViewOrientation::Vertical => {
                    Rect::from_xywh(track.origin.x, track.origin.y - 0.5, track.size.width, 1.0)
                }
            };
            context
                .scene_mut()
                .draw_rect(PaintRect::new(divider, self.border));
            context.draw_component(
                &InteractionRegion::new(
                    "PanePartSash",
                    identity,
                    component.interaction_bounds(),
                    AccessibilityRole::Separator,
                    "Resize pane split",
                )
                .with_parent(self.parent)
                .with_cursor(match orientation {
                    SashOrientation::Vertical => CursorFeedback::ResizeHorizontal,
                    SashOrientation::Horizontal => CursorFeedback::ResizeVertical,
                })
                .with_value(format!("{} pixels", track.origin.x.round())),
            );
            context.draw_component(&component);
        }
    }
}

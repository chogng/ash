use crate::{
    AccessibilityRole, Border, BoxShadow, Color, Component, ComponentContext, ComponentElement,
    ComputedElement, CornerRadii, Element, ElementId, PaintRect, Rect, Size, UiNode, UiScene,
};

/// Stable identities for one dialog surface and its interaction parent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DialogIds {
    parent: ElementId,
    root: ElementId,
}

impl DialogIds {
    pub const fn new(parent: ElementId, root: ElementId) -> Self {
        Self { parent, root }
    }

    pub const fn root(self) -> ElementId {
        self.root
    }
}

/// Visual tokens for a modal dialog scrim and panel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DialogStyle {
    scrim: Color,
    surface: Color,
    border: Border,
    corner_radii: CornerRadii,
    shadow: Option<BoxShadow>,
    viewport_margin: f32,
}

impl DialogStyle {
    pub const fn new(scrim: Color, surface: Color) -> Self {
        Self {
            scrim,
            surface,
            border: Border::uniform(0.0, Color::TRANSPARENT),
            corner_radii: CornerRadii::uniform(0.0),
            shadow: None,
            viewport_margin: 0.0,
        }
    }

    pub const fn with_border(mut self, border: Border) -> Self {
        self.border = border;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub const fn with_shadow(mut self, shadow: BoxShadow) -> Self {
        self.shadow = Some(shadow);
        self
    }

    pub const fn with_viewport_margin(mut self, viewport_margin: f32) -> Self {
        self.viewport_margin = viewport_margin;
        self
    }
}

/// Centered modal dialog that owns its scrim, layering, and interaction scope.
///
/// Dialog owns the viewport scrim, panel geometry, shell paint, overlay composition, focus trap,
/// and inert background interaction. The host owns visibility, dismissal, focus restoration, and
/// the state rendered in the content slot.
pub struct Dialog {
    viewport: Rect,
    panel: Rect,
    label: String,
    ids: DialogIds,
    style: DialogStyle,
}

impl Dialog {
    pub fn new(
        viewport: Rect,
        desired_size: Size,
        accessibility_label: impl Into<String>,
        ids: DialogIds,
        style: DialogStyle,
    ) -> Self {
        let viewport_margin = style.viewport_margin.max(0.0);
        let available_width = (viewport.size.width - viewport_margin * 2.0).max(0.0);
        let available_height = (viewport.size.height - viewport_margin * 2.0).max(0.0);
        let width = desired_size.width.max(0.0).min(available_width);
        let height = desired_size.height.max(0.0).min(available_height);
        let panel = Rect::from_xywh(
            viewport.origin.x + (viewport.size.width - width) * 0.5,
            viewport.origin.y + (viewport.size.height - height) * 0.5,
            width,
            height,
        );
        Self {
            viewport,
            panel,
            label: accessibility_label.into(),
            ids,
            style,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.panel
    }

    pub const fn content_bounds(&self) -> Rect {
        self.panel
    }

    pub const fn root_id(&self) -> ElementId {
        self.ids.root
    }

    /// Composes the dialog shell and arbitrary hosted content through one overlay layer.
    pub fn draw_components<R>(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_content: impl FnOnce(&mut ComponentContext<'_, '_>, Rect) -> R,
    ) -> R {
        context.with_component(self, |context, _element| {
            context.set_modal_root(self.ids.root);
            self.paint_shell(context.scene_mut());
            let result = context.with_rounded_clip(
                self.content_bounds(),
                self.style.corner_radii,
                |context| draw_content(context, self.content_bounds()),
            );
            self.paint_border(context.scene_mut());
            result
        })
    }

    pub(crate) fn element_with_name(&self, name: &'static str) -> ComponentElement {
        Element::leaf(name)
            .corner_radii(self.style.corner_radii)
            .in_overlay(self.panel)
            .with_identity(self.ids.root)
    }

    pub(crate) fn root_interaction_node(&self, element: &ComputedElement) -> UiNode {
        UiNode::new(
            self.ids.root,
            element.bounds(),
            AccessibilityRole::Group,
            self.label.clone(),
        )
        .with_parent(self.ids.parent)
    }

    pub(crate) fn paint_shell(&self, scene: &mut UiScene) {
        scene.draw_rect(PaintRect::new(self.viewport, self.style.scrim));
        let mut panel = PaintRect::new(self.panel, self.style.surface)
            .with_border(self.style.border)
            .with_corner_radii(self.style.corner_radii);
        if let Some(shadow) = self.style.shadow {
            panel = panel.with_shadow(shadow);
        }
        scene.draw_rect(panel);
    }

    fn paint_border(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.panel, Color::TRANSPARENT)
                .with_border(self.style.border)
                .with_corner_radii(self.style.corner_radii),
        );
    }
}

impl Component for Dialog {
    fn element(&self) -> ComponentElement {
        self.element_with_name("Dialog")
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(self.root_interaction_node(element))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.set_modal_root(self.ids.root);
        self.paint_shell(context.scene_mut());
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.paint_shell(scene);
    }
}

#[cfg(test)]
#[path = "dialog_tests.rs"]
mod tests;

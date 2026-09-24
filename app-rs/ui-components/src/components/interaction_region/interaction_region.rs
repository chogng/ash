use crate::{
    Component, ComponentContext, ComponentElement, ComputedElement, Element, Rect, UiScene,
};
use zui::ui::{
    AccessibilityExpansion, AccessibilityRole, AccessibilitySelection, CursorFeedback,
    DispatchInvalidation, ElementId, FocusBehavior, NavigationAxis, NavigationGroupId, NodeAction,
    UiNode,
};

/// A semantic component whose geometry and interaction contract are projected by its host.
///
/// This component is useful when a product surface has custom paint beside a reusable layout
/// primitive. The host supplies the same bounds and stable identity used by that paint, while this
/// component owns the inspectable/interactive leaf and can compose nested semantic children. It
/// never performs hit testing or executes product actions itself.
#[derive(Clone, Debug, PartialEq)]
pub struct InteractionRegion {
    name: &'static str,
    identity: ElementId,
    bounds: Rect,
    role: AccessibilityRole,
    label: String,
    parent: Option<ElementId>,
    cursor: CursorFeedback,
    focus: FocusBehavior,
    action: NodeAction,
    invalidation: DispatchInvalidation,
    navigation: Option<(NavigationGroupId, NavigationAxis)>,
    value: Option<String>,
    selection: AccessibilitySelection,
    level: Option<usize>,
    expansion: AccessibilityExpansion,
    children: Vec<Self>,
}

impl InteractionRegion {
    /// Creates a semantic component with a stable identity and host-computed bounds.
    pub fn new(
        name: &'static str,
        identity: ElementId,
        bounds: Rect,
        role: AccessibilityRole,
        label: impl Into<String>,
    ) -> Self {
        Self {
            name,
            identity,
            bounds,
            role,
            label: label.into(),
            parent: None,
            cursor: CursorFeedback::Default,
            focus: FocusBehavior::None,
            action: NodeAction::None,
            invalidation: DispatchInvalidation::Paint,
            navigation: None,
            value: None,
            selection: AccessibilitySelection::NotApplicable,
            level: None,
            expansion: AccessibilityExpansion::NotApplicable,
            children: Vec::new(),
        }
    }

    pub const fn with_parent(mut self, parent: ElementId) -> Self {
        self.parent = Some(parent);
        self
    }

    pub const fn with_cursor(mut self, cursor: CursorFeedback) -> Self {
        self.cursor = cursor;
        self
    }

    pub const fn with_focus(mut self, focus: FocusBehavior) -> Self {
        self.focus = focus;
        self
    }

    pub const fn with_action(mut self, action: NodeAction) -> Self {
        self.action = action;
        self
    }

    pub const fn with_invalidation(mut self, invalidation: DispatchInvalidation) -> Self {
        self.invalidation = invalidation;
        self
    }

    pub const fn with_navigation(mut self, group: NavigationGroupId, axis: NavigationAxis) -> Self {
        self.navigation = Some((group, axis));
        self
    }

    pub fn with_value(mut self, value: impl Into<String>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub const fn with_selection(mut self, selection: AccessibilitySelection) -> Self {
        self.selection = selection;
        self
    }

    pub const fn with_level(mut self, level: usize) -> Self {
        self.level = Some(level);
        self
    }

    pub const fn with_expansion(mut self, expansion: AccessibilityExpansion) -> Self {
        self.expansion = expansion;
        self
    }

    /// Adds semantic children that are composed under this region's interaction and inspection
    /// identity. Children are ordered as supplied so navigation and inspector order stay stable.
    pub fn with_children(mut self, children: impl IntoIterator<Item = Self>) -> Self {
        self.children = children.into_iter().collect();
        self
    }

    fn node(&self, bounds: Rect) -> UiNode {
        let mut node = UiNode::new(self.identity, bounds, self.role, self.label.clone())
            .with_cursor(self.cursor)
            .with_focus(self.focus)
            .with_action(self.action)
            .with_invalidation(self.invalidation)
            .with_selection(self.selection)
            .with_expansion(self.expansion);
        if let Some(parent) = self.parent {
            node = node.with_parent(parent);
        }
        if let Some((group, axis)) = self.navigation {
            node = node.with_navigation(group, axis);
        }
        if let Some(value) = &self.value {
            node = node.with_value(value.clone());
        }
        if let Some(level) = self.level {
            node = node.with_level(level);
        }
        node
    }
}

impl Component for InteractionRegion {
    fn element(&self) -> ComponentElement {
        Element::leaf(self.name)
            .in_bounds(self.bounds)
            .with_identity(self.identity)
            .with_inspection_label(self.label.clone())
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(self.node(element.bounds()))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for child in &self.children {
            context.draw_component(child);
        }
    }

    fn paint(&self, _scene: &mut UiScene) {}
}

#[cfg(test)]
#[path = "interaction_region_tests.rs"]
mod tests;

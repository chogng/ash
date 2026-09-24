use super::ComponentContext;
use super::ComponentElement;
use super::ComputedElement;
use super::UiScene;
use crate::ui::foundation::UiNode;

/// Frame-composition contract for a reusable native UI component.
///
/// Implementations declare layout, interaction semantics, inspection metadata, and paint from
/// caller-provided state. [`crate::ui::presentation::UiFrame`] resolves those outputs together;
/// the product host retains authoritative domain state, event reduction, and side effects.
pub trait Component {
    /// Returns the declarative root element owned by this component.
    ///
    /// Every component declares this root. [`UiScene::draw_component`] resolves it once and shares
    /// the resulting [`ComputedElement`] with paint and inspection, so components cannot silently
    /// omit box metadata or build a second inspection-only geometry path.
    fn element(&self) -> ComponentElement;

    /// Returns the interaction node owned by this component, using the computed element bounds.
    ///
    /// The returned node's ID should also be declared with
    /// [`ComponentElement::with_identity`]. The frame supplies the current interaction parent;
    /// implementations only need to specify an explicit parent when crossing a host boundary.
    fn interaction_node(&self, _element: &ComputedElement) -> Option<UiNode> {
        None
    }

    /// Paints from the computed geometry produced for [`Component::element`].
    ///
    /// Implementations with internal layout should override this method and treat `element` as
    /// their sole box geometry source. Simple leaf components may use the default delegation to
    /// [`Component::paint`].
    fn paint_element(&self, scene: &mut UiScene, element: &ComputedElement) {
        let _ = element;
        self.paint(scene);
    }

    /// Composes this component's paint and child components through one shared frame context.
    ///
    /// Leaf components can keep the default implementation. Components with children should
    /// override this method and call [`ComponentContext::draw_component`] for each child so the
    /// child receives the same inspection and interaction ancestry as its paint.
    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        self.paint_element(context.scene_mut(), element);
    }

    /// Emits this component's current visual representation into the scene.
    ///
    /// Product and composition callers should use [`UiScene::draw_component`] instead of invoking
    /// this method directly, so inspectable ancestors are not skipped.
    fn paint(&self, _scene: &mut UiScene) {}
}

impl UiScene {
    /// Resolves and draws one component while automatically registering its element metadata.
    #[track_caller]
    pub fn draw_component<C: Component + ?Sized>(&mut self, component: &C) {
        self.with_element(component.element(), |scene, computed| {
            component.paint_element(scene, computed)
        });
    }
}

#[cfg(test)]
#[path = "component_tests.rs"]
mod tests;

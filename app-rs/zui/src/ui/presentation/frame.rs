use std::time::Instant;

use super::Component;
use super::ComponentElement;
use super::ComponentRuntime;
use super::ComputedElement;
use super::UiScene;
use crate::ui::foundation::AnimationBinding;
use crate::ui::foundation::AnimationKey;
use crate::ui::foundation::Color;
use crate::ui::foundation::ElementId;
use crate::ui::foundation::InteractionSink;
use crate::ui::foundation::Rect;
use crate::ui::foundation::ScalarAnimationSpec;
/// One presentation frame that keeps paint, inspection, and interaction composition together.
///
/// The frame carries the host's clock so animation-aware components can sample time without
/// installing timers or taking ownership of the platform event loop. Custom product composition
/// may use [`UiFrame::with_composition`] for the small amount of low-level paint and interaction
/// registration that cannot yet be expressed as a reusable component.
pub struct UiFrame<S: InteractionSink + Default> {
    scene: UiScene,
    interaction: S,
    now: Instant,
}

impl<S: InteractionSink + Default> UiFrame<S> {
    /// Creates an empty frame using the current monotonic time.
    pub fn new(background: Color) -> Self {
        Self::at(background, Instant::now())
    }

    /// Creates an empty frame at an explicit monotonic time.
    pub fn at(background: Color, now: Instant) -> Self {
        Self {
            scene: UiScene::new(background),
            interaction: S::default(),
            now,
        }
    }

    pub const fn now(&self) -> Instant {
        self.now
    }

    pub const fn scene(&self) -> &UiScene {
        &self.scene
    }

    pub const fn scene_mut(&mut self) -> &mut UiScene {
        &mut self.scene
    }

    pub const fn interaction(&self) -> &S {
        &self.interaction
    }

    pub const fn interaction_mut(&mut self) -> &mut S {
        &mut self.interaction
    }

    /// Composes one component through the shared identity, inspection, interaction, and paint
    /// path.
    pub fn draw_component<C: Component + ?Sized>(&mut self, component: &C) {
        let mut context = ComponentContext::new(
            &mut self.scene,
            &mut self.interaction,
            None,
            None,
            None,
            None,
            self.now,
        );
        context.draw_component(component);
    }

    /// Runs custom composition through a context owned by this frame.
    pub fn with_context<R>(&mut self, draw: impl FnOnce(&mut ComponentContext<'_, '_>) -> R) -> R {
        let mut context = ComponentContext::new(
            &mut self.scene,
            &mut self.interaction,
            None,
            None,
            None,
            None,
            self.now,
        );
        draw(&mut context)
    }

    /// Runs composition with a retained scalar-animation registry available to every child.
    ///
    /// The registry borrow is scoped to the closure, so callers cannot accidentally retain a
    /// component context or use the registry after the frame composition has finished.
    pub fn with_animation_bindings<'frame, 'animation, R>(
        &'frame mut self,
        animation_bindings: &'animation mut dyn AnimationBinding,
        draw: impl FnOnce(&mut ComponentContext<'frame, 'animation>) -> R,
    ) -> R {
        let mut context = ComponentContext::new(
            &mut self.scene,
            &mut self.interaction,
            None,
            Some(animation_bindings),
            None,
            None,
            self.now,
        );
        draw(&mut context)
    }

    /// Runs one frame with cross-frame component state, observations, and resources enabled.
    ///
    /// Stable component identities not composed by `draw` are unmounted before this method
    /// returns, dropping their retained subscriptions and resources.
    pub fn with_component_runtime<'frame, 'runtime, R>(
        &'frame mut self,
        runtime: &'runtime mut ComponentRuntime,
        draw: impl FnOnce(&mut ComponentContext<'frame, 'runtime>) -> R,
    ) -> R {
        runtime.begin_frame();
        {
            let mut context = ComponentContext::new(
                &mut self.scene,
                &mut self.interaction,
                None,
                None,
                Some(runtime),
                None,
                self.now,
            );
            let result = draw(&mut context);
            context
                .component_runtime
                .as_deref_mut()
                .expect("component runtime remains attached during composition")
                .finish_frame();
            result
        }
    }

    /// Runs one frame with both retained component state and scalar-animation bindings.
    pub fn with_component_runtime_and_animation_bindings<'frame, 'runtime, R>(
        &'frame mut self,
        runtime: &'runtime mut ComponentRuntime,
        animation_bindings: &'runtime mut dyn AnimationBinding,
        draw: impl FnOnce(&mut ComponentContext<'frame, 'runtime>) -> R,
    ) -> R {
        runtime.begin_frame();
        {
            let mut context = ComponentContext::new(
                &mut self.scene,
                &mut self.interaction,
                None,
                Some(animation_bindings),
                Some(runtime),
                None,
                self.now,
            );
            let result = draw(&mut context);
            context
                .component_runtime
                .as_deref_mut()
                .expect("component runtime remains attached during composition")
                .finish_frame();
            result
        }
    }

    /// Draws one component with a retained scalar-animation registry available to its subtree.
    pub fn draw_component_with_animation_bindings<C: Component + ?Sized>(
        &mut self,
        animation_bindings: &mut dyn AnimationBinding,
        component: &C,
    ) {
        self.with_animation_bindings(animation_bindings, |context| {
            context.draw_component(component)
        });
    }

    /// Resolves a host-owned element and runs custom composition under the same frame context.
    pub fn with_element<R>(
        &mut self,
        element: ComponentElement,
        draw: impl FnOnce(&mut ComponentContext<'_, '_>, &ComputedElement) -> R,
    ) -> R {
        let mut context = ComponentContext::new(
            &mut self.scene,
            &mut self.interaction,
            None,
            None,
            None,
            None,
            self.now,
        );
        context.with_element(element, draw)
    }

    /// Clips custom composition while retaining the frame's shared interaction context.
    pub fn with_clip<R>(
        &mut self,
        bounds: Rect,
        draw: impl FnOnce(&mut ComponentContext<'_, '_>) -> R,
    ) -> R {
        let mut context = ComponentContext::new(
            &mut self.scene,
            &mut self.interaction,
            None,
            None,
            None,
            None,
            self.now,
        );
        context.with_clip(bounds, draw)
    }

    /// Runs a low-level composition operation while retaining [`UiFrame`] as the sole owner of
    /// paint and interaction outputs.
    ///
    /// This is intentionally scoped to one closure: callers cannot extract either output or
    /// accidentally create a second frame. New reusable components should prefer
    /// [`UiFrame::draw_component`] and [`ComponentContext::draw_component`].
    pub fn with_composition<R>(&mut self, compose: impl FnOnce(&mut UiScene, &mut S) -> R) -> R {
        compose(&mut self.scene, &mut self.interaction)
    }
}

/// Composition context passed to components that own child components.
///
/// The context carries the current interaction ancestor and delegates element registration to the
/// same [`UiScene`] that receives paint primitives. Components should use [`Self::draw_component`]
/// for children instead of manually pairing `with_element` with a second interaction traversal.
pub struct ComponentContext<'frame, 'animation> {
    scene: &'frame mut UiScene,
    interaction: &'frame mut dyn InteractionSink,
    interaction_parent: Option<ElementId>,
    animation_bindings: Option<&'animation mut dyn AnimationBinding>,
    pub(super) component_runtime: Option<&'animation mut ComponentRuntime>,
    pub(super) component_identity: Option<ElementId>,
    now: Instant,
}

impl<'frame, 'animation> ComponentContext<'frame, 'animation> {
    pub(crate) fn new(
        scene: &'frame mut UiScene,
        interaction: &'frame mut dyn InteractionSink,
        interaction_parent: Option<ElementId>,
        animation_bindings: Option<&'animation mut dyn AnimationBinding>,
        component_runtime: Option<&'animation mut ComponentRuntime>,
        component_identity: Option<ElementId>,
        now: Instant,
    ) -> Self {
        Self {
            scene,
            interaction,
            interaction_parent,
            animation_bindings,
            component_runtime,
            component_identity,
            now,
        }
    }

    pub const fn now(&self) -> Instant {
        self.now
    }

    pub const fn scene(&self) -> &UiScene {
        &*self.scene
    }

    pub const fn scene_mut(&mut self) -> &mut UiScene {
        self.scene
    }

    pub const fn interaction(&self) -> &dyn InteractionSink {
        &*self.interaction
    }

    pub const fn interaction_mut(&mut self) -> &mut dyn InteractionSink {
        self.interaction
    }

    /// Binds one stable component property and returns its current presentation value.
    ///
    /// When the frame has no animation registry, composition uses `target` directly. This keeps
    /// scene-only callers deterministic while full retained hosts get continuity and deadlines.
    pub fn bind_scalar(
        &mut self,
        key: AnimationKey,
        initial: f32,
        target: f32,
        spec: ScalarAnimationSpec,
    ) -> f32 {
        let Some(animation_bindings) = self.animation_bindings.as_deref_mut() else {
            return target;
        };
        animation_bindings.bind_scalar(key, initial, target, spec, self.now)
    }

    /// Resolves a structural element while keeping its inspection parent in the current
    /// component composition.
    pub fn with_element<R>(
        &mut self,
        element: ComponentElement,
        draw: impl FnOnce(&mut ComponentContext<'_, '_>, &ComputedElement) -> R,
    ) -> R {
        let parent = self.interaction_parent;
        let now = self.now;
        let interaction = &mut *self.interaction;
        let scene = &mut *self.scene;
        let animation_bindings = self.animation_bindings.take();
        let component_runtime = self.component_runtime.take();
        let component_identity = self.component_identity;
        let (result, animation_bindings, component_runtime) =
            scene.with_element(element, |scene, computed| {
                let identity = computed.identity().or(component_identity);
                let mut context = ComponentContext {
                    scene,
                    interaction,
                    interaction_parent: parent,
                    animation_bindings,
                    component_runtime,
                    component_identity: identity,
                    now,
                };
                if let (Some(runtime), Some(identity)) = (
                    context.component_runtime.as_deref_mut(),
                    computed.identity(),
                ) {
                    runtime.observe_component(identity);
                }
                let result = draw(&mut context, computed);
                (
                    result,
                    context.animation_bindings,
                    context.component_runtime,
                )
            });
        self.animation_bindings = animation_bindings;
        self.component_runtime = component_runtime;
        result
    }

    /// Clips child paint to a rounded rectangle while preserving interaction ancestry.
    pub fn with_rounded_clip<R>(
        &mut self,
        bounds: Rect,
        corner_radii: crate::ui::foundation::CornerRadii,
        draw: impl FnOnce(&mut ComponentContext<'_, '_>) -> R,
    ) -> R {
        let parent = self.interaction_parent;
        let now = self.now;
        let interaction = &mut *self.interaction;
        let scene = &mut *self.scene;
        let animation_bindings = self.animation_bindings.take();
        let component_runtime = self.component_runtime.take();
        let component_identity = self.component_identity;
        let (result, animation_bindings, component_runtime) =
            scene.with_rounded_clip(bounds, corner_radii, |scene| {
                let mut context = ComponentContext {
                    scene,
                    interaction,
                    interaction_parent: parent,
                    animation_bindings,
                    component_runtime,
                    component_identity,
                    now,
                };
                let result = draw(&mut context);
                (
                    result,
                    context.animation_bindings,
                    context.component_runtime,
                )
            });
        self.animation_bindings = animation_bindings;
        self.component_runtime = component_runtime;
        result
    }

    /// Runs custom paint and child composition under one component's inspection and interaction
    /// root without invoking that component's default [`Component::compose`] implementation.
    ///
    /// This is the escape hatch for host components whose paint must be interleaved with child
    /// components. The root component still owns the declarative element and semantic node, while
    /// the closure owns the order of custom primitives and child components. Use
    /// [`ComponentContext::draw_component`] when the component's own `compose` method is enough.
    pub fn with_component<C: Component + ?Sized, R>(
        &mut self,
        component: &C,
        draw: impl FnOnce(&mut ComponentContext<'_, '_>, &ComputedElement) -> R,
    ) -> R {
        let parent = self.interaction_parent;
        let now = self.now;
        let interaction = &mut *self.interaction;
        let scene = &mut *self.scene;
        let animation_bindings = self.animation_bindings.take();
        let component_runtime = self.component_runtime.take();
        let (result, animation_bindings, component_runtime) =
            scene.with_element(component.element(), |scene, computed| {
                let identity = computed.identity();
                let mut context = ComponentContext {
                    scene,
                    interaction,
                    interaction_parent: parent,
                    animation_bindings,
                    component_runtime,
                    component_identity: identity,
                    now,
                };
                if let (Some(runtime), Some(identity)) =
                    (context.component_runtime.as_deref_mut(), identity)
                {
                    runtime.observe_component(identity);
                }
                if let Some(node) = component.interaction_node(computed) {
                    debug_assert_eq!(
                        computed.identity(),
                        Some(node.id()),
                        "interactive component identity must match its element identity"
                    );
                    let node = match (node.parent(), context.interaction_parent) {
                        (None, Some(parent)) => node.with_parent(parent),
                        _ => node,
                    };
                    let child_parent = node.id();
                    context.interaction.register(node);
                    context.interaction_parent = Some(child_parent);
                }
                let result = draw(&mut context, computed);
                (
                    result,
                    context.animation_bindings,
                    context.component_runtime,
                )
            });
        self.animation_bindings = animation_bindings;
        self.component_runtime = component_runtime;
        result
    }

    /// Clips child paint while preserving the current interaction ancestor and frame clock.
    pub fn with_clip<R>(
        &mut self,
        bounds: Rect,
        draw: impl FnOnce(&mut ComponentContext<'_, '_>) -> R,
    ) -> R {
        let parent = self.interaction_parent;
        let now = self.now;
        let interaction = &mut *self.interaction;
        let scene = &mut *self.scene;
        let animation_bindings = self.animation_bindings.take();
        let component_runtime = self.component_runtime.take();
        let component_identity = self.component_identity;
        let (result, animation_bindings, component_runtime) = scene.with_clip(bounds, |scene| {
            let mut context = ComponentContext {
                scene,
                interaction,
                interaction_parent: parent,
                animation_bindings,
                component_runtime,
                component_identity,
                now,
            };
            let result = draw(&mut context);
            (
                result,
                context.animation_bindings,
                context.component_runtime,
            )
        });
        self.animation_bindings = animation_bindings;
        self.component_runtime = component_runtime;
        result
    }

    /// Marks a registered component root as the active modal interaction subtree.
    pub fn set_modal_root(&mut self, root: ElementId) {
        self.interaction.set_modal_root(root);
    }

    /// Composes a child component through the current inspection and interaction ancestry.
    pub fn draw_component<C: Component + ?Sized>(&mut self, component: &C) {
        self.with_component(component, |context, computed| {
            component.compose(context, computed);
        });
    }
}

#[cfg(test)]
#[path = "frame_tests.rs"]
mod tests;

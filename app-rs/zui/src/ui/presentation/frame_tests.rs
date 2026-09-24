use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::Component;
use super::ComponentContext;
use super::ComponentElement;
use super::ComponentRuntime;
use super::ComputedElement;
use super::UiFrame;
use crate::AccessibilityRole;
use crate::AnimationEasing;
use crate::AnimationKey;
use crate::Color;
use crate::ComponentSlot;
use crate::Element;
use crate::ElementId;
use crate::FrameInvalidation;
use crate::InteractionFrame;
use crate::PaintRect;
use crate::Rect;
use crate::ScalarAnimationSpec;
use crate::UiScene;
use crate::ViewState;
use crate::ui::foundation::UiNode;

const ROOT: ElementId = ElementId::scoped(91, 1);
const CHILD: ElementId = ElementId::scoped(91, 2);

struct Root {
    bounds: Rect,
    child: Child,
}

struct Child {
    bounds: Rect,
}

impl Component for Root {
    fn element(&self) -> ComponentElement {
        Element::leaf("Root")
            .in_bounds(self.bounds)
            .with_identity(ROOT)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(UiNode::new(
            ROOT,
            element.bounds(),
            AccessibilityRole::Group,
            "Root",
        ))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.draw_component(&self.child);
    }

    fn paint(&self, _scene: &mut super::UiScene) {}
}

impl Component for Child {
    fn element(&self) -> ComponentElement {
        Element::leaf("Child")
            .in_bounds(self.bounds)
            .with_identity(CHILD)
            .with_inspection_label("child label")
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(UiNode::new(
            CHILD,
            element.bounds(),
            AccessibilityRole::Button,
            "Child",
        ))
    }

    fn paint(&self, _scene: &mut super::UiScene) {}
}

#[test]
fn one_component_composition_joins_inspection_and_interaction_outputs() {
    let root_bounds = Rect::from_xywh(0.0, 0.0, 240.0, 120.0);
    let child_bounds = Rect::from_xywh(12.0, 16.0, 120.0, 28.0);
    let mut frame = UiFrame::<InteractionFrame>::at(Color::WHITE, Instant::now());
    frame.draw_component(&Root {
        bounds: root_bounds,
        child: Child {
            bounds: child_bounds,
        },
    });

    let child_inspection = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.element_id() == Some(CHILD))
        .expect("child inspection node");
    let child_interaction = frame
        .interaction()
        .accessibility_nodes(&crate::UiDispatch::default())
        .into_iter()
        .find(|node| node.id == CHILD)
        .expect("child interaction node");

    assert_eq!(child_inspection.bounds(), child_interaction.bounds);
    assert_eq!(child_inspection.label(), Some("child label"));
    assert_eq!(frame.interaction().ancestry(CHILD), vec![ROOT, CHILD]);
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(child_inspection.id())
            .iter()
            .map(|node| node.element_id())
            .collect::<Vec<_>>(),
        vec![Some(ROOT), Some(CHILD)]
    );
}

#[test]
fn component_context_can_interleave_custom_paint_under_a_component_root() {
    let root_bounds = Rect::from_xywh(0.0, 0.0, 240.0, 120.0);
    let child_bounds = Rect::from_xywh(12.0, 16.0, 120.0, 28.0);
    let root = Root {
        bounds: root_bounds,
        child: Child {
            bounds: child_bounds,
        },
    };
    let mut frame = UiFrame::<InteractionFrame>::at(Color::WHITE, Instant::now());

    frame.with_context(|context| {
        context.with_component(&root, |context, _| {
            context
                .scene_mut()
                .draw_rect(PaintRect::new(root_bounds, Color::WHITE));
            context.draw_component(&root.child);
        });
    });

    let child_inspection = frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.element_id() == Some(CHILD))
        .expect("child inspection node");
    assert_eq!(
        frame
            .scene()
            .inspection()
            .ancestry(child_inspection.id())
            .iter()
            .map(|node| node.element_id())
            .collect::<Vec<_>>(),
        vec![Some(ROOT), Some(CHILD)]
    );
    assert_eq!(frame.interaction().ancestry(CHILD), vec![ROOT, CHILD]);
}

#[test]
fn frame_keeps_an_explicit_clock_for_animation_sampling() {
    let now = Instant::now() + Duration::from_millis(40);
    let frame = UiFrame::<InteractionFrame>::at(Color::WHITE, now);

    assert_eq!(frame.now(), now);
}

const ANIMATED_BOX: ElementId = ElementId::scoped(91, 3);
const ANIMATED_WIDTH: AnimationKey =
    AnimationKey::new(ANIMATED_BOX, crate::AnimationProperty::Width);

struct AnimatedBox {
    target_width: f32,
}

impl Component for AnimatedBox {
    fn element(&self) -> ComponentElement {
        Element::leaf("AnimatedBox")
            .in_bounds(Rect::from_xywh(0.0, 0.0, 120.0, 24.0))
            .with_identity(ANIMATED_BOX)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        let width = context.bind_scalar(
            ANIMATED_WIDTH,
            0.0,
            self.target_width,
            ScalarAnimationSpec::new(
                Duration::from_millis(100),
                AnimationEasing::Linear,
                FrameInvalidation::Render,
            ),
        );
        context.scene_mut().draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, width, 24.0),
            Color::rgb(0, 0, 0),
        ));
    }

    fn paint(&self, _scene: &mut UiScene) {}
}

#[test]
fn component_context_binds_stable_scalar_properties_to_the_retained_registry() {
    let now = Instant::now();
    let mut registry = crate::AnimationRegistry::default();
    let mut frame = UiFrame::<InteractionFrame>::at(Color::WHITE, now);
    frame.with_animation_bindings(&mut registry, |context| {
        context.draw_component(&AnimatedBox {
            target_width: 100.0,
        });
    });
    assert_eq!(registry.value(ANIMATED_WIDTH), Some(0.0));

    let report = registry.advance(now + Duration::from_millis(16));
    assert_eq!(report.changed_keys(), &[ANIMATED_WIDTH]);
    assert!(registry.value(ANIMATED_WIDTH).unwrap() > 0.0);

    let mut next_frame =
        UiFrame::<InteractionFrame>::at(Color::WHITE, now + Duration::from_millis(16));
    next_frame.with_animation_bindings(&mut registry, |context| {
        context.draw_component(&AnimatedBox {
            target_width: 100.0,
        });
    });
    assert!(next_frame.scene().rects()[0].bounds().size.width > 0.0);
}

const STATEFUL: ElementId = ElementId::scoped(91, 4);

struct StatefulComponent {
    external: ViewState<u8>,
    local: Arc<Mutex<Option<ViewState<u8>>>>,
}

impl Component for StatefulComponent {
    fn element(&self) -> ComponentElement {
        Element::leaf("StatefulComponent")
            .in_bounds(Rect::from_xywh(0.0, 0.0, 80.0, 24.0))
            .with_identity(STATEFUL)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context
            .observe_state(ComponentSlot::new("external"), &self.external)
            .unwrap();
        let local = context
            .local_state(ComponentSlot::new("local"), || 3_u8)
            .unwrap();
        *self.local.lock().unwrap() = Some(local);
    }
}

#[test]
fn component_runtime_connects_state_invalidation_and_frame_unmount() {
    let invalidations = Arc::new(Mutex::new(Vec::new()));
    let observed = invalidations.clone();
    let mut runtime =
        ComponentRuntime::new(move |component| observed.lock().unwrap().push(component));
    let external = ViewState::new(0_u8);
    let local = Arc::new(Mutex::new(None));
    let component = StatefulComponent {
        external: external.clone(),
        local: local.clone(),
    };
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.with_component_runtime(&mut runtime, |context| {
        context.draw_component(&component);
    });

    external.update(|value| *value += 1);
    local
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .update(|value| *value += 1);
    assert_eq!(*invalidations.lock().unwrap(), vec![STATEFUL, STATEFUL]);

    let mut empty_frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    empty_frame.with_component_runtime(&mut runtime, |_| {});
    invalidations.lock().unwrap().clear();
    external.update(|value| *value += 1);
    assert!(invalidations.lock().unwrap().is_empty());
    assert_eq!(runtime.mounted_count(), 0);
}

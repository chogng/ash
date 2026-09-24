use super::Component;
use crate::{Color, ComponentElement, ComputedElement, Edges, Element, PaintRect, Rect, UiScene};

struct TestComponent {
    bounds: Rect,
}

impl Component for TestComponent {
    fn element(&self) -> ComponentElement {
        Element::leaf("TestComponent").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(PaintRect::new(self.bounds, Color::WHITE));
    }
}

#[test]
fn scene_draws_component_inside_active_clip() {
    let component = TestComponent {
        bounds: Rect::from_xywh(0.0, 0.0, 40.0, 40.0),
    };
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.with_clip(Rect::from_xywh(10.0, 12.0, 20.0, 16.0), |scene| {
        scene.draw_component(&component);
    });

    assert_eq!(scene.rects().len(), 1);
    assert_eq!(scene.inspection().nodes()[0].name(), "TestComponent");
    assert_eq!(
        scene.rects()[0].clip_bounds(),
        Some(Rect::from_xywh(10.0, 12.0, 20.0, 16.0))
    );
}

struct ElementComponent {
    bounds: Rect,
}

impl Component for ElementComponent {
    fn element(&self) -> ComponentElement {
        Element::row("ElementComponent")
            .padding(Edges::uniform(4.0))
            .gap(6.0)
            .children([Element::row("One"), Element::row("Two")])
            .in_bounds(self.bounds)
    }

    fn paint_element(&self, scene: &mut UiScene, element: &ComputedElement) {
        scene.draw_rect(PaintRect::new(element.bounds(), Color::WHITE));
    }
}

#[test]
fn scene_resolves_one_element_for_automatic_inspection_and_paint() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_component(&ElementComponent {
        bounds: Rect::from_xywh(10.0, 20.0, 100.0, 40.0),
    });

    assert_eq!(
        scene.rects()[0].bounds(),
        Rect::from_xywh(10.0, 20.0, 100.0, 40.0)
    );
    let node = &scene.inspection().nodes()[0];
    assert_eq!(node.name(), "ElementComponent");
    assert_eq!(node.padding(), Some(Edges::uniform(4.0)));
    assert_eq!(node.gap(), Some(6.0));
    assert_eq!(
        node.gap_regions(),
        &[Rect::from_xywh(57.0, 24.0, 6.0, 32.0)]
    );
    assert!(node.source_file().ends_with("component_tests.rs"));
}

use super::super::inspection::node_for_element;
use super::super::{ComponentElement, ComputedElement, ElementOverflow, PaintRect};
use super::UiScene;
use crate::ui::foundation::{Color, CornerRadii};

impl UiScene {
    pub(super) fn with_current_layer_element<R>(
        &mut self,
        element: ComponentElement,
        draw: impl FnOnce(&mut Self, &ComputedElement) -> R,
    ) -> R {
        let computed = element.compute();
        let node = node_for_element(&computed);
        self.with_inspection_node(node, |scene| {
            scene.paint_element_box(&computed);
            match computed.style().overflow() {
                ElementOverflow::Visible => {
                    scene.paint_element_children(&computed);
                    draw(scene, &computed)
                }
                ElementOverflow::Clip => scene.with_rounded_clip(
                    computed.bounds(),
                    computed
                        .style()
                        .corner_radii()
                        .unwrap_or(CornerRadii::uniform(0.0)),
                    |scene| {
                        scene.paint_element_children(&computed);
                        draw(scene, &computed)
                    },
                ),
            }
        })
    }

    fn paint_element_children(&mut self, parent: &ComputedElement) {
        for child in parent.children() {
            let node = node_for_element(child);
            self.with_inspection_node(node, |scene| {
                scene.paint_element_box(child);
                match child.style().overflow() {
                    ElementOverflow::Visible => scene.paint_element_children(child),
                    ElementOverflow::Clip => scene.with_rounded_clip(
                        child.bounds(),
                        child
                            .style()
                            .corner_radii()
                            .unwrap_or(CornerRadii::uniform(0.0)),
                        |scene| scene.paint_element_children(child),
                    ),
                }
            });
        }
    }

    fn paint_element_box(&mut self, element: &ComputedElement) {
        let style = element.style();
        if style.background().is_none() && style.border().is_none() && style.shadow().is_none() {
            return;
        }
        let mut rect = PaintRect::new(
            element.bounds(),
            style.background().unwrap_or(Color::TRANSPARENT),
        );
        if let Some(border) = style.border() {
            rect = rect.with_border(border);
        }
        if let Some(corner_radii) = style.corner_radii() {
            rect = rect.with_corner_radii(corner_radii);
        }
        if let Some(shadow) = style.shadow() {
            rect = rect.with_shadow(shadow);
        }
        self.draw_rect(rect);
    }
}

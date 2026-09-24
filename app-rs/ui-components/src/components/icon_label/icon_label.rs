use crate::{
    AlignItems, Color, Component, ComponentElement, ComputedElement, Element, ElementLength,
    JustifyContent, PaintIcon, Rect, Size, TextBlock, TextStyle, UiScene,
};
use zui::ui::{Icon, TextSpan};

/// Presentation metrics and colors for an icon followed by a single text label.
#[derive(Clone, Debug, PartialEq)]
pub struct IconLabelStyle {
    text_style: TextStyle,
    icon_color: Color,
    icon_size: f32,
    content_gap: f32,
}

impl IconLabelStyle {
    pub fn new(text_style: TextStyle) -> Self {
        Self {
            icon_color: text_style.color(),
            text_style,
            icon_size: 16.0,
            content_gap: 4.0,
        }
    }

    pub const fn with_icon_size(mut self, icon_size: f32) -> Self {
        self.icon_size = icon_size;
        self
    }

    /// Overrides the icon tint without changing the label text color.
    pub const fn with_icon_color(mut self, icon_color: Color) -> Self {
        self.icon_color = icon_color;
        self
    }

    pub const fn with_content_gap(mut self, content_gap: f32) -> Self {
        self.content_gap = content_gap;
        self
    }
}

/// Reusable presentation component that aligns one semantic icon with a text label.
#[derive(Clone, Debug, PartialEq)]
pub struct IconLabel {
    bounds: Rect,
    icon: Icon,
    label: String,
    spans: Vec<TextSpan>,
    style: IconLabelStyle,
    measured_label_size: Option<Size>,
}

impl IconLabel {
    pub fn new(bounds: Rect, icon: Icon, label: impl Into<String>, style: IconLabelStyle) -> Self {
        Self {
            bounds,
            icon,
            label: label.into(),
            spans: Vec::new(),
            style,
            measured_label_size: None,
        }
    }

    /// Creates an icon label whose visible text uses multiple colors or font treatments.
    pub fn from_spans(
        bounds: Rect,
        icon: Icon,
        spans: impl IntoIterator<Item = TextSpan>,
        style: IconLabelStyle,
    ) -> Self {
        let spans = spans.into_iter().collect::<Vec<_>>();
        let label = spans.iter().map(TextSpan::text).collect::<String>();
        Self {
            bounds,
            icon,
            label,
            spans,
            style,
            measured_label_size: None,
        }
    }

    pub fn with_measured_label_size(mut self, size: Size) -> Self {
        assert!(
            size.width.is_finite()
                && size.width >= 0.0
                && size.height.is_finite()
                && size.height >= 0.0,
            "IconLabel measured label size must be finite and non-negative"
        );
        self.measured_label_size = Some(size);
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    fn element_tree(&self) -> ComponentElement {
        let element = if let Some(label_size) = self.measured_label_size {
            let icon_size = self.style.icon_size.max(0.0);
            Element::row("IconLabel")
                .gap(self.style.content_gap.max(0.0))
                .justify_content(JustifyContent::Center)
                .align_items(AlignItems::Center)
                .child(
                    Element::leaf("IconLabelIcon")
                        .width(ElementLength::px(icon_size))
                        .height(ElementLength::px(icon_size)),
                )
                .child(
                    Element::leaf("IconLabelText")
                        .width(ElementLength::Content)
                        .height(ElementLength::Content)
                        .content_size(label_size),
                )
        } else {
            Element::leaf("IconLabel")
        };
        element
            .in_bounds(self.bounds)
            .with_inspection_label(&self.label)
    }

    fn paint_text(&self, scene: &mut UiScene, bounds: Rect) {
        if self.label.is_empty() || bounds.is_empty() {
            return;
        }
        let text = if self.spans.is_empty() {
            TextBlock::new(
                self.label.clone(),
                bounds.origin,
                bounds.size,
                self.style.text_style.clone(),
            )
        } else {
            TextBlock::from_spans(
                self.spans.clone(),
                bounds.origin,
                bounds.size,
                self.style.text_style.clone(),
            )
        };
        scene.draw_text(text);
    }

    fn paint_measured(&self, scene: &mut UiScene, element: &ComputedElement) -> bool {
        let (Some(icon), Some(label)) = (element.child(0), element.child(1)) else {
            return false;
        };
        if !icon.bounds().is_empty() {
            scene.draw_icon(PaintIcon::new(
                self.icon,
                icon.bounds(),
                self.style.icon_color,
            ));
        }
        self.paint_text(scene, label.bounds());
        true
    }

    fn paint_leading(&self, scene: &mut UiScene) {
        if self.bounds.is_empty() {
            return;
        }
        let icon_size = self
            .style
            .icon_size
            .max(0.0)
            .min(self.bounds.size.width)
            .min(self.bounds.size.height);
        let icon_y = self.bounds.origin.y + (self.bounds.size.height - icon_size) * 0.5;
        if icon_size > 0.0 {
            scene.draw_icon(PaintIcon::new(
                self.icon,
                Rect::from_xywh(self.bounds.origin.x, icon_y, icon_size, icon_size),
                self.style.icon_color,
            ));
        }

        let text_x = self.bounds.origin.x
            + icon_size
            + if icon_size > 0.0 {
                self.style.content_gap.max(0.0)
            } else {
                0.0
            };
        let text_width = (self.bounds.right() - text_x).max(0.0);
        let text_height = self
            .style
            .text_style
            .line_height()
            .max(0.0)
            .min(self.bounds.size.height);
        let text_y = self.bounds.origin.y + (self.bounds.size.height - text_height) * 0.5;
        self.paint_text(
            scene,
            Rect::from_xywh(text_x, text_y, text_width, text_height),
        );
    }
}

impl Component for IconLabel {
    fn element(&self) -> ComponentElement {
        self.element_tree()
    }

    fn paint_element(&self, scene: &mut UiScene, element: &ComputedElement) {
        if self.measured_label_size.is_none() || !self.paint_measured(scene, element) {
            self.paint_leading(scene);
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_element(scene, &self.element_tree().compute());
    }
}

#[cfg(test)]
#[path = "icon_label_tests.rs"]
mod tests;

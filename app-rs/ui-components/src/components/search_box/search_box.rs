use crate::{
    Color, Component, ComponentElement, Element, Icon, InputBox, InputBoxState, InputBoxStyle,
    PaintIcon, Rect, TextInput, TextInputLayoutEngine, UiScene,
};

/// Presentation contract for a search box composed from an [`InputBox`].
#[derive(Clone, Debug, PartialEq)]
pub struct SearchBoxStyle {
    input_box: InputBoxStyle,
    icon: Icon,
    icon_color: Color,
    icon_size: f32,
    icon_gap: f32,
}

impl SearchBoxStyle {
    pub const fn new(input_box: InputBoxStyle, icon: Icon, icon_color: Color) -> Self {
        Self {
            input_box,
            icon,
            icon_color,
            icon_size: 14.0,
            icon_gap: 6.0,
        }
    }

    pub const fn with_icon_size(mut self, icon_size: f32) -> Self {
        self.icon_size = icon_size;
        self
    }

    pub const fn with_icon_gap(mut self, icon_gap: f32) -> Self {
        self.icon_gap = icon_gap;
        self
    }
}

/// A reusable single-line search box with a leading semantic search icon.
///
/// The component delegates chrome, text layout, selection, and caret painting to [`InputBox`].
/// Its host retains ownership of the `TextInput`, focus, input routing, and filtering semantics.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchBox {
    bounds: Rect,
    input_box: InputBox,
    icon_bounds: Rect,
    icon: Icon,
    icon_color: Color,
}

impl SearchBox {
    pub fn new(
        bounds: Rect,
        placeholder: impl Into<String>,
        state: InputBoxState,
        style: SearchBoxStyle,
        input: &TextInput,
        layout_engine: &mut TextInputLayoutEngine,
    ) -> Self {
        let padding = style.input_box.padding();
        let icon_size = style.icon_size.max(0.0).min(bounds.size.height.max(0.0));
        let icon_bounds = Rect::from_xywh(
            bounds.origin.x + padding.left,
            bounds.origin.y + (bounds.size.height - icon_size) * 0.5,
            icon_size,
            icon_size,
        );
        let input_style = style.input_box.clone().with_padding(crate::Edges::new(
            padding.top,
            padding.right,
            padding.bottom,
            padding.left + icon_size + style.icon_gap.max(0.0),
        ));
        let input_box = InputBox::new(
            bounds,
            placeholder,
            state,
            input_style,
            input,
            layout_engine,
        );
        Self {
            bounds,
            input_box,
            icon_bounds,
            icon: style.icon,
            icon_color: style.icon_color,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub const fn caret_bounds(&self) -> Option<Rect> {
        self.input_box.caret_bounds()
    }
}

impl Component for SearchBox {
    fn element(&self) -> ComponentElement {
        Element::leaf("SearchBox").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.input_box);
        scene.draw_icon(PaintIcon::new(self.icon, self.icon_bounds, self.icon_color));
    }
}

#[cfg(test)]
#[path = "search_box_tests.rs"]
mod tests;

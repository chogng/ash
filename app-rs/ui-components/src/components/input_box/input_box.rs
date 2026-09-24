use crate::{
    Border, CaretVisibility, Color, Component, ComponentElement, CornerRadii, Edges, Element,
    PaintRect, Rect, TextBlock, TextStyle, UiScene,
};
use crate::{TextInput, TextInputLayout, TextInputLayoutEngine, TextInputLayoutStyle};

/// Visual state projected by the host for an input box.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum InputBoxState {
    #[default]
    Resting,
    Hovered,
    Focused(CaretVisibility),
}

/// State-dependent colors shared by an input box's fill and border contracts.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct InputBoxStateColors {
    resting: Color,
    hovered: Color,
    focused: Color,
}

impl InputBoxStateColors {
    pub const fn new(resting: Color, hovered: Color, focused: Color) -> Self {
        Self {
            resting,
            hovered,
            focused,
        }
    }

    const fn for_state(self, state: InputBoxState) -> Color {
        match state {
            InputBoxState::Resting => self.resting,
            InputBoxState::Hovered => self.hovered,
            InputBoxState::Focused(_) => self.focused,
        }
    }
}

/// Presentation contract for a single-line input box.
#[derive(Clone, Debug, PartialEq)]
pub struct InputBoxStyle {
    backgrounds: InputBoxStateColors,
    borders: InputBoxStateColors,
    border_width: f32,
    corner_radii: CornerRadii,
    padding: Edges,
    text_style: TextStyle,
    placeholder_style: TextStyle,
    selection_color: Color,
    caret_color: Color,
    preedit_underline_color: Color,
    caret_width: f32,
}

impl InputBoxStyle {
    pub fn new(
        backgrounds: InputBoxStateColors,
        borders: InputBoxStateColors,
        text_style: TextStyle,
        placeholder_style: TextStyle,
    ) -> Self {
        Self {
            backgrounds,
            borders,
            border_width: 1.0,
            corner_radii: CornerRadii::uniform(0.0),
            padding: Edges::uniform(8.0),
            text_style,
            placeholder_style,
            selection_color: Color::rgba(75, 125, 180, 120),
            caret_color: Color::WHITE,
            preedit_underline_color: Color::WHITE,
            caret_width: 1.0,
        }
    }

    pub const fn with_border_width(mut self, border_width: f32) -> Self {
        self.border_width = border_width;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub const fn with_padding(mut self, padding: Edges) -> Self {
        self.padding = padding;
        self
    }

    pub const fn with_selection_color(mut self, selection_color: Color) -> Self {
        self.selection_color = selection_color;
        self
    }

    pub const fn with_caret_color(mut self, caret_color: Color) -> Self {
        self.caret_color = caret_color;
        self
    }

    pub const fn with_preedit_underline_color(mut self, preedit_underline_color: Color) -> Self {
        self.preedit_underline_color = preedit_underline_color;
        self
    }

    pub const fn with_caret_width(mut self, caret_width: f32) -> Self {
        self.caret_width = caret_width;
        self
    }

    pub const fn padding(&self) -> Edges {
        self.padding
    }

    fn content_bounds(&self, bounds: Rect) -> Rect {
        Rect::from_xywh(
            bounds.origin.x + self.padding.left,
            bounds.origin.y + self.padding.top,
            (bounds.size.width - self.padding.left - self.padding.right).max(0.0),
            (bounds.size.height - self.padding.top - self.padding.bottom).max(0.0),
        )
    }

    fn text_layout_style(&self) -> TextInputLayoutStyle {
        TextInputLayoutStyle::new(self.text_style.clone()).with_caret_width(self.caret_width)
    }
}

/// A reusable single-line input box built on the non-component `TextInput` foundation.
///
/// The host owns the `TextInput` instance, focus, editing commands, and platform IME lifecycle.
/// The component owns only its internal visual geometry and scene composition.
#[derive(Clone, Debug, PartialEq)]
pub struct InputBox {
    bounds: Rect,
    placeholder: String,
    state: InputBoxState,
    style: InputBoxStyle,
    layout: TextInputLayout,
}

impl InputBox {
    pub fn new(
        bounds: Rect,
        placeholder: impl Into<String>,
        state: InputBoxState,
        style: InputBoxStyle,
        input: &TextInput,
        layout_engine: &mut TextInputLayoutEngine,
    ) -> Self {
        let layout = layout_engine.layout(
            style.content_bounds(bounds),
            input,
            &style.text_layout_style(),
        );
        Self {
            bounds,
            placeholder: placeholder.into(),
            state,
            style,
            layout,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub const fn caret_bounds(&self) -> Option<Rect> {
        self.layout.caret_bounds()
    }
}

impl Component for InputBox {
    fn element(&self) -> ComponentElement {
        Element::leaf("InputBox")
            .padding(self.style.padding)
            .corner_radii(self.style.corner_radii)
            .in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.backgrounds.for_state(self.state))
                .with_border(Border::uniform(
                    self.style.border_width,
                    self.style.borders.for_state(self.state),
                ))
                .with_corner_radii(self.style.corner_radii),
        );

        let content_bounds = self.layout.content_bounds();
        if content_bounds.is_empty() {
            return;
        }
        scene.with_clip(content_bounds, |scene| {
            for bounds in self.layout.selection_bounds() {
                scene.draw_rect(PaintRect::new(*bounds, self.style.selection_color));
            }
            if let InputBoxState::Focused(caret_visibility) = self.state {
                if caret_visibility == CaretVisibility::Visible
                    && self.layout.selection_bounds().is_empty()
                    && let Some(bounds) = self.layout.caret_bounds()
                {
                    scene.draw_rect(PaintRect::new(bounds, self.style.caret_color));
                }
                for bounds in self.layout.preedit_underline_bounds() {
                    scene.draw_rect(PaintRect::new(*bounds, self.style.preedit_underline_color));
                }
            }

            if self.layout.text().is_empty() {
                if !self.placeholder.is_empty() {
                    scene.draw_text(TextBlock::new(
                        self.placeholder.clone(),
                        self.layout.text_origin(),
                        self.layout.text_bounds(),
                        self.style.placeholder_style.clone(),
                    ));
                }
            } else {
                scene.draw_text(TextBlock::new(
                    self.layout.text().to_owned(),
                    self.layout.text_origin(),
                    self.layout.text_bounds(),
                    self.style.text_style.clone(),
                ));
            }
        });
    }
}

#[cfg(test)]
#[path = "input_box_tests.rs"]
mod tests;

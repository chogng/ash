use crate::{
    Color, Component, ComponentElement, CornerRadii, Edges, Element, FontFamily, PaintRect, Point,
    Rect, Size, TextBlock, TextStyle, UiScene,
};

/// Geometry and colors shared by standalone keycaps and keybinding sequences.
#[derive(Clone, Debug, PartialEq)]
pub struct KeycapStyle {
    background: Color,
    text_style: TextStyle,
    corner_radii: CornerRadii,
    height: f32,
    minimum_width: f32,
    horizontal_padding: f32,
    key_gap: f32,
    chord_gap: f32,
}

impl KeycapStyle {
    pub fn new(background: Color, foreground: Color) -> Self {
        Self {
            background,
            text_style: TextStyle::new(12.0, foreground)
                .with_family(FontFamily::SansSerif)
                .with_line_height(16.0),
            corner_radii: CornerRadii::uniform(4.0),
            height: 22.0,
            minimum_width: 22.0,
            horizontal_padding: 6.0,
            key_gap: 3.0,
            chord_gap: 9.0,
        }
    }

    pub fn with_text_style(mut self, text_style: TextStyle) -> Self {
        self.text_style = text_style;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub const fn with_height(mut self, height: f32) -> Self {
        self.height = height;
        self
    }

    pub const fn with_minimum_width(mut self, minimum_width: f32) -> Self {
        self.minimum_width = minimum_width;
        self
    }

    pub const fn with_horizontal_padding(mut self, horizontal_padding: f32) -> Self {
        self.horizontal_padding = horizontal_padding;
        self
    }

    pub const fn with_key_gap(mut self, key_gap: f32) -> Self {
        self.key_gap = key_gap;
        self
    }

    pub const fn with_chord_gap(mut self, chord_gap: f32) -> Self {
        self.chord_gap = chord_gap;
        self
    }

    pub fn key_width(&self, label: &str) -> f32 {
        let estimated_text_width =
            label.chars().count() as f32 * self.text_style.font_size() * 0.62;
        (estimated_text_width + self.horizontal_padding.max(0.0) * 2.0)
            .max(self.minimum_width.max(0.0))
    }
}

/// One presentation-only keyboard key.
#[derive(Clone, Debug, PartialEq)]
pub struct Keycap {
    bounds: Rect,
    label: String,
    style: KeycapStyle,
}

impl Keycap {
    pub fn new(origin: Point, label: impl Into<String>, style: KeycapStyle) -> Self {
        let label = label.into();
        let bounds = Rect::new(
            origin,
            Size::new(style.key_width(&label), style.height.max(0.0)),
        );
        Self {
            bounds,
            label,
            style,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }
}

impl Component for Keycap {
    fn element(&self) -> ComponentElement {
        Element::leaf("Keycap")
            .padding(Edges::new(
                0.0,
                self.style.horizontal_padding,
                0.0,
                self.style.horizontal_padding,
            ))
            .corner_radii(self.style.corner_radii)
            .in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.background)
                .with_corner_radii(self.style.corner_radii),
        );
        let text_height = self
            .style
            .text_style
            .line_height()
            .min(self.bounds.size.height);
        let text_width =
            (self.label.chars().count() as f32 * self.style.text_style.font_size() * 0.62)
                .min(self.bounds.size.width);
        let text_x = self.bounds.origin.x + (self.bounds.size.width - text_width) * 0.5;
        let text_y = self.bounds.origin.y + (self.bounds.size.height - text_height) * 0.5;
        scene.draw_text(TextBlock::new(
            self.label.clone(),
            Point::new(text_x, text_y),
            Size::new(text_width, text_height),
            self.style.text_style.clone(),
        ));
    }
}

/// One or more chords laid out as groups of reusable keycaps.
#[derive(Clone, Debug, PartialEq)]
pub struct KeycapSequence {
    keycaps: Vec<Keycap>,
    bounds: Rect,
}

impl KeycapSequence {
    pub fn new(
        origin: Point,
        chords: impl IntoIterator<Item = Vec<String>>,
        style: KeycapStyle,
    ) -> Self {
        let mut keycaps = Vec::new();
        let mut x = origin.x;
        for (chord_index, chord) in chords.into_iter().enumerate() {
            if chord_index > 0 {
                x += style.chord_gap.max(0.0);
            }
            for (index, label) in chord.into_iter().enumerate() {
                if index > 0 {
                    x += style.key_gap.max(0.0);
                }
                let keycap = Keycap::new(Point::new(x, origin.y), label, style.clone());
                x = keycap.bounds().right();
                keycaps.push(keycap);
            }
        }
        let bounds = Rect::from_xywh(
            origin.x,
            origin.y,
            (x - origin.x).max(0.0),
            if keycaps.is_empty() {
                0.0
            } else {
                style.height.max(0.0)
            },
        );
        Self { keycaps, bounds }
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }
}

impl Component for KeycapSequence {
    fn element(&self) -> ComponentElement {
        Element::leaf("KeycapSequence").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        for keycap in &self.keycaps {
            scene.draw_component(keycap);
        }
    }
}

#[cfg(test)]
#[path = "keycap_tests.rs"]
mod tests;

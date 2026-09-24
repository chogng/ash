use crate::ui::foundation::Color;

/// The font-family selection requested by UI text.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum FontFamily {
    SansSerif,
    Serif,
    Monospace,
    Named(String),
}

/// The supported semantic font weights.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum FontWeight {
    #[default]
    Normal,
    Medium,
    SemiBold,
    Bold,
}

/// The supported semantic font styles.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum FontStyle {
    #[default]
    Normal,
    Italic,
}

/// Text appearance independent of a concrete shaping or GPU backend.
#[derive(Clone, Debug, PartialEq)]
pub struct TextStyle {
    family: FontFamily,
    font_size: f32,
    line_height: f32,
    color: Color,
    weight: FontWeight,
    style: FontStyle,
}

impl TextStyle {
    pub fn new(font_size: f32, color: Color) -> Self {
        Self {
            family: FontFamily::SansSerif,
            font_size,
            line_height: font_size * 1.2,
            color,
            weight: FontWeight::Normal,
            style: FontStyle::Normal,
        }
    }

    pub fn with_family(mut self, family: FontFamily) -> Self {
        self.family = family;
        self
    }

    pub fn with_line_height(mut self, line_height: f32) -> Self {
        self.line_height = line_height;
        self
    }

    pub fn with_color(mut self, color: Color) -> Self {
        self.color = color;
        self
    }

    pub fn with_weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    pub fn with_style(mut self, style: FontStyle) -> Self {
        self.style = style;
        self
    }

    pub fn family(&self) -> &FontFamily {
        &self.family
    }

    pub fn font_size(&self) -> f32 {
        self.font_size
    }

    pub fn line_height(&self) -> f32 {
        self.line_height
    }

    pub fn color(&self) -> Color {
        self.color
    }

    pub fn weight(&self) -> FontWeight {
        self.weight
    }

    pub fn style(&self) -> FontStyle {
        self.style
    }
}

/// One owned text run with a uniform style inside a rich paragraph.
///
/// Callers should split spans only where presentation changes. The shaping engine consumes all
/// spans in one paragraph buffer so wrapping, bidirectional text, and fallback remain coordinated.
#[derive(Clone, Debug, PartialEq)]
pub struct TextSpan {
    text: String,
    style: TextStyle,
}

impl TextSpan {
    pub fn new(text: impl Into<String>, style: TextStyle) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn style(&self) -> &TextStyle {
        &self.style
    }
}

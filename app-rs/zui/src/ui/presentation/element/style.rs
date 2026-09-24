use super::super::paint::{Border, BoxShadow};
use crate::ui::foundation::{Color, CornerRadii, Edges};

/// Axis along which an element arranges its direct children.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ElementDirection {
    #[default]
    Horizontal,
    Vertical,
}

/// Declarative length resolved by the element layout engine.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum ElementLength {
    /// Consume the remaining length on the relevant axis.
    #[default]
    Fill,
    /// Request an exact logical-pixel length, subject to clipping by the parent.
    Pixels(f32),
    /// Use the element's declared content size, or a container's children-derived natural size.
    Content,
}

impl ElementLength {
    pub const fn px(value: f32) -> Self {
        Self::Pixels(value)
    }
}

/// Distribution of direct children along an element's flow axis.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum JustifyContent {
    #[default]
    Start,
    Center,
    End,
    SpaceBetween,
}

/// Placement of direct children across an element's flow axis.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum AlignItems {
    #[default]
    Start,
    Center,
    End,
}

/// Whether descendants and custom content may paint outside an element's rounded bounds.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ElementOverflow {
    #[default]
    Visible,
    Clip,
}

/// Authored box and child-flow properties for one declarative element.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ElementStyle {
    pub(super) direction: ElementDirection,
    pub(super) width: ElementLength,
    pub(super) height: ElementLength,
    pub(super) justify_content: JustifyContent,
    pub(super) align_items: AlignItems,
    pub(super) padding: Option<Edges>,
    pub(super) gap: Option<f32>,
    pub(super) corner_radii: Option<CornerRadii>,
    pub(super) background: Option<Color>,
    pub(super) border: Option<Border>,
    pub(super) shadow: Option<BoxShadow>,
    pub(super) overflow: ElementOverflow,
}

impl ElementStyle {
    const fn new(direction: ElementDirection) -> Self {
        Self {
            direction,
            width: ElementLength::Fill,
            height: ElementLength::Fill,
            justify_content: JustifyContent::Start,
            align_items: AlignItems::Start,
            padding: None,
            gap: None,
            corner_radii: None,
            background: None,
            border: None,
            shadow: None,
            overflow: ElementOverflow::Visible,
        }
    }

    pub const fn leaf() -> Self {
        Self::new(ElementDirection::Horizontal)
    }

    pub const fn row() -> Self {
        Self::new(ElementDirection::Horizontal)
    }

    pub const fn column() -> Self {
        Self::new(ElementDirection::Vertical)
    }

    pub const fn with_width(mut self, width: ElementLength) -> Self {
        self.width = width;
        self
    }

    pub const fn with_height(mut self, height: ElementLength) -> Self {
        self.height = height;
        self
    }

    pub const fn with_justify_content(mut self, justify_content: JustifyContent) -> Self {
        self.justify_content = justify_content;
        self
    }

    pub const fn with_align_items(mut self, align_items: AlignItems) -> Self {
        self.align_items = align_items;
        self
    }

    pub const fn with_padding(mut self, padding: Edges) -> Self {
        self.padding = Some(padding);
        self
    }

    pub const fn with_gap(mut self, gap: f32) -> Self {
        self.gap = Some(gap);
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = Some(corner_radii);
        self
    }

    pub const fn with_background(mut self, background: Color) -> Self {
        self.background = Some(background);
        self
    }

    pub const fn with_border(mut self, border: Border) -> Self {
        self.border = Some(border);
        self
    }

    pub const fn with_shadow(mut self, shadow: BoxShadow) -> Self {
        self.shadow = Some(shadow);
        self
    }

    pub const fn with_overflow(mut self, overflow: ElementOverflow) -> Self {
        self.overflow = overflow;
        self
    }

    pub const fn direction(self) -> ElementDirection {
        self.direction
    }

    pub const fn width(self) -> ElementLength {
        self.width
    }

    pub const fn height(self) -> ElementLength {
        self.height
    }

    pub const fn justify_content(self) -> JustifyContent {
        self.justify_content
    }

    pub const fn align_items(self) -> AlignItems {
        self.align_items
    }

    pub const fn padding(self) -> Option<Edges> {
        self.padding
    }

    pub const fn gap(self) -> Option<f32> {
        self.gap
    }

    pub const fn corner_radii(self) -> Option<CornerRadii> {
        self.corner_radii
    }

    pub const fn background(self) -> Option<Color> {
        self.background
    }

    pub const fn border(self) -> Option<Border> {
        self.border
    }

    pub const fn shadow(self) -> Option<BoxShadow> {
        self.shadow
    }

    pub const fn overflow(self) -> ElementOverflow {
        self.overflow
    }
}

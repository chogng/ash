//! Immutable icon artwork and rendering semantics.

/// Rendering behavior declared by an icon definition.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum IconRendering {
    /// Replace symbolic coverage with a caller-provided color.
    Symbolic,
    /// Preserve fixed SVG colors while allowing symbolic regions to follow caller tint.
    Multicolor,
}

/// Immutable artwork bytes and their renderer-independent rendering contract.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct IconDefinition {
    svg: &'static [u8],
    rendering: IconRendering,
}

impl IconDefinition {
    /// Creates a caller-tinted symbolic definition.
    pub const fn symbolic(svg: &'static [u8]) -> Self {
        Self {
            svg,
            rendering: IconRendering::Symbolic,
        }
    }

    /// Creates a definition that preserves fixed artwork colors.
    pub const fn multicolor(svg: &'static [u8]) -> Self {
        Self {
            svg,
            rendering: IconRendering::Multicolor,
        }
    }

    /// Returns the embedded SVG bytes.
    pub const fn svg(self) -> &'static [u8] {
        self.svg
    }

    /// Returns the declared rendering behavior.
    pub const fn rendering(self) -> IconRendering {
        self.rendering
    }
}

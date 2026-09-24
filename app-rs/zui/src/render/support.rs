//! Text-shaping bridge for renderer backend implementations.
//!
//! Product components must not use this module. It exists so renderer adapters can share the
//! exact font selection policy used by [`crate::TextLayoutEngine`] without depending on private UI
//! implementation modules.

use cosmic_text::{Family, FontSystem, Style, Weight};

use crate::ui::text::FontFamily;
use crate::ui::text::FontStyle;
use crate::ui::text::FontWeight;
use crate::ui::text::mapping;
use crate::ui::text::new_font_system;

/// Creates a font system with the same locale, fallback, and platform filtering as UI layout.
pub(crate) fn create_font_system() -> FontSystem {
    new_font_system()
}

/// Maps a backend-neutral font family request into the shared shaping engine.
pub(crate) fn font_family(family: &FontFamily) -> Family<'_> {
    mapping::shaping_family(family)
}

/// Maps a backend-neutral font weight request into the shared shaping engine.
pub(crate) fn font_weight(weight: FontWeight) -> Weight {
    mapping::shaping_weight(weight)
}

/// Maps a backend-neutral font style request into the shared shaping engine.
pub(crate) fn font_style(style: FontStyle) -> Style {
    mapping::shaping_style(style)
}

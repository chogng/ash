use cosmic_text::{Family, Style, Weight};

use crate::ui::text::FontFamily;
use crate::ui::text::FontStyle;
use crate::ui::text::FontWeight;

pub(crate) fn shaping_family(family: &FontFamily) -> Family<'_> {
    match family {
        FontFamily::SansSerif => Family::SansSerif,
        FontFamily::Serif => Family::Serif,
        FontFamily::Monospace => Family::Monospace,
        FontFamily::Named(name) => Family::Name(name),
    }
}

pub(crate) fn shaping_weight(weight: FontWeight) -> Weight {
    match weight {
        FontWeight::Normal => Weight::NORMAL,
        FontWeight::Medium => Weight::MEDIUM,
        FontWeight::SemiBold => Weight::SEMIBOLD,
        FontWeight::Bold => Weight::BOLD,
    }
}

pub(crate) fn shaping_style(style: FontStyle) -> Style {
    match style {
        FontStyle::Normal => Style::Normal,
        FontStyle::Italic => Style::Italic,
    }
}

#[cfg(test)]
#[path = "mapping_tests.rs"]
mod tests;

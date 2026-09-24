//! Renderer-independent product icon identities and embedded SVG definitions.

mod generated;

pub use generated::{ALL_ICONS, icons};
pub use zui::ui::Icon;
pub use zui::ui::IconDefinition;
pub use zui::ui::IconId;
pub use zui::ui::IconRendering;

/// Resolves a product icon from the generated catalog.
pub fn icon_by_id(id: &str) -> Option<Icon> {
    ALL_ICONS
        .binary_search_by_key(&id, |icon| icon.id().as_str())
        .ok()
        .map(|index| ALL_ICONS[index])
}

#[cfg(test)]
#[path = "icon_tests.rs"]
mod tests;

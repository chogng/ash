//! Rust GUI theme resources, loading, resolution, and component styles.

mod catalog;
mod color;
mod document;
mod loader;
mod palette;
mod size;
mod snapshot;
pub mod tokens;

pub use catalog::{ThemeCatalog, ThemeError};
pub use color::Rgba;
pub use document::{ColorScheme, ThemeDocument};
pub use loader::LoadedTheme;
pub use loader::ThemeDiagnostic;
pub use loader::ThemeLoadOptions;
pub use loader::ThemeLoader;
pub use loader::ThemeSelectionError;
pub use loader::default_device_root;
pub use size::{ThemeSize, ThemeSizeUnit};
pub use snapshot::ThemeSnapshot;

pub use palette::DEFAULT_UI_THEME;
pub use palette::DEFAULT_UI_TYPOGRAPHY;
pub use palette::EditorSyntaxColors;
pub use palette::TypographyStyle;
pub use palette::UiTheme;
pub use palette::UiTypography;

#[cfg(test)]
#[path = "theme_tests.rs"]
mod tests;

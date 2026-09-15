//! Rust GUI theme resources, token resolution, and immutable snapshots.

mod catalog;
mod color;
mod document;
mod loader;
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

#[cfg(test)]
#[path = "theme_tests.rs"]
mod tests;

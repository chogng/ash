use std::collections::BTreeMap;

use crate::catalog::ThemeError;
use crate::color::Rgba;
use crate::document::ColorScheme;
use crate::size::{ThemeSize, ThemeSizeUnit};

/// Immutable, fully resolved theme selected for one graphical host.
#[derive(Clone, Debug)]
pub struct ThemeSnapshot {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) color_scheme: ColorScheme,
    pub(crate) colors: BTreeMap<String, Rgba>,
    pub(crate) sizes: BTreeMap<String, ThemeSize>,
}

impl ThemeSnapshot {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub const fn color_scheme(&self) -> ColorScheme {
        self.color_scheme
    }

    pub fn color(&self, token: &str) -> Option<Rgba> {
        self.colors.get(token).copied()
    }

    pub fn required_color(&self, token: &str) -> Result<Rgba, ThemeError> {
        self.color(token)
            .ok_or_else(|| ThemeError::MissingResolvedColor(token.to_owned()))
    }

    pub fn colors(&self) -> &BTreeMap<String, Rgba> {
        &self.colors
    }

    pub fn size(&self, token: &str) -> Option<ThemeSize> {
        self.sizes.get(token).copied()
    }

    pub fn required_size(&self, token: &str) -> Result<ThemeSize, ThemeError> {
        self.size(token)
            .ok_or_else(|| ThemeError::MissingResolvedSize(token.to_owned()))
    }

    pub fn required_pixel_size(&self, token: &str) -> Result<f32, ThemeError> {
        let size = self.required_size(token)?;
        size.as_pixels()
            .ok_or_else(|| ThemeError::SizeUnitMismatch {
                token: token.to_owned(),
                expected: ThemeSizeUnit::Pixels,
                actual: size.unit(),
            })
    }

    pub fn sizes(&self) -> &BTreeMap<String, ThemeSize> {
        &self.sizes
    }
}

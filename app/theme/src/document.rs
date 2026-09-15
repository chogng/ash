use std::collections::BTreeMap;

use serde::Deserialize;

pub(crate) const USER_THEME_SCHEMA_URL: &str =
    "https://ash.dev/schemas/app/color-theme.schema.json";

/// Color scheme selected before one theme document is resolved.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum ColorScheme {
    Dark,
    Light,
    HighContrastDark,
    HighContrastLight,
}

impl ColorScheme {
    pub const fn built_in_id(self) -> &'static str {
        match self {
            Self::Dark | Self::HighContrastDark => "ash-dark",
            Self::Light | Self::HighContrastLight => "ash-light",
        }
    }

    pub const fn built_in_label(self) -> &'static str {
        match self {
            Self::Dark | Self::HighContrastDark => "Ash Dark",
            Self::Light | Self::HighContrastLight => "Ash Light",
        }
    }

    pub(crate) const fn variant_name(self) -> &'static str {
        match self {
            Self::Dark | Self::HighContrastDark => "dark",
            Self::Light | Self::HighContrastLight => "light",
        }
    }

    pub(crate) const fn variant_label(self) -> &'static str {
        match self {
            Self::Dark | Self::HighContrastDark => "Dark",
            Self::Light | Self::HighContrastLight => "Light",
        }
    }
}

/// Strict, versioned user color-theme document owned by the Rust GUI.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeDocument {
    #[serde(rename = "$schema")]
    schema: Option<String>,
    version: u8,
    id: String,
    label: String,
    #[serde(rename = "colorScheme")]
    color_scheme: ColorScheme,
    pub(crate) colors: BTreeMap<String, ColorValue>,
}

impl ThemeDocument {
    pub fn parse(source: &str) -> Result<Self, crate::catalog::ThemeError> {
        if source.len() > 1_048_576 {
            return Err(crate::catalog::ThemeError::DocumentTooLarge);
        }
        let document: Self = serde_json::from_str(source)?;
        document.validate()?;
        Ok(document)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub const fn color_scheme(&self) -> ColorScheme {
        self.color_scheme
    }

    fn validate(&self) -> Result<(), crate::catalog::ThemeError> {
        if self.version != 1 {
            return Err(crate::catalog::ThemeError::UnsupportedVersion(self.version));
        }
        if self
            .schema
            .as_deref()
            .is_some_and(|schema| schema != USER_THEME_SCHEMA_URL)
        {
            return Err(crate::catalog::ThemeError::InvalidSchema);
        }
        if !valid_theme_id(&self.id) {
            return Err(crate::catalog::ThemeError::InvalidThemeId(self.id.clone()));
        }
        if !valid_theme_label(&self.label) {
            return Err(crate::catalog::ThemeError::InvalidThemeLabel);
        }
        if self.colors.len() > 512 {
            return Err(crate::catalog::ThemeError::TooManyOverrides);
        }
        for value in self.colors.values() {
            value.validate(0)?;
        }
        Ok(())
    }
}

pub(crate) fn valid_theme_id(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub(crate) fn valid_theme_label(value: &str) -> bool {
    value.trim() == value && !value.is_empty() && value.chars().count() <= 80
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum ColorValue {
    Reference(String),
    Transform(ColorTransform),
    Missing,
}

impl ColorValue {
    fn validate(&self, depth: usize) -> Result<(), crate::catalog::ThemeError> {
        if depth > 8 {
            return Err(crate::catalog::ThemeError::TransformDepth);
        }
        match self {
            Self::Missing => Err(crate::catalog::ThemeError::NullOverride),
            Self::Reference(value) if valid_color_reference(value) => Ok(()),
            Self::Reference(value) => {
                Err(crate::catalog::ThemeError::InvalidColorValue(value.clone()))
            }
            Self::Transform(transform) => transform.validate(depth.saturating_add(1)),
        }
    }
}

fn valid_color_reference(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8)
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    value.split('.').all(|part| {
        let mut bytes = part.bytes();
        bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
            && bytes.all(|byte| byte.is_ascii_alphanumeric())
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ColorTransform {
    Transparent {
        value: Box<ColorValue>,
        factor: f64,
    },
    Lighten {
        value: Box<ColorValue>,
        factor: f64,
    },
    Darken {
        value: Box<ColorValue>,
        factor: f64,
    },
    Mix {
        value: Box<ColorValue>,
        other: Box<ColorValue>,
        factor: f64,
    },
    Opaque {
        value: Box<ColorValue>,
        background: Box<ColorValue>,
    },
}

impl ColorTransform {
    pub(crate) fn validate_factor(factor: f64) -> bool {
        factor.is_finite() && (0.0..=1.0).contains(&factor)
    }

    fn validate(&self, depth: usize) -> Result<(), crate::catalog::ThemeError> {
        match self {
            Self::Transparent { value, factor }
            | Self::Lighten { value, factor }
            | Self::Darken { value, factor } => {
                if !Self::validate_factor(*factor) {
                    return Err(crate::catalog::ThemeError::InvalidFactor);
                }
                value.validate(depth)
            }
            Self::Mix {
                value,
                other,
                factor,
            } => {
                if !Self::validate_factor(*factor) {
                    return Err(crate::catalog::ThemeError::InvalidFactor);
                }
                value.validate(depth)?;
                other.validate(depth)
            }
            Self::Opaque { value, background } => {
                value.validate(depth)?;
                background.validate(depth)
            }
        }
    }
}

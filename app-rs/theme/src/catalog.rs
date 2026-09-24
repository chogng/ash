use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use thiserror::Error;

use crate::color::FloatColor;
use crate::document::{
    ColorScheme, ColorTransform, ColorValue, ThemeDocument, valid_theme_id, valid_theme_label,
};
use crate::size::{ThemeSize, ThemeSizeUnit};
use crate::snapshot::ThemeSnapshot;

const EMBEDDED_MANIFEST: &str = include_str!("../resources/catalog.json");
const EMBEDDED_THEME_ENTRIES: &str = include_str!("../resources/entries.json");
const LEGACY_EDITOR_TOKEN_PREFIX: &str = "editor.semanticToken.";
const EDITOR_TOKEN_PREFIX: &str = "editor.token.";
const DEFAULT_THEME_ENTRY: &str = "ash";

/// Rust GUI color and size definitions, independent of the Desktop registry.
pub struct ThemeCatalog {
    colors: BTreeMap<String, ColorContribution>,
    sizes: BTreeMap<String, ThemeSize>,
    entries: BTreeMap<String, ThemeEntryContribution>,
}

impl ThemeCatalog {
    pub fn embedded() -> Result<Self, ThemeError> {
        let manifest: Manifest = serde_json::from_str(EMBEDDED_MANIFEST)?;
        if manifest.version != 1 {
            return Err(ThemeError::UnsupportedCatalogVersion(manifest.version));
        }
        let mut colors = BTreeMap::new();
        for contribution in manifest.colors {
            let id = contribution.id.clone();
            if colors.insert(id.clone(), contribution).is_some() {
                return Err(ThemeError::DuplicateToken(id));
            }
        }
        let mut sizes = BTreeMap::new();
        for contribution in manifest.sizes {
            let id = contribution.id.clone();
            if colors.contains_key(&id) || sizes.contains_key(&id) {
                return Err(ThemeError::DuplicateToken(id));
            }
            let value = ThemeSize::parse(&contribution.value).ok_or_else(|| {
                ThemeError::InvalidSizeValue {
                    token: contribution.id.clone(),
                    value: contribution.value.clone(),
                }
            })?;
            sizes.insert(id, value);
        }
        let entry_manifest: ThemeEntryManifest = serde_json::from_str(EMBEDDED_THEME_ENTRIES)?;
        if entry_manifest.version != 1 {
            return Err(ThemeError::UnsupportedThemeEntryVersion(
                entry_manifest.version,
            ));
        }
        let mut entries = BTreeMap::new();
        for entry in entry_manifest.entries {
            if !valid_theme_id(&entry.id) {
                return Err(ThemeError::InvalidThemeId(entry.id));
            }
            if !valid_theme_label(&entry.label) {
                return Err(ThemeError::InvalidThemeLabel);
            }
            if entry.colors.len() > 512 {
                return Err(ThemeError::TooManyOverrides);
            }
            if let Some(token) = entry
                .colors
                .keys()
                .find(|token| !colors.contains_key(*token))
            {
                return Err(ThemeError::UnknownOverride(token.clone()));
            }
            let id = entry.id.clone();
            if entries.insert(id.clone(), entry).is_some() {
                return Err(ThemeError::DuplicateThemeEntry(id));
            }
        }
        if !entries.contains_key(DEFAULT_THEME_ENTRY) {
            return Err(ThemeError::MissingThemeEntry(
                DEFAULT_THEME_ENTRY.to_owned(),
            ));
        }
        let catalog = Self {
            colors,
            sizes,
            entries,
        };
        for entry_id in catalog.entries.keys() {
            for scheme in [
                ColorScheme::Dark,
                ColorScheme::Light,
                ColorScheme::HighContrastDark,
                ColorScheme::HighContrastLight,
            ] {
                catalog.built_in_entry(entry_id, scheme)?;
            }
        }
        Ok(catalog)
    }

    pub fn built_in(&self, color_scheme: ColorScheme) -> Result<ThemeSnapshot, ThemeError> {
        self.built_in_entry(DEFAULT_THEME_ENTRY, color_scheme)
    }

    /// Resolves one data-defined product entry against the shared semantic token catalog.
    pub fn built_in_entry(
        &self,
        entry_id: &str,
        color_scheme: ColorScheme,
    ) -> Result<ThemeSnapshot, ThemeError> {
        let entry = self
            .entries
            .get(entry_id)
            .ok_or_else(|| ThemeError::MissingThemeEntry(entry_id.to_owned()))?;
        let overrides = entry
            .colors
            .iter()
            .filter_map(|(token, values)| {
                values
                    .get(&color_scheme)
                    .cloned()
                    .map(|value| (token.clone(), value))
            })
            .collect();
        self.resolve(
            &entry.theme_id(color_scheme),
            &entry.theme_label(color_scheme),
            color_scheme,
            &overrides,
        )
    }

    pub(crate) fn has_entry(&self, entry_id: &str) -> bool {
        self.entries.contains_key(entry_id)
    }

    pub(crate) fn resolve_built_in_id(
        &self,
        theme_id: &str,
    ) -> Result<Option<ThemeSnapshot>, ThemeError> {
        for entry in self.entries.values() {
            for scheme in [ColorScheme::Dark, ColorScheme::Light] {
                if entry.theme_id(scheme) == theme_id {
                    return self.built_in_entry(&entry.id, scheme).map(Some);
                }
            }
        }
        Ok(None)
    }

    pub(crate) fn is_reserved_theme_id(&self, theme_id: &str) -> bool {
        self.has_entry(theme_id)
            || self.entries.values().any(|entry| {
                [ColorScheme::Dark, ColorScheme::Light]
                    .into_iter()
                    .any(|scheme| entry.theme_id(scheme) == theme_id)
            })
            || theme_id == "system"
    }

    pub fn resolve_document(&self, document: &ThemeDocument) -> Result<ThemeSnapshot, ThemeError> {
        let overrides = normalize_legacy_editor_tokens(&document.colors);
        self.resolve(
            document.id(),
            document.label(),
            document.color_scheme(),
            &overrides,
        )
    }

    fn resolve(
        &self,
        id: &str,
        label: &str,
        color_scheme: ColorScheme,
        overrides: &BTreeMap<String, ColorValue>,
    ) -> Result<ThemeSnapshot, ThemeError> {
        for token in overrides.keys() {
            if !self.colors.contains_key(token) {
                return Err(ThemeError::UnknownOverride(token.clone()));
            }
        }
        let mut resolver = Resolver {
            catalog: self,
            color_scheme,
            overrides,
            cache: HashMap::new(),
            resolving: Vec::new(),
        };
        let mut colors = BTreeMap::new();
        for token in self.colors.keys() {
            if let Some(color) = resolver.resolve_token(token)? {
                colors.insert(token.clone(), color.quantized());
            }
        }
        Ok(ThemeSnapshot {
            id: id.to_owned(),
            label: label.to_owned(),
            color_scheme,
            colors,
            sizes: self.sizes.clone(),
        })
    }
}

struct Resolver<'a> {
    catalog: &'a ThemeCatalog,
    color_scheme: ColorScheme,
    overrides: &'a BTreeMap<String, ColorValue>,
    cache: HashMap<String, Option<FloatColor>>,
    resolving: Vec<String>,
}

impl Resolver<'_> {
    fn resolve_token(&mut self, id: &str) -> Result<Option<FloatColor>, ThemeError> {
        if let Some(color) = self.cache.get(id) {
            return Ok(*color);
        }
        if let Some(start) = self.resolving.iter().position(|token| token == id) {
            let mut cycle = self.resolving[start..].to_vec();
            cycle.push(id.to_owned());
            return Err(ThemeError::ColorCycle(cycle.join(" -> ")));
        }
        let contribution = self
            .catalog
            .colors
            .get(id)
            .ok_or_else(|| ThemeError::UnknownReference(id.to_owned()))?;
        self.resolving.push(id.to_owned());
        let source = self
            .overrides
            .get(id)
            .or_else(|| contribution.defaults.get(&self.color_scheme))
            .ok_or_else(|| ThemeError::MissingDefault(id.to_owned()))?;
        let color = self.resolve_value(source, 0)?;
        self.resolving.pop();
        if contribution.needs_transparency && color.is_some_and(FloatColor::is_opaque) {
            return Err(ThemeError::TransparencyRequired(id.to_owned()));
        }
        self.cache.insert(id.to_owned(), color);
        Ok(color)
    }

    fn resolve_value(
        &mut self,
        value: &ColorValue,
        depth: usize,
    ) -> Result<Option<FloatColor>, ThemeError> {
        if depth > 8 {
            return Err(ThemeError::TransformDepth);
        }
        match value {
            ColorValue::Missing => Ok(None),
            ColorValue::Reference(reference) if reference.starts_with('#') => {
                FloatColor::parse(reference).map(Some)
            }
            ColorValue::Reference(reference) => self.resolve_token(reference),
            ColorValue::Transform(transform) => {
                self.resolve_transform(transform, depth.saturating_add(1))
            }
        }
    }

    fn resolve_transform(
        &mut self,
        transform: &ColorTransform,
        depth: usize,
    ) -> Result<Option<FloatColor>, ThemeError> {
        let value = match transform {
            ColorTransform::Transparent { value, .. }
            | ColorTransform::Lighten { value, .. }
            | ColorTransform::Darken { value, .. }
            | ColorTransform::Mix { value, .. }
            | ColorTransform::Opaque { value, .. } => self.resolve_value(value, depth)?,
        };
        let Some(value) = value else {
            return Ok(None);
        };
        match transform {
            ColorTransform::Transparent { factor, .. } => {
                valid_factor(*factor)?;
                Ok(Some(value.transparent(*factor)))
            }
            ColorTransform::Lighten { factor, .. } => {
                valid_factor(*factor)?;
                Ok(Some(value.lighten(*factor)))
            }
            ColorTransform::Darken { factor, .. } => {
                valid_factor(*factor)?;
                Ok(Some(value.darken(*factor)))
            }
            ColorTransform::Mix { other, factor, .. } => {
                valid_factor(*factor)?;
                Ok(self
                    .resolve_value(other, depth)?
                    .map(|other| value.mix(other, *factor)))
            }
            ColorTransform::Opaque { background, .. } => Ok(self
                .resolve_value(background, depth)?
                .map(|background| value.make_opaque(background))),
        }
    }
}

fn valid_factor(factor: f64) -> Result<(), ThemeError> {
    if ColorTransform::validate_factor(factor) {
        Ok(())
    } else {
        Err(ThemeError::InvalidFactor)
    }
}

fn normalize_legacy_editor_tokens(
    overrides: &BTreeMap<String, ColorValue>,
) -> BTreeMap<String, ColorValue> {
    let mut normalized = overrides.clone();
    for (id, value) in overrides {
        let Some(suffix) = id.strip_prefix(LEGACY_EDITOR_TOKEN_PREFIX) else {
            continue;
        };
        normalized
            .entry(format!("{EDITOR_TOKEN_PREFIX}{suffix}"))
            .or_insert_with(|| value.clone());
    }
    normalized
}

#[derive(Deserialize)]
struct Manifest {
    version: u8,
    colors: Vec<ColorContribution>,
    sizes: Vec<SizeContribution>,
}

#[derive(Deserialize)]
struct ThemeEntryManifest {
    version: u8,
    entries: Vec<ThemeEntryContribution>,
}

#[derive(Deserialize)]
struct ThemeEntryContribution {
    id: String,
    label: String,
    colors: BTreeMap<String, BTreeMap<ColorScheme, ColorValue>>,
}

impl ThemeEntryContribution {
    fn theme_id(&self, color_scheme: ColorScheme) -> String {
        format!("{}-{}", self.id, color_scheme.variant_name())
    }

    fn theme_label(&self, color_scheme: ColorScheme) -> String {
        format!("{} {}", self.label, color_scheme.variant_label())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorContribution {
    id: String,
    needs_transparency: bool,
    defaults: BTreeMap<ColorScheme, ColorValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SizeContribution {
    id: String,
    value: String,
}

#[derive(Debug, Error)]
pub enum ThemeError {
    #[error("theme JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("theme document exceeds the 1 MiB limit")]
    DocumentTooLarge,
    #[error("theme document version {0} is unsupported")]
    UnsupportedVersion(u8),
    #[error("design-token catalog version {0} is unsupported")]
    UnsupportedCatalogVersion(u8),
    #[error("theme-entry catalog version {0} is unsupported")]
    UnsupportedThemeEntryVersion(u8),
    #[error("theme $schema is invalid")]
    InvalidSchema,
    #[error("theme id '{0}' must be lowercase kebab-case")]
    InvalidThemeId(String),
    #[error("theme label must contain 1 to 80 trimmed characters")]
    InvalidThemeLabel,
    #[error("theme contains more than 512 color overrides")]
    TooManyOverrides,
    #[error("theme color overrides cannot be null")]
    NullOverride,
    #[error("invalid theme color value '{0}'")]
    InvalidColorValue(String),
    #[error("invalid hexadecimal color '{value}'")]
    InvalidColor { value: String },
    #[error("unknown color token override '{0}'")]
    UnknownOverride(String),
    #[error("unknown color token reference '{0}'")]
    UnknownReference(String),
    #[error("color token '{0}' has no default for the selected scheme")]
    MissingDefault(String),
    #[error("resolved theme is missing required color '{0}'")]
    MissingResolvedColor(String),
    #[error("duplicate token '{0}' in the Rust GUI catalog")]
    DuplicateToken(String),
    #[error("invalid size token '{token}' value '{value}'")]
    InvalidSizeValue { token: String, value: String },
    #[error("resolved theme is missing required size '{0}'")]
    MissingResolvedSize(String),
    #[error("size token '{token}' uses {actual}; expected {expected}")]
    SizeUnitMismatch {
        token: String,
        expected: ThemeSizeUnit,
        actual: ThemeSizeUnit,
    },
    #[error("duplicate built-in theme entry '{0}'")]
    DuplicateThemeEntry(String),
    #[error("built-in theme entry '{0}' is unavailable")]
    MissingThemeEntry(String),
    #[error("color token cycle: {0}")]
    ColorCycle(String),
    #[error("color transform factor must be finite and between 0 and 1")]
    InvalidFactor,
    #[error("color transform exceeds the maximum depth")]
    TransformDepth,
    #[error("color token '{0}' must remain transparent")]
    TransparencyRequired(String),
}

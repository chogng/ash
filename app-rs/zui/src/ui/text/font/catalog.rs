use super::platform;

/// A snapshot of font families available through the host platform.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FontCatalog {
    family_names: Vec<String>,
}

impl FontCatalog {
    /// Loads and canonicalizes the system font-family list.
    pub fn system() -> Result<Self, FontCatalogError> {
        platform::system_family_names().map(Self::from_family_names)
    }

    pub fn family_names(&self) -> &[String] {
        &self.family_names
    }

    fn from_family_names(family_names: Vec<String>) -> Self {
        let mut family_names = family_names
            .into_iter()
            .filter(|name| !name.trim().is_empty())
            .collect::<Vec<_>>();
        family_names.sort_unstable();
        family_names.dedup();
        Self { family_names }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FontCatalogError {
    #[error("failed to load the system font catalog: {0}")]
    Backend(String),
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

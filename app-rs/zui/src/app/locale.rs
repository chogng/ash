use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;
use std::sync::Arc;

use unic_langid::LanguageIdentifier;
use unic_langid::LanguageIdentifierError;

#[path = "locale/access.rs"]
mod access;
#[path = "locale/platform.rs"]
mod platform;

/// Validated Unicode language identifier used by application locale APIs.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ApplicationLocale {
    identifier: String,
    country_code: Option<String>,
}

impl ApplicationLocale {
    /// Parses and canonicalizes a BCP 47-style Unicode language identifier.
    pub fn new(identifier: impl Into<String>) -> Result<Self, ApplicationLocaleError> {
        let identifier = identifier.into();
        let parsed = identifier
            .parse::<LanguageIdentifier>()
            .map_err(|source| ApplicationLocaleError::invalid(identifier.clone(), source))?;
        let country_code = parsed.region.map(|region| region.to_string());
        Ok(Self {
            identifier: parsed.to_string(),
            country_code,
        })
    }

    fn from_platform(identifier: &str) -> Option<Self> {
        let identifier = identifier
            .split(['.', '@'])
            .next()
            .unwrap_or_default()
            .replace('_', "-");
        if identifier.eq_ignore_ascii_case("C") || identifier.eq_ignore_ascii_case("POSIX") {
            return Self::new("en-US").ok();
        }
        Self::new(identifier).ok()
    }

    /// Returns the canonical language identifier.
    pub fn as_str(&self) -> &str {
        &self.identifier
    }

    /// Returns the identifier's explicit ISO 3166 region subtag, when present.
    pub fn country_code(&self) -> Option<&str> {
        self.country_code.as_deref()
    }
}

impl AsRef<str> for ApplicationLocale {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for ApplicationLocale {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Stable category for an application-locale validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationLocaleErrorCode {
    /// The supplied value is not a well-formed Unicode language identifier.
    InvalidIdentifier,
}

/// Invalid application-locale identifier rejected before native startup.
#[derive(Debug)]
pub struct ApplicationLocaleError {
    value: String,
    source: LanguageIdentifierError,
}

impl ApplicationLocaleError {
    fn invalid(value: String, source: LanguageIdentifierError) -> Self {
        Self { value, source }
    }

    /// Returns the stable validation-failure category.
    pub const fn code(&self) -> ApplicationLocaleErrorCode {
        ApplicationLocaleErrorCode::InvalidIdentifier
    }

    /// Returns the rejected identifier exactly as supplied.
    pub fn value(&self) -> &str {
        &self.value
    }
}

impl fmt::Display for ApplicationLocaleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid application locale {:?}: {}",
            self.value, self.source
        )
    }
}

impl Error for ApplicationLocaleError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

#[derive(Default)]
pub(crate) struct ApplicationLocaleConfig {
    application: Option<ApplicationLocale>,
}

impl ApplicationLocaleConfig {
    fn set_application(&mut self, application: ApplicationLocale) {
        self.application = Some(application);
    }
}

#[derive(Clone)]
pub(crate) struct ApplicationLocales {
    state: Arc<ApplicationLocaleState>,
}

struct ApplicationLocaleState {
    application: ApplicationLocale,
    system: Option<ApplicationLocale>,
    preferred_system_languages: Vec<ApplicationLocale>,
}

impl ApplicationLocales {
    pub(crate) fn detect(config: ApplicationLocaleConfig) -> Self {
        Self::from_detected(config, platform::system_locale(), sys_locale::get_locales())
    }

    fn from_detected(
        config: ApplicationLocaleConfig,
        system: Option<ApplicationLocale>,
        preferred: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Self {
        let mut seen = BTreeSet::new();
        let preferred_system_languages = preferred
            .into_iter()
            .filter_map(|identifier| ApplicationLocale::from_platform(identifier.as_ref()))
            .filter(|locale| seen.insert(locale.clone()))
            .collect::<Vec<_>>();
        let application = config
            .application
            .or_else(|| preferred_system_languages.first().cloned())
            .or_else(|| system.clone())
            .unwrap_or_else(|| {
                ApplicationLocale::new("en-US").expect("the built-in fallback locale is valid")
            });
        Self {
            state: Arc::new(ApplicationLocaleState {
                application,
                system,
                preferred_system_languages,
            }),
        }
    }

    fn application_locale(&self) -> ApplicationLocale {
        self.state.application.clone()
    }

    fn system_locale(&self) -> Option<ApplicationLocale> {
        self.state.system.clone()
    }

    fn preferred_system_languages(&self) -> Vec<ApplicationLocale> {
        self.state.preferred_system_languages.clone()
    }

    fn locale_country_code(&self) -> Option<String> {
        self.state
            .system
            .as_ref()
            .and_then(ApplicationLocale::country_code)
            .map(str::to_owned)
    }
}

#[cfg(test)]
#[path = "locale_tests.rs"]
mod tests;

use std::error::Error;

use super::ApplicationLocale;
use super::ApplicationLocaleConfig;
use super::ApplicationLocaleErrorCode;
use super::ApplicationLocales;

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn public_locale_values_validate_canonical_identifiers() {
    assert_send_sync::<ApplicationLocale>();
    let locale = ApplicationLocale::new("zh-Hant-tw").unwrap();
    assert_eq!(locale.as_str(), "zh-Hant-TW");
    assert_eq!(locale.country_code(), Some("TW"));
    assert_eq!(locale.to_string(), "zh-Hant-TW");

    let error = ApplicationLocale::new("not_a_locale").unwrap_err();
    assert_eq!(error.code(), ApplicationLocaleErrorCode::InvalidIdentifier);
    assert_eq!(error.value(), "not_a_locale");
    assert!(error.source().is_some());
}

#[test]
fn platform_identifiers_remove_posix_encoding_and_modifiers() {
    assert_eq!(
        ApplicationLocale::from_platform("pt_BR.UTF-8@latin")
            .unwrap()
            .as_str(),
        "pt-BR"
    );
    assert_eq!(
        ApplicationLocale::from_platform("C.UTF-8")
            .unwrap()
            .as_str(),
        "en-US"
    );
}

#[test]
fn detection_keeps_application_system_and_language_preferences_distinct() {
    let system = ApplicationLocale::new("de-DE").unwrap();
    let locales = ApplicationLocales::from_detected(
        ApplicationLocaleConfig::default(),
        Some(system),
        ["fr_CA", "fr-CA", "en-US"],
    );
    assert_eq!(locales.application_locale().as_str(), "fr-CA");
    assert_eq!(locales.system_locale().unwrap().as_str(), "de-DE");
    assert_eq!(locales.locale_country_code().as_deref(), Some("DE"));
    assert_eq!(
        locales
            .preferred_system_languages()
            .iter()
            .map(ApplicationLocale::as_str)
            .collect::<Vec<_>>(),
        ["fr-CA", "en-US"]
    );
}

#[test]
fn explicit_application_locale_does_not_replace_system_observations() {
    let mut config = ApplicationLocaleConfig::default();
    config.set_application(ApplicationLocale::new("ja-JP").unwrap());
    let locales = ApplicationLocales::from_detected(
        config,
        Some(ApplicationLocale::new("de-DE").unwrap()),
        ["fr-FR"],
    );
    assert_eq!(locales.application_locale().as_str(), "ja-JP");
    assert_eq!(locales.system_locale().unwrap().as_str(), "de-DE");
    assert_eq!(locales.preferred_system_languages()[0].as_str(), "fr-FR");
}

#[test]
fn missing_platform_locale_uses_a_valid_application_fallback() {
    let locales = ApplicationLocales::from_detected(
        ApplicationLocaleConfig::default(),
        None,
        std::iter::empty::<&str>(),
    );
    assert_eq!(locales.application_locale().as_str(), "en-US");
    assert!(locales.system_locale().is_none());
    assert!(locales.preferred_system_languages().is_empty());
    assert!(locales.locale_country_code().is_none());
}

#[test]
fn production_detection_always_selects_a_valid_application_locale() {
    let locales = ApplicationLocales::detect(ApplicationLocaleConfig::default());
    assert!(ApplicationLocale::new(locales.application_locale().as_str()).is_ok());
}

use crate::app::AppProxy;
use crate::app::ApplicationBuilder;
use crate::app::ApplicationHandle;

use super::ApplicationLocale;

macro_rules! public_locale_methods {
    ($($field:ident).+) => {
        /// Returns the application language selected at startup.
        pub fn application_locale(&self) -> ApplicationLocale {
            self.$($field).+.application_locale()
        }

        /// Returns the operating system locale used for regional formatting, when detectable.
        pub fn system_locale(&self) -> Option<ApplicationLocale> {
            self.$($field).+.system_locale()
        }

        /// Returns preferred system languages from most to least preferred.
        pub fn preferred_system_languages(&self) -> Vec<ApplicationLocale> {
            self.$($field).+.preferred_system_languages()
        }

        /// Returns the explicit country code in the detected system locale, when present.
        pub fn locale_country_code(&self) -> Option<String> {
            self.$($field).+.locale_country_code()
        }
    };
}

impl ApplicationBuilder {
    /// Overrides the application language before product state is constructed.
    pub fn with_application_locale(mut self, locale: ApplicationLocale) -> Self {
        self.application_locale.set_application(locale);
        self
    }
}

impl<T: 'static> AppProxy<T> {
    public_locale_methods!(application_locales);
}

impl<T: 'static> ApplicationHandle<T> {
    public_locale_methods!(event_proxy.application_locales);
}

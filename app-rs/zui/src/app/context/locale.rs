use crate::app::ApplicationLocale;

use super::AppContext;
use super::WindowContext;

macro_rules! application_locale_methods {
    () => {
        /// Returns the application language selected at startup.
        pub fn application_locale(&self) -> ApplicationLocale {
            self.event_proxy.application_locale()
        }

        /// Returns the operating system locale used for regional formatting, when detectable.
        pub fn system_locale(&self) -> Option<ApplicationLocale> {
            self.event_proxy.system_locale()
        }

        /// Returns preferred system languages from most to least preferred.
        pub fn preferred_system_languages(&self) -> Vec<ApplicationLocale> {
            self.event_proxy.preferred_system_languages()
        }

        /// Returns the explicit country code in the detected system locale, when present.
        pub fn locale_country_code(&self) -> Option<String> {
            self.event_proxy.locale_country_code()
        }
    };
}

impl<'a, T: 'static> AppContext<'a, T> {
    application_locale_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    application_locale_methods!();
}

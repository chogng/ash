use crate::app::ApplicationHandle;
use crate::services::ApplicationBadge;
use crate::services::SystemServiceError;

use super::AppContext;
use super::WindowContext;

macro_rules! application_badge_methods {
    () => {
        /// Applies explicit application launcher or Dock badge content.
        pub fn set_application_badge(
            &self,
            badge: ApplicationBadge,
        ) -> Result<(), SystemServiceError> {
            self.services.application_badge().set(badge)
        }

        /// Displays an Electron-style numeric application badge; zero hides it.
        pub fn set_badge_count(&self, count: i64) -> Result<(), SystemServiceError> {
            self.services.application_badge().set_count(count)
        }

        /// Displays a plain marker where supported and hides the application badge on Linux.
        pub fn set_indeterminate_badge(&self) -> Result<(), SystemServiceError> {
            self.services.application_badge().set_indeterminate()
        }

        /// Hides the current application badge.
        pub fn clear_application_badge(&self) -> Result<(), SystemServiceError> {
            self.services.application_badge().clear()
        }

        /// Returns the last application badge successfully accepted by the backend.
        pub fn application_badge(&self) -> ApplicationBadge {
            self.services.application_badge().badge()
        }

        /// Returns the last successful numeric badge count, or zero for other badge content.
        pub fn badge_count(&self) -> i64 {
            self.services.application_badge().count()
        }
    };
}

impl<T: 'static> ApplicationHandle<T> {
    application_badge_methods!();
}

impl<'a, T: 'static> AppContext<'a, T> {
    application_badge_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    application_badge_methods!();
}

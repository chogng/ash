use crate::app::ApplicationHandle;
use crate::services::LoginItemOptions;
use crate::services::LoginItemSettings;
use crate::services::LoginItemState;
use crate::services::SystemServiceError;

use super::AppContext;
use super::WindowContext;

macro_rules! login_item_methods {
    () => {
        /// Applies one validated operating-system login-item mutation.
        pub fn set_login_item_settings(
            &self,
            settings: LoginItemSettings,
        ) -> Result<(), SystemServiceError> {
            self.services.login_items().set(settings)
        }

        /// Queries one exact operating-system login-item identity and command.
        pub fn login_item_settings(
            &self,
            options: LoginItemOptions,
        ) -> Result<LoginItemState, SystemServiceError> {
            self.services.login_items().get(options)
        }
    };
}

impl<T: 'static> ApplicationHandle<T> {
    login_item_methods!();
}

impl<'a, T: 'static> AppContext<'a, T> {
    login_item_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    login_item_methods!();
}

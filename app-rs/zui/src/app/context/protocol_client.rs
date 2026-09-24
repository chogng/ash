use crate::app::ApplicationHandle;
use crate::app::ProtocolScheme;
use crate::services::ProtocolClientOptions;
use crate::services::ProtocolClientRemoval;
use crate::services::SystemServiceError;

use super::AppContext;
use super::WindowContext;

macro_rules! protocol_client_methods {
    () => {
        /// Makes the current executable the operating system's default client for `scheme`.
        pub fn set_as_default_protocol_client(
            &self,
            scheme: ProtocolScheme,
        ) -> Result<(), SystemServiceError> {
            self.services.protocol_clients().set_default(scheme)
        }

        /// Makes an explicitly configured application command the default client for `scheme`.
        pub fn set_as_default_protocol_client_with(
            &self,
            scheme: ProtocolScheme,
            options: ProtocolClientOptions,
        ) -> Result<(), SystemServiceError> {
            self.services
                .protocol_clients()
                .set_default_with(scheme, options)
        }

        /// Returns whether the current executable is the default client for `scheme`.
        pub fn is_default_protocol_client(
            &self,
            scheme: ProtocolScheme,
        ) -> Result<bool, SystemServiceError> {
            self.services.protocol_clients().is_default(scheme)
        }

        /// Compares an explicitly configured application command with the current default client.
        pub fn is_default_protocol_client_with(
            &self,
            scheme: ProtocolScheme,
            options: ProtocolClientOptions,
        ) -> Result<bool, SystemServiceError> {
            self.services
                .protocol_clients()
                .is_default_with(scheme, options)
        }

        /// Removes the current executable as default client when it is currently selected.
        pub fn remove_as_default_protocol_client(
            &self,
            scheme: ProtocolScheme,
        ) -> Result<ProtocolClientRemoval, SystemServiceError> {
            self.services.protocol_clients().remove_default(scheme)
        }

        /// Removes an explicitly configured application command when it is currently selected.
        pub fn remove_as_default_protocol_client_with(
            &self,
            scheme: ProtocolScheme,
            options: ProtocolClientOptions,
        ) -> Result<ProtocolClientRemoval, SystemServiceError> {
            self.services
                .protocol_clients()
                .remove_default_with(scheme, options)
        }
    };
}

impl<T: 'static> ApplicationHandle<T> {
    protocol_client_methods!();
}

impl<'a, T: 'static> AppContext<'a, T> {
    protocol_client_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    protocol_client_methods!();
}

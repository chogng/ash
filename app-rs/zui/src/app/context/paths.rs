use std::ffi::OsString;
use std::path::PathBuf;

use crate::app::ApplicationPath;
use crate::app::ApplicationPathError;

use super::AppContext;
use super::WindowContext;

macro_rules! application_path_methods {
    () => {
        /// Returns the product name used to derive application-owned directories.
        pub fn application_name(&self) -> OsString {
            self.event_proxy.application_name()
        }

        /// Overrides ZUI's internal product name without changing operating-system metadata.
        ///
        /// Paths already derived during startup are not moved or renamed.
        pub fn set_application_name(
            &self,
            name: impl Into<OsString>,
        ) -> Result<(), ApplicationPathError> {
            self.event_proxy.set_application_name(name)
        }

        /// Returns the validated semantic application version.
        pub fn application_version(&self) -> String {
            self.event_proxy.application_version()
        }

        /// Returns the current application directory.
        pub fn application_path(&self) -> PathBuf {
            self.event_proxy.application_path()
        }

        /// Resolves one standard application file or directory.
        ///
        /// Querying [`ApplicationPath::Logs`] creates its default directory on first use.
        pub fn path(&self, name: ApplicationPath) -> Result<PathBuf, ApplicationPathError> {
            self.event_proxy.path(name)
        }

        /// Overrides one standard path with an existing absolute file or directory.
        pub fn set_path(
            &self,
            name: ApplicationPath,
            path: impl Into<PathBuf>,
        ) -> Result<(), ApplicationPathError> {
            self.event_proxy.set_path(name, path)
        }

        /// Sets and recursively creates an absolute application log directory.
        pub fn set_app_logs_path(
            &self,
            path: impl Into<PathBuf>,
        ) -> Result<(), ApplicationPathError> {
            self.event_proxy.set_app_logs_path(path)
        }

        /// Restores, creates, and returns the platform-default application log directory.
        pub fn set_default_app_logs_path(&self) -> Result<PathBuf, ApplicationPathError> {
            self.event_proxy.set_default_app_logs_path()
        }
    };
}

impl<'a, T: 'static> AppContext<'a, T> {
    application_path_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    application_path_methods!();
}

use std::ffi::OsString;
use std::path::PathBuf;

use crate::app::AppProxy;
use crate::app::ApplicationBuilder;
use crate::app::ApplicationHandle;

use super::ApplicationPath;
use super::ApplicationPathError;

macro_rules! public_path_methods {
    ($($field:ident).+) => {
        /// Returns the product name used to derive application-owned directories.
        pub fn application_name(&self) -> OsString {
            self.$($field).+.application_name()
        }

        /// Overrides ZUI's internal product name without changing operating-system metadata.
        ///
        /// Paths already derived during startup are not moved or renamed.
        pub fn set_application_name(
            &self,
            name: impl Into<OsString>,
        ) -> Result<(), ApplicationPathError> {
            self.$($field).+.set_application_name(name.into())
        }

        /// Returns the validated semantic application version.
        pub fn application_version(&self) -> String {
            self.$($field).+.application_version()
        }

        /// Returns the current application directory.
        pub fn application_path(&self) -> PathBuf {
            self.$($field).+.application_path()
        }

        /// Resolves one standard application file or directory.
        ///
        /// Querying [`ApplicationPath::Logs`] creates its default directory on first use.
        pub fn path(&self, name: ApplicationPath) -> Result<PathBuf, ApplicationPathError> {
            self.$($field).+.path(name)
        }

        /// Overrides one standard path with an existing absolute file or directory.
        pub fn set_path(
            &self,
            name: ApplicationPath,
            path: impl Into<PathBuf>,
        ) -> Result<(), ApplicationPathError> {
            self.$($field).+.set_path(name, path.into())
        }

        /// Sets and recursively creates an absolute application log directory.
        pub fn set_app_logs_path(
            &self,
            path: impl Into<PathBuf>,
        ) -> Result<(), ApplicationPathError> {
            self.$($field).+.set_app_logs_path(path.into())
        }

        /// Restores, creates, and returns the platform-default application log directory.
        pub fn set_default_app_logs_path(&self) -> Result<PathBuf, ApplicationPathError> {
            self.$($field).+.set_default_app_logs_path()
        }
    };
}

impl ApplicationBuilder {
    /// Overrides the product name used to derive application-owned data and log directories.
    pub fn with_application_name(mut self, name: impl Into<OsString>) -> Self {
        self.application_paths.set_name(name.into());
        self
    }

    /// Overrides the semantic product version returned to application code.
    pub fn with_application_version(mut self, version: impl Into<String>) -> Self {
        self.application_paths.set_version(version.into());
        self
    }

    /// Overrides the current application directory returned to product code.
    pub fn with_application_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.application_paths.set_application_path(path.into());
        self
    }

    /// Overrides one standard path before product state is constructed.
    pub fn with_application_path_override(
        mut self,
        name: ApplicationPath,
        path: impl Into<PathBuf>,
    ) -> Self {
        self.application_paths.set_override(name, path.into());
        self
    }
}

impl<T: 'static> AppProxy<T> {
    public_path_methods!(application_paths);
}

impl<T: 'static> ApplicationHandle<T> {
    public_path_methods!(event_proxy.application_paths);
}

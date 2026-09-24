use std::path::PathBuf;

use crate::app::ApplicationHandle;
use crate::services::FileIconFuture;
use crate::services::FileIconRequest;

use super::AppContext;
use super::WindowContext;

macro_rules! file_icon_methods {
    () => {
        /// Loads a normal-size operating-system icon for one file path or extension.
        pub fn get_file_icon(&self, path: impl Into<PathBuf>) -> FileIconFuture {
            self.services.file_icons().get(path)
        }

        /// Loads an explicitly sized operating-system icon without blocking the event loop.
        pub fn get_file_icon_with(&self, request: FileIconRequest) -> FileIconFuture {
            self.services.file_icons().get_with(request)
        }
    };
}

impl<T: 'static> ApplicationHandle<T> {
    file_icon_methods!();
}

impl<'a, T: 'static> AppContext<'a, T> {
    file_icon_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    file_icon_methods!();
}

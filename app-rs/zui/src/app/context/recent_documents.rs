use std::path::PathBuf;

use crate::services::SystemServiceError;

use super::AppContext;
use super::WindowContext;

macro_rules! recent_document_methods {
    () => {
        /// Adds one absolute path to the operating-system recent-document list.
        pub fn add_recent_document(
            &self,
            path: impl Into<PathBuf>,
        ) -> Result<(), SystemServiceError> {
            self.services.recent_documents().add(path)
        }

        /// Clears recent-document usage managed by the operating system.
        pub fn clear_recent_documents(&self) -> Result<(), SystemServiceError> {
            self.services.recent_documents().clear()
        }

        /// Returns recent document targets in operating-system order when resolvable.
        pub fn recent_documents(&self) -> Result<Vec<PathBuf>, SystemServiceError> {
            self.services.recent_documents().list()
        }
    };
}

impl<'a, T: 'static> AppContext<'a, T> {
    recent_document_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    recent_document_methods!();
}

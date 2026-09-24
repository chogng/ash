use std::fmt;

use crate::window::WindowHandle;
use crate::window::WindowId;

use super::SystemServiceError;

#[derive(Clone)]
pub(super) struct DialogParent {
    window: WindowHandle,
}

impl DialogParent {
    pub(super) const fn new(window: WindowHandle) -> Self {
        Self { window }
    }

    pub(super) const fn id(&self) -> WindowId {
        self.window.id()
    }

    pub(super) fn bind_file_dialog(
        &self,
        dialog: rfd::AsyncFileDialog,
    ) -> Result<rfd::AsyncFileDialog, SystemServiceError> {
        let window = self
            .window
            .live_window("file dialog parent attachment")
            .map_err(|error| SystemServiceError::backend("file dialog", error))?;
        Ok(dialog.set_parent(window.as_ref()))
    }

    pub(super) fn bind_message_dialog(
        &self,
        dialog: rfd::AsyncMessageDialog,
    ) -> Result<rfd::AsyncMessageDialog, SystemServiceError> {
        let window = self
            .window
            .live_window("message dialog parent attachment")
            .map_err(|error| SystemServiceError::backend("message dialog", error))?;
        Ok(dialog.set_parent(window.as_ref()))
    }
}

impl fmt::Debug for DialogParent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DialogParent")
            .field("window", &self.id())
            .finish_non_exhaustive()
    }
}

impl PartialEq for DialogParent {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}

impl Eq for DialogParent {}

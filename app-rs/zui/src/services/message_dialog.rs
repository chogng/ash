use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::window::WindowHandle;
use crate::window::WindowId;

use super::SystemServiceError;
use super::dialog_parent::DialogParent;

/// Owned asynchronous result returned by an injectable message-dialog backend.
pub type MessageDialogFuture = Pin<
    Box<dyn Future<Output = Result<MessageDialogResponse, SystemServiceError>> + Send + 'static>,
>;

/// Severity communicated by a native message dialog.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MessageDialogLevel {
    #[default]
    Information,
    Warning,
    Error,
}

/// Native or custom button arrangement shown by a message dialog.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum MessageDialogButtons {
    #[default]
    Ok,
    OkCancel,
    YesNo,
    YesNoCancel,
    CustomOne(String),
    CustomTwo(String, String),
    CustomThree(String, String, String),
}

impl MessageDialogButtons {
    fn validate(&self) -> Result<(), SystemServiceError> {
        let labels = match self {
            Self::Ok | Self::OkCancel | Self::YesNo | Self::YesNoCancel => return Ok(()),
            Self::CustomOne(first) => vec![first],
            Self::CustomTwo(first, second) => vec![first, second],
            Self::CustomThree(first, second, third) => vec![first, second, third],
        };
        if labels.iter().any(|label| label.trim().is_empty()) {
            return Err(SystemServiceError::invalid_input(
                "message dialog",
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "custom button labels must not be empty",
                ),
            ));
        }
        if labels.iter().enumerate().any(|(index, label)| {
            labels[index + 1..]
                .iter()
                .any(|candidate| candidate.trim() == label.trim())
        }) {
            return Err(SystemServiceError::invalid_input(
                "message dialog",
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "custom button labels must be unique",
                ),
            ));
        }
        Ok(())
    }
}

/// Button selected while dismissing a native message dialog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MessageDialogResponse {
    Ok,
    Cancel,
    Yes,
    No,
    Custom(String),
}

/// Backend-independent content and controls for one native message dialog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageDialogRequest {
    title: String,
    message: String,
    level: MessageDialogLevel,
    buttons: MessageDialogButtons,
    parent: Option<DialogParent>,
}

impl MessageDialogRequest {
    /// Creates an informational dialog with one OK button.
    pub fn new(title: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            message: message.into(),
            level: MessageDialogLevel::Information,
            buttons: MessageDialogButtons::Ok,
            parent: None,
        }
    }

    /// Selects the native severity treatment.
    pub const fn with_level(mut self, level: MessageDialogLevel) -> Self {
        self.level = level;
        self
    }

    /// Selects the native or custom button arrangement.
    pub fn with_buttons(mut self, buttons: MessageDialogButtons) -> Self {
        self.buttons = buttons;
        self
    }

    /// Attaches the dialog to one non-owning runtime window capability.
    ///
    /// The default backend presents a modal window or sheet where supported. Closing `parent`
    /// before presentation produces an explicit backend error.
    pub fn with_parent(mut self, parent: WindowHandle) -> Self {
        self.parent = Some(DialogParent::new(parent));
        self
    }

    /// Returns the native dialog title.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Returns the primary dialog message.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns the requested native severity treatment.
    pub const fn level(&self) -> MessageDialogLevel {
        self.level
    }

    /// Returns the requested button arrangement.
    pub const fn buttons(&self) -> &MessageDialogButtons {
        &self.buttons
    }

    /// Returns the stable parent-window identity supplied for modal presentation.
    pub fn parent_window(&self) -> Option<WindowId> {
        self.parent.as_ref().map(DialogParent::id)
    }

    fn validate(&self) -> Result<(), SystemServiceError> {
        if self.title.trim().is_empty() && self.message.trim().is_empty() {
            return Err(SystemServiceError::invalid_input(
                "message dialog",
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "title and message cannot both be empty",
                ),
            ));
        }
        self.buttons.validate()
    }
}

/// Native message-dialog backend used through an injectable [`MessageDialogHandle`].
pub trait MessageDialogService: Send + Sync {
    /// Shows one native message dialog and resolves with the selected button.
    fn show(&self, request: MessageDialogRequest) -> MessageDialogFuture;
}

/// Cloneable capability for showing asynchronous native message dialogs.
#[derive(Clone)]
pub struct MessageDialogHandle {
    service: Arc<dyn MessageDialogService>,
}

impl MessageDialogHandle {
    pub(crate) fn new(service: impl MessageDialogService + 'static) -> Self {
        Self {
            service: Arc::new(service),
        }
    }

    /// Validates and shows one native message dialog.
    pub fn show(&self, request: MessageDialogRequest) -> MessageDialogFuture {
        if let Err(error) = request.validate() {
            return Box::pin(async move { Err(error) });
        }
        self.service.show(request)
    }
}

/// Default asynchronous native message-dialog backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemMessageDialogs;

impl MessageDialogService for SystemMessageDialogs {
    fn show(&self, request: MessageDialogRequest) -> MessageDialogFuture {
        Box::pin(async move {
            let mut dialog = rfd::AsyncMessageDialog::new()
                .set_title(request.title)
                .set_description(request.message)
                .set_level(native_level(request.level))
                .set_buttons(native_buttons(request.buttons));
            if let Some(parent) = request.parent {
                dialog = parent.bind_message_dialog(dialog)?;
            }
            let result = dialog.show().await;
            Ok(match result {
                rfd::MessageDialogResult::Ok => MessageDialogResponse::Ok,
                rfd::MessageDialogResult::Cancel => MessageDialogResponse::Cancel,
                rfd::MessageDialogResult::Yes => MessageDialogResponse::Yes,
                rfd::MessageDialogResult::No => MessageDialogResponse::No,
                rfd::MessageDialogResult::Custom(label) => MessageDialogResponse::Custom(label),
            })
        })
    }
}

const fn native_level(level: MessageDialogLevel) -> rfd::MessageLevel {
    match level {
        MessageDialogLevel::Information => rfd::MessageLevel::Info,
        MessageDialogLevel::Warning => rfd::MessageLevel::Warning,
        MessageDialogLevel::Error => rfd::MessageLevel::Error,
    }
}

fn native_buttons(buttons: MessageDialogButtons) -> rfd::MessageButtons {
    match buttons {
        MessageDialogButtons::Ok => rfd::MessageButtons::Ok,
        MessageDialogButtons::OkCancel => rfd::MessageButtons::OkCancel,
        MessageDialogButtons::YesNo => rfd::MessageButtons::YesNo,
        MessageDialogButtons::YesNoCancel => rfd::MessageButtons::YesNoCancel,
        MessageDialogButtons::CustomOne(first) => rfd::MessageButtons::OkCustom(first),
        MessageDialogButtons::CustomTwo(first, second) => {
            rfd::MessageButtons::OkCancelCustom(first, second)
        }
        MessageDialogButtons::CustomThree(first, second, third) => {
            rfd::MessageButtons::YesNoCancelCustom(first, second, third)
        }
    }
}

#[cfg(test)]
#[path = "message_dialog_tests.rs"]
mod tests;

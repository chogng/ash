use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use futures::executor::block_on;

use crate::devtools::DevToolsHandle;
use crate::services::SystemServiceErrorCode;
use crate::window::WindowChrome;
use crate::window::WindowCloseRequester;
use crate::window::WindowHandle;
use crate::window::WindowId;

use super::MessageDialogButtons;
use super::MessageDialogFuture;
use super::MessageDialogHandle;
use super::MessageDialogLevel;
use super::MessageDialogRequest;
use super::MessageDialogResponse;
use super::MessageDialogService;
use super::SystemMessageDialogs;

fn closed_window(id: WindowId) -> WindowHandle {
    WindowHandle::new(
        id,
        Weak::new(),
        WindowChrome::Native,
        DevToolsHandle::new(),
        WindowCloseRequester::new(|_, _| false),
        None,
        false,
    )
}

#[derive(Clone)]
struct RecordingDialogs {
    requests: Arc<Mutex<Vec<MessageDialogRequest>>>,
    response: MessageDialogResponse,
}

impl MessageDialogService for RecordingDialogs {
    fn show(&self, request: MessageDialogRequest) -> MessageDialogFuture {
        self.requests.lock().unwrap().push(request);
        let response = self.response.clone();
        Box::pin(async move { Ok(response) })
    }
}

#[test]
fn injected_message_dialog_receives_validated_request() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let handle = MessageDialogHandle::new(RecordingDialogs {
        requests: Arc::clone(&requests),
        response: MessageDialogResponse::Custom("Retry".to_owned()),
    });
    let request = MessageDialogRequest::new("Connection failed", "Try again?")
        .with_level(MessageDialogLevel::Warning)
        .with_buttons(MessageDialogButtons::CustomTwo(
            "Retry".to_owned(),
            "Cancel".to_owned(),
        ))
        .with_parent(closed_window(WindowId::from_raw(12)));

    assert_eq!(
        block_on(handle.show(request.clone())).unwrap(),
        MessageDialogResponse::Custom("Retry".to_owned())
    );
    assert_eq!(*requests.lock().unwrap(), [request]);
    assert_eq!(
        requests.lock().unwrap()[0].parent_window(),
        Some(WindowId::from_raw(12))
    );
}

#[test]
fn system_message_dialog_rejects_a_closed_parent_before_native_presentation() {
    let request = MessageDialogRequest::new("Title", "Message")
        .with_parent(closed_window(WindowId::from_raw(23)));

    let error = block_on(SystemMessageDialogs.show(request)).unwrap_err();

    assert_eq!(error.code(), SystemServiceErrorCode::Backend);
    assert!(std::error::Error::source(&error).is_some());
}

#[test]
fn invalid_message_dialog_is_rejected_before_backend_dispatch() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let handle = MessageDialogHandle::new(RecordingDialogs {
        requests: Arc::clone(&requests),
        response: MessageDialogResponse::Ok,
    });
    let request = MessageDialogRequest::new("Warning", "Choose an action").with_buttons(
        MessageDialogButtons::CustomTwo("Retry".to_owned(), " ".to_owned()),
    );

    let error = block_on(handle.show(request)).unwrap_err();

    assert!(error.is_invalid_input());
    assert!(requests.lock().unwrap().is_empty());

    let duplicate = MessageDialogRequest::new("Warning", "Choose an action").with_buttons(
        MessageDialogButtons::CustomTwo("Retry".to_owned(), "Retry".to_owned()),
    );
    assert!(
        block_on(handle.show(duplicate))
            .unwrap_err()
            .is_invalid_input()
    );
    assert!(requests.lock().unwrap().is_empty());
}

#[test]
fn message_dialog_futures_can_cross_threads() {
    fn require_send<T: Send>() {}

    require_send::<MessageDialogFuture>();
}

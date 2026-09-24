use std::sync::Weak;

use crate::devtools::DevToolsHandle;

use super::LogicalPosition;
use super::LogicalSize;
use super::WindowChrome;
use super::WindowCloseMode;
use super::WindowCloseRequester;
use super::WindowHandle;
use super::WindowId;
use crate::window::WindowOperationError;

fn closed_handle(id: WindowId) -> WindowHandle {
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

#[test]
fn close_requesters_report_delivery_without_owning_window_lifecycle() {
    let requested = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = requested.clone();
    let requester = WindowCloseRequester::new(move |window, mode| {
        recorded.lock().unwrap().push((window, mode));
        true
    });
    let window = WindowId::from_raw(9);

    assert!(requester.request(window));
    assert!(requester.destroy(window));
    assert_eq!(
        *requested.lock().unwrap(),
        vec![
            (window, WindowCloseMode::Request),
            (window, WindowCloseMode::Destroy)
        ]
    );
}

#[test]
fn closed_handles_keep_their_identity_and_report_failed_operations() {
    let id = WindowId::from_raw(42);
    let handle = closed_handle(id);

    assert_eq!(handle.id(), id);
    assert!(!handle.is_open());
    assert!(matches!(
        handle.request_redraw(),
        Err(WindowOperationError::Closed { window, .. }) if window == id
    ));
    assert!(handle.state().unwrap_err().is_closed());
}

#[test]
fn invalid_live_operation_input_is_distinct_from_a_closed_window() {
    let id = WindowId::from_raw(7);
    let handle = closed_handle(id);

    assert!(matches!(
        handle.request_inner_logical_size(LogicalSize::new(f64::NAN, 10.0)),
        Err(WindowOperationError::InvalidSize { window, .. }) if window == id
    ));
    assert!(matches!(
        handle.set_outer_logical_position(LogicalPosition::new(f64::INFINITY, 10.0)),
        Err(WindowOperationError::InvalidPosition { window, .. }) if window == id
    ));
    assert!(matches!(
        handle.set_resize_increments(Some(LogicalSize::new(0.0, 10.0))),
        Err(WindowOperationError::InvalidSize { window, .. }) if window == id
    ));
}

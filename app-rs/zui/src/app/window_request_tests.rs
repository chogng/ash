use futures::executor::block_on;

use super::OpenWindowErrorCode;
use super::OpenWindowRequest;
use crate::window::WindowOptions;

#[test]
fn dropped_main_thread_request_reports_disconnection() {
    let (request, future) = OpenWindowRequest::new(WindowOptions::new("detached"));

    drop(request);

    let error = match block_on(future) {
        Ok(_) => panic!("dropped request must not open a window"),
        Err(error) => error,
    };
    assert_eq!(error.code(), OpenWindowErrorCode::Disconnected);
    assert!(error.creation_error().is_none());
}

#[test]
fn main_thread_creation_failure_retains_the_application_error() {
    let (request, future) = OpenWindowRequest::new(WindowOptions::new("failure"));
    let (_, response) = request.into_parts();
    assert!(
        response
            .send(Err(crate::app::ApplicationError::host(
                "test window creation",
                std::io::Error::other("renderer unavailable"),
            )))
            .is_ok()
    );

    let error = match block_on(future) {
        Ok(_) => panic!("failed request must not open a window"),
        Err(error) => error,
    };
    assert_eq!(error.code(), OpenWindowErrorCode::Creation);
    assert_eq!(
        error.creation_error().map(|error| error.operation()),
        Some("test window creation")
    );
}

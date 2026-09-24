use std::error::Error;

use crate::app::ApplicationPath;
use crate::app::ApplicationPathError;

use super::ApplicationRunError;
use super::ApplicationRunErrorCode;

#[test]
fn background_executor_failures_have_a_stable_public_category() {
    let error = ApplicationRunError::background_executor(std::io::Error::other("unavailable"));

    assert_eq!(error.code(), ApplicationRunErrorCode::BackgroundExecutor);
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("unavailable")
    );
    assert!(error.to_string().contains("background executor"));
}

#[test]
fn single_instance_failures_have_a_stable_public_category() {
    let error = ApplicationRunError::single_instance(std::io::Error::other("unavailable"));

    assert_eq!(error.code(), ApplicationRunErrorCode::SingleInstance);
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("unavailable")
    );
    assert!(error.to_string().contains("single-instance"));
}

#[test]
fn relaunch_failures_have_a_stable_public_category() {
    let error = ApplicationRunError::relaunch(std::io::Error::other("unavailable"));

    assert_eq!(error.code(), ApplicationRunErrorCode::Relaunch);
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("unavailable")
    );
    assert!(error.to_string().contains("relaunch"));
}

#[test]
fn application_path_failures_have_a_stable_public_category() {
    let source = ApplicationPathError::unavailable(ApplicationPath::Home);
    let error = ApplicationRunError::paths(source);

    assert_eq!(error.code(), ApplicationRunErrorCode::ApplicationPaths);
    assert!(error.source().is_some());
    assert!(error.to_string().contains("path initialization"));
}

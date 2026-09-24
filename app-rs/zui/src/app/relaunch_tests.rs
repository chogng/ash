use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use super::ApplicationRelauncher;
use super::RelaunchErrorCode;
use super::RelaunchOptions;

fn require_send_sync<T: Send + Sync>() {}

#[test]
fn public_relaunch_values_cross_thread_boundaries() {
    require_send_sync::<RelaunchOptions>();
    require_send_sync::<ApplicationRelauncher>();
}

#[test]
fn options_distinguish_defaults_from_explicit_empty_arguments() {
    let defaults = RelaunchOptions::new();
    assert_eq!(defaults.executable(), None);
    assert_eq!(defaults.arguments(), None);

    let explicit = RelaunchOptions::new()
        .with_executable("custom-zui")
        .with_arguments(Vec::<OsString>::new());
    assert_eq!(explicit.executable(), Some(Path::new("custom-zui")));
    assert_eq!(explicit.arguments(), Some([].as_slice()));
}

#[test]
fn default_request_captures_current_process_contract() {
    let relauncher = ApplicationRelauncher::default();
    relauncher.schedule(RelaunchOptions::new()).unwrap();
    let mut captured = None;

    relauncher
        .launch_all_with(|request| {
            captured = Some(request.clone());
            Ok(())
        })
        .unwrap();

    let captured = captured.unwrap();
    assert_eq!(captured.executable, std::env::current_exe().unwrap());
    assert_eq!(
        captured.arguments,
        std::env::args_os().skip(1).collect::<Vec<_>>()
    );
    assert_eq!(captured.working_directory, std::env::current_dir().unwrap());
}

#[test]
fn every_scheduled_request_is_attempted_in_order_before_queue_closes() {
    let relauncher = ApplicationRelauncher::default();
    for executable in ["first", "second", "third"] {
        relauncher
            .schedule(RelaunchOptions::new().with_executable(executable))
            .unwrap();
    }
    let mut attempted = Vec::new();

    let error = relauncher
        .launch_all_with(|request| {
            attempted.push(request.executable.clone());
            if request.executable == Path::new("first") {
                Err(io::Error::other("first failed"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();

    assert_eq!(
        attempted,
        ["first", "second", "third"]
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    );
    assert_eq!(error.to_string(), "first failed");
    let closed = relauncher.schedule(RelaunchOptions::new()).unwrap_err();
    assert_eq!(closed.code(), RelaunchErrorCode::ApplicationExited);
    assert!(closed.source().is_none());
}

#[test]
fn an_empty_executable_is_rejected_when_scheduled() {
    let error = ApplicationRelauncher::default()
        .schedule(RelaunchOptions::new().with_executable(""))
        .unwrap_err();

    assert_eq!(error.code(), RelaunchErrorCode::InvalidExecutable);
    assert!(error.to_string().contains("cannot be empty"));
}

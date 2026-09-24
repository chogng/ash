use std::cell::RefCell;
use std::ffi::OsString;
use std::path::PathBuf;
use std::rc::Rc;

use crate::app::ProtocolScheme;
use crate::services::SystemServiceErrorCode;

use super::DesktopFileName;
use super::ProtocolClientHandle;
use super::ProtocolClientOptions;
use super::ProtocolClientRemoval;
use super::ProtocolClientRequest;
use super::ProtocolClientService;
use super::SystemServiceError;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Operation {
    Set(ProtocolClientRequest),
    Is(ProtocolClientRequest),
    Remove(ProtocolClientRequest),
}

struct RecordingProtocolClients {
    operations: Rc<RefCell<Vec<Operation>>>,
    is_default: bool,
    removal: ProtocolClientRemoval,
}

impl ProtocolClientService for RecordingProtocolClients {
    fn set_default(&mut self, request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
        self.operations
            .borrow_mut()
            .push(Operation::Set(request.clone()));
        Ok(())
    }

    fn is_default(&mut self, request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
        self.operations
            .borrow_mut()
            .push(Operation::Is(request.clone()));
        Ok(self.is_default)
    }

    fn remove_default(
        &mut self,
        request: &ProtocolClientRequest,
    ) -> Result<ProtocolClientRemoval, SystemServiceError> {
        self.operations
            .borrow_mut()
            .push(Operation::Remove(request.clone()));
        Ok(self.removal)
    }
}

struct RequiredOperationsOnly;

impl ProtocolClientService for RequiredOperationsOnly {
    fn set_default(&mut self, _request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
        Ok(())
    }

    fn is_default(&mut self, _request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
        Ok(false)
    }
}

fn recording_handle(
    is_default: bool,
    removal: ProtocolClientRemoval,
) -> (ProtocolClientHandle, Rc<RefCell<Vec<Operation>>>) {
    let operations = Rc::new(RefCell::new(Vec::new()));
    let handle = ProtocolClientHandle::new(RecordingProtocolClients {
        operations: operations.clone(),
        is_default,
        removal,
    });
    (handle, operations)
}

fn absolute_executable() -> PathBuf {
    std::env::current_exe()
        .expect("the test executable should have a path")
        .with_file_name("custom protocol executable")
}

#[test]
fn desktop_file_names_are_canonical_reverse_dns_identities() {
    let name = DesktopFileName::new("dev.ash.App").unwrap();
    assert_eq!(name.as_str(), "dev.ash.App.desktop");
    assert_eq!(name.application_id(), "dev.ash.App");
    assert_eq!(DesktopFileName::new("dev.ash.App.desktop").unwrap(), name);

    for invalid in ["app", ".desktop", "dev..app", "dev.ash_app"] {
        assert!(DesktopFileName::new(invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn explicit_registration_options_reach_the_injected_backend_exactly() {
    let (handle, operations) = recording_handle(true, ProtocolClientRemoval::Removed);
    let scheme = ProtocolScheme::new("ash+agent").unwrap();
    let executable = absolute_executable();
    let desktop_file = DesktopFileName::new("dev.ash.App").unwrap();
    let arguments = [OsString::from("--profile"), OsString::from("A B")];
    let options = ProtocolClientOptions::new()
        .with_executable(&executable)
        .with_arguments(arguments.clone())
        .with_desktop_file_name(desktop_file.clone());

    handle
        .set_default_with(scheme.clone(), options.clone())
        .unwrap();
    assert!(
        handle
            .is_default_with(scheme.clone(), options.clone())
            .unwrap()
    );
    assert_eq!(
        handle.remove_default_with(scheme.clone(), options).unwrap(),
        ProtocolClientRemoval::Removed
    );

    let recorded = operations.borrow();
    assert_eq!(recorded.len(), 3);
    for operation in recorded.iter() {
        let request = match operation {
            Operation::Set(request) | Operation::Is(request) | Operation::Remove(request) => {
                request
            }
        };
        assert_eq!(request.scheme(), &scheme);
        assert_eq!(request.executable(), executable);
        assert_eq!(request.arguments(), arguments);
        assert_eq!(request.desktop_file_name(), Some(&desktop_file));
    }
}

#[test]
fn configured_desktop_identity_is_the_default_for_protocol_requests() {
    let (handle, operations) = recording_handle(false, ProtocolClientRemoval::NotCurrent);
    let desktop_file = DesktopFileName::new("dev.ash.Configured").unwrap();
    handle.set_desktop_file_name(Some(desktop_file.clone()));
    handle
        .is_default_with(
            ProtocolScheme::new("ash").unwrap(),
            ProtocolClientOptions::new().with_executable(absolute_executable()),
        )
        .unwrap();

    let recorded = operations.borrow();
    let Operation::Is(request) = &recorded[0] else {
        panic!("configured request should query the injected backend");
    };
    assert_eq!(request.desktop_file_name(), Some(&desktop_file));
}

#[test]
fn invalid_commands_are_rejected_before_the_backend() {
    let (handle, operations) = recording_handle(false, ProtocolClientRemoval::NotCurrent);
    let scheme = ProtocolScheme::new("ash").unwrap();
    let error = handle
        .set_default_with(
            scheme.clone(),
            ProtocolClientOptions::new().with_executable("relative/path"),
        )
        .unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::InvalidInput);

    let error = handle
        .set_default_with(
            scheme,
            ProtocolClientOptions::new()
                .with_executable(absolute_executable())
                .with_argument(OsString::from("contains\0nul")),
        )
        .unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::InvalidInput);
    assert!(operations.borrow().is_empty());
}

#[test]
fn removal_is_explicitly_unsupported_when_a_backend_omits_it() {
    let handle = ProtocolClientHandle::new(RequiredOperationsOnly);
    let error = handle
        .remove_default_with(
            ProtocolScheme::new("ash").unwrap(),
            ProtocolClientOptions::new().with_executable(absolute_executable()),
        )
        .unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::Unsupported);
}

use std::cell::RefCell;
use std::ffi::OsString;
use std::path::PathBuf;
use std::rc::Rc;

use crate::services::SystemServiceErrorCode;

use super::LoginItemHandle;
use super::LoginItemName;
use super::LoginItemOptions;
use super::LoginItemRegistration;
use super::LoginItemRequest;
use super::LoginItemService;
use super::LoginItemServiceKind;
use super::LoginItemSettings;
use super::LoginItemStartupState;
use super::LoginItemState;
use super::LoginItemStatus;
use super::LoginItemUpdate;
use super::SystemServiceError;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Operation {
    Set(LoginItemUpdate),
    Get(LoginItemRequest),
}

struct RecordingLoginItems {
    operations: Rc<RefCell<Vec<Operation>>>,
    state: LoginItemState,
}

impl LoginItemService for RecordingLoginItems {
    fn set(&mut self, update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
        self.operations
            .borrow_mut()
            .push(Operation::Set(update.clone()));
        Ok(())
    }

    fn get(&mut self, request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
        self.operations
            .borrow_mut()
            .push(Operation::Get(request.clone()));
        Ok(self.state)
    }
}

fn recording_handle(state: LoginItemState) -> (LoginItemHandle, Rc<RefCell<Vec<Operation>>>) {
    let operations = Rc::new(RefCell::new(Vec::new()));
    let handle = LoginItemHandle::new(RecordingLoginItems {
        operations: operations.clone(),
        state,
    });
    (handle, operations)
}

fn absolute_executable() -> PathBuf {
    std::env::current_exe()
        .expect("the test executable should have a path")
        .with_file_name("custom login executable")
}

#[test]
fn login_item_names_reject_empty_and_nul_identities() {
    assert_eq!(
        LoginItemName::new("Ash Agent").unwrap().as_str(),
        "Ash Agent"
    );
    assert!(LoginItemName::new(" ").is_err());
    assert!(LoginItemName::new("bad\0name").is_err());
}

#[test]
fn explicit_login_item_settings_reach_the_injected_backend_exactly() {
    let state = LoginItemState::new(LoginItemStatus::RequiresApproval);
    let (handle, operations) = recording_handle(state);
    let executable = absolute_executable();
    let name = LoginItemName::new("Ash Login").unwrap();
    let service =
        LoginItemServiceKind::MacOsAgent(LoginItemName::new("dev.ash.agent.plist").unwrap());
    let arguments = [OsString::from("--profile"), OsString::from("A B")];
    let options = LoginItemOptions::new()
        .with_service_kind(service.clone())
        .with_executable(&executable)
        .with_arguments(arguments.clone())
        .with_name(name.clone());

    handle
        .set(
            LoginItemSettings::enable(options.clone())
                .with_startup_state(LoginItemStartupState::Disabled),
        )
        .unwrap();
    assert_eq!(handle.get(options).unwrap(), state);

    let recorded = operations.borrow();
    let Operation::Set(update) = &recorded[0] else {
        panic!("first operation should update the login item");
    };
    assert_eq!(update.registration(), LoginItemRegistration::Enable);
    assert_eq!(update.startup_state(), LoginItemStartupState::Disabled);
    assert_eq!(update.request().service_kind(), &service);
    assert_eq!(update.request().executable(), executable);
    assert_eq!(update.request().arguments(), arguments);
    assert_eq!(update.request().name(), &name);
    let Operation::Get(request) = &recorded[1] else {
        panic!("second operation should query the login item");
    };
    assert_eq!(request, update.request());
}

#[test]
fn invalid_login_item_commands_are_rejected_before_the_backend() {
    let (handle, operations) =
        recording_handle(LoginItemState::new(LoginItemStatus::NotRegistered));
    let error = handle
        .get(LoginItemOptions::new().with_executable("relative/path"))
        .unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::InvalidInput);

    let error = handle
        .set(LoginItemSettings::disable(
            LoginItemOptions::new()
                .with_executable(absolute_executable())
                .with_argument(OsString::from("contains\0nul")),
        ))
        .unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::InvalidInput);
    assert!(operations.borrow().is_empty());
}

#[test]
fn login_item_state_keeps_registration_and_launch_eligibility_distinct() {
    let enabled = LoginItemState::new(LoginItemStatus::Enabled);
    assert!(enabled.is_registered());
    assert!(enabled.open_at_login());
    assert!(enabled.will_launch_at_login());

    let disabled = LoginItemState::new(LoginItemStatus::Disabled);
    assert!(disabled.is_registered());
    assert!(disabled.open_at_login());
    assert!(!disabled.will_launch_at_login());

    let approval = LoginItemState::new(LoginItemStatus::RequiresApproval);
    assert!(approval.is_registered());
    assert!(!approval.open_at_login());
    assert!(!approval.will_launch_at_login());

    let missing = LoginItemState::new(LoginItemStatus::NotRegistered);
    assert!(!missing.is_registered());
    assert!(!missing.open_at_login());
}

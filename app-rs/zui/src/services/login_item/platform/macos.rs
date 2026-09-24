#![allow(unsafe_code)]

use objc2::msg_send;
use objc2::msg_send_id;
use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::runtime::AnyObject;
use objc2_foundation::MainThreadMarker;
use objc2_foundation::NSError;
use objc2_foundation::NSString;
use std::ffi::CStr;
use std::ffi::c_char;
use std::ffi::c_int;
use std::ffi::c_void;
use std::sync::OnceLock;

use super::super::LoginItemRegistration;
use super::super::LoginItemServiceKind;
use super::super::LoginItemStatus;
use super::LOGIN_ITEM;
use super::LoginItemRequest;
use super::LoginItemState;
use super::LoginItemUpdate;
use crate::services::SystemServiceError;

unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlerror() -> *const c_char;
}

fn load_service_management() -> Result<(), SystemServiceError> {
    static LOAD: OnceLock<Result<(), String>> = OnceLock::new();
    let result = LOAD.get_or_init(|| {
        let path = c"/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement";
        // SAFETY: `path` is a permanent NUL-terminated C string. The framework remains loaded for
        // process lifetime so Objective-C class pointers obtained from it cannot be invalidated.
        let handle = unsafe { dlopen(path.as_ptr(), 1) };
        if !handle.is_null() {
            return Ok(());
        }
        // SAFETY: `dlerror` returns either null or a process-owned NUL-terminated diagnostic.
        let error = unsafe { dlerror() };
        let message = if error.is_null() {
            "ServiceManagement framework could not be loaded".to_owned()
        } else {
            // SAFETY: The non-null diagnostic follows the `dlerror` C string contract.
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        };
        Err(message)
    });
    result
        .clone()
        .map_err(|message| SystemServiceError::backend(LOGIN_ITEM, std::io::Error::other(message)))
}

fn service(request: &LoginItemRequest) -> Result<Retained<AnyObject>, SystemServiceError> {
    MainThreadMarker::new().ok_or_else(|| {
        SystemServiceError::backend(
            LOGIN_ITEM,
            std::io::Error::other("login items must be accessed on the macOS main thread"),
        )
    })?;
    load_service_management()?;
    let class =
        AnyClass::get("SMAppService").ok_or_else(|| SystemServiceError::unsupported(LOGIN_ITEM))?;
    // SAFETY: ServiceManagement owns the declared Objective-C class and selectors. The class
    // methods return SMAppService objects retained by `msg_send_id!`.
    let service = unsafe {
        match request.service_kind() {
            LoginItemServiceKind::MainApplication => msg_send_id![class, mainAppService],
            LoginItemServiceKind::MacOsAgent(name) => {
                let name = NSString::from_str(name.as_str());
                msg_send_id![class, agentServiceWithPlistName: &*name]
            }
            LoginItemServiceKind::MacOsDaemon(name) => {
                let name = NSString::from_str(name.as_str());
                msg_send_id![class, daemonServiceWithPlistName: &*name]
            }
            LoginItemServiceKind::MacOsLoginItem(name) => {
                let name = NSString::from_str(name.as_str());
                msg_send_id![class, loginItemServiceWithIdentifier: &*name]
            }
        }
    };
    Ok(service)
}

pub(super) fn set(update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
    let service = service(update.request())?;
    // SAFETY: `service` is an SMAppService and the NSError out parameter is managed by objc2's
    // error-aware message send.
    let result: Result<(), Retained<NSError>> = unsafe {
        match update.registration() {
            LoginItemRegistration::Enable => {
                msg_send![&service, registerAndReturnError: _]
            }
            LoginItemRegistration::Disable => {
                msg_send![&service, unregisterAndReturnError: _]
            }
        }
    };
    result.map_err(|error| {
        SystemServiceError::backend(
            LOGIN_ITEM,
            std::io::Error::other(error.localizedDescription().to_string()),
        )
    })
}

pub(super) fn get(request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
    let service = service(request)?;
    // SAFETY: `service` is an SMAppService and `status` returns its documented NSInteger enum.
    let status: isize = unsafe { msg_send![&service, status] };
    let status = match status {
        0 => LoginItemStatus::NotRegistered,
        1 => LoginItemStatus::Enabled,
        2 => LoginItemStatus::RequiresApproval,
        3 => LoginItemStatus::NotFound,
        value => {
            return Err(SystemServiceError::backend(
                LOGIN_ITEM,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("ServiceManagement returned unknown login-item status {value}"),
                ),
            ));
        }
    };
    Ok(LoginItemState::new(status))
}

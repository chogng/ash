use super::LOGIN_ITEM;
use super::LoginItemRequest;
use super::LoginItemState;
use super::LoginItemUpdate;
use crate::services::SystemServiceError;

#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod macos;
#[cfg(target_os = "windows")]
#[path = "platform/windows.rs"]
mod windows;

#[cfg(target_os = "macos")]
pub(super) fn set(update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
    macos::set(update)
}

#[cfg(target_os = "macos")]
pub(super) fn get(request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
    macos::get(request)
}

#[cfg(target_os = "windows")]
pub(super) fn set(update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
    windows::set(update)
}

#[cfg(target_os = "windows")]
pub(super) fn get(request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
    windows::get(request)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn set(_update: &LoginItemUpdate) -> Result<(), SystemServiceError> {
    Err(SystemServiceError::unsupported(LOGIN_ITEM))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn get(_request: &LoginItemRequest) -> Result<LoginItemState, SystemServiceError> {
    Err(SystemServiceError::unsupported(LOGIN_ITEM))
}

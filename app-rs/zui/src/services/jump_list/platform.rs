#[cfg(not(target_os = "windows"))]
use super::JUMP_LIST;
use super::JumpListRequest;
use super::JumpListSettings;
use super::JumpListUpdateResult;
use crate::services::SystemServiceError;

#[cfg(target_os = "windows")]
#[path = "platform/windows.rs"]
mod windows;

#[cfg(target_os = "windows")]
pub(super) fn settings() -> Result<JumpListSettings, SystemServiceError> {
    windows::settings()
}

#[cfg(target_os = "windows")]
pub(super) fn set(request: &JumpListRequest) -> Result<JumpListUpdateResult, SystemServiceError> {
    windows::set(request)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn settings() -> Result<JumpListSettings, SystemServiceError> {
    Err(SystemServiceError::unsupported(JUMP_LIST))
}

#[cfg(not(target_os = "windows"))]
pub(super) fn set(_request: &JumpListRequest) -> Result<JumpListUpdateResult, SystemServiceError> {
    Err(SystemServiceError::unsupported(JUMP_LIST))
}

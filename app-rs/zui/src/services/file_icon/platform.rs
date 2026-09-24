use super::FileIconImage;
use super::FileIconRequest;
use crate::services::SystemServiceError;

#[cfg(target_os = "linux")]
#[path = "platform/linux.rs"]
mod implementation;
#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod implementation;
#[cfg(target_os = "windows")]
#[path = "platform/windows.rs"]
mod implementation;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(super) fn load(request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
    implementation::load(request)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(super) fn load(_request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
    Err(SystemServiceError::unsupported("file icon"))
}

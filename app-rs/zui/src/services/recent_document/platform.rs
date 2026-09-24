#![allow(unsafe_code)]

use std::path::Path;
use std::path::PathBuf;

use super::RECENT_DOCUMENTS;
use crate::services::SystemServiceError;

#[cfg(target_os = "macos")]
fn macos_controller()
-> Result<objc2::rc::Retained<objc2_app_kit::NSDocumentController>, SystemServiceError> {
    use objc2_foundation::MainThreadMarker;

    let main_thread = MainThreadMarker::new().ok_or_else(|| {
        SystemServiceError::backend(
            RECENT_DOCUMENTS,
            std::io::Error::other("recent documents must be accessed on the macOS main thread"),
        )
    })?;
    // SAFETY: The marker proves this call runs on AppKit's main thread.
    Ok(unsafe { objc2_app_kit::NSDocumentController::sharedDocumentController(main_thread) })
}

#[cfg(target_os = "macos")]
pub(super) fn add(path: &Path) -> Result<(), SystemServiceError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::ptr::NonNull;

    use objc2_foundation::NSURL;

    let representation = CString::new(path.as_os_str().as_bytes())
        .map_err(|source| SystemServiceError::invalid_input(RECENT_DOCUMENTS, source))?;
    let pointer = NonNull::new(representation.as_ptr().cast_mut())
        .expect("CString always exposes a non-null representation");
    // SAFETY: `pointer` remains valid for the call, is NUL terminated, and describes a native
    // filesystem path. NSURL retains its own representation.
    let url = unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            pointer,
            path.is_dir(),
            None,
        )
    };
    // SAFETY: The controller and URL are retained AppKit/Foundation objects on the main thread.
    unsafe { macos_controller()?.noteNewRecentDocumentURL(&url) };
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn clear() -> Result<(), SystemServiceError> {
    // SAFETY: The controller is retained and the main-thread precondition was checked.
    unsafe { macos_controller()?.clearRecentDocuments(None) };
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn list() -> Result<Vec<PathBuf>, SystemServiceError> {
    use std::ffi::CStr;
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    // SAFETY: The controller is retained and the main-thread precondition was checked.
    let urls = unsafe { macos_controller()?.recentDocumentURLs() };
    let mut paths = Vec::new();
    for url in &urls {
        // SAFETY: NSURL owns a stable NUL-terminated filesystem representation for the duration
        // of this borrow.
        if unsafe { url.isFileURL() } {
            let representation = unsafe { url.fileSystemRepresentation() };
            let bytes = unsafe { CStr::from_ptr(representation.as_ptr()) }.to_bytes();
            paths.push(PathBuf::from(OsString::from_vec(bytes.to_vec())));
        }
    }
    Ok(paths)
}

#[cfg(target_os = "windows")]
pub(super) fn add(path: &Path) -> Result<(), SystemServiceError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::UI::Shell::SHARD_PATHW;
    use windows_sys::Win32::UI::Shell::SHAddToRecentDocs;

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let kind = u32::try_from(SHARD_PATHW).expect("SHARD_PATHW is non-negative");
    // SAFETY: `path` is a live NUL-terminated UTF-16 buffer and SHAddToRecentDocs does not retain
    // the caller's pointer.
    unsafe { SHAddToRecentDocs(kind, path.as_ptr().cast()) };
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn clear() -> Result<(), SystemServiceError> {
    use windows_sys::Win32::UI::Shell::SHARD_PATHW;
    use windows_sys::Win32::UI::Shell::SHAddToRecentDocs;

    let kind = u32::try_from(SHARD_PATHW).expect("SHARD_PATHW is non-negative");
    // SAFETY: A null item pointer is the documented operation for clearing usage data.
    unsafe { SHAddToRecentDocs(kind, std::ptr::null()) };
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn list() -> Result<Vec<PathBuf>, SystemServiceError> {
    Err(SystemServiceError::unsupported(RECENT_DOCUMENTS))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn add(_path: &Path) -> Result<(), SystemServiceError> {
    Err(SystemServiceError::unsupported(RECENT_DOCUMENTS))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn clear() -> Result<(), SystemServiceError> {
    Err(SystemServiceError::unsupported(RECENT_DOCUMENTS))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn list() -> Result<Vec<PathBuf>, SystemServiceError> {
    Err(SystemServiceError::unsupported(RECENT_DOCUMENTS))
}

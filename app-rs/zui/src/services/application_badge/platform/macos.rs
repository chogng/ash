#![allow(unsafe_code)]

use objc2_app_kit::NSApplication;
use objc2_foundation::MainThreadMarker;
use objc2_foundation::NSString;

use super::super::APPLICATION_BADGE;
use super::super::ApplicationBadgeRequest;
use crate::services::SystemServiceError;

pub(super) fn set(request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError> {
    let main_thread = MainThreadMarker::new().ok_or_else(|| {
        SystemServiceError::backend(
            APPLICATION_BADGE,
            std::io::Error::other("application badges must be accessed on the macOS main thread"),
        )
    })?;
    let label = request.badge().display_label();
    let label = label.as_deref().map(NSString::from_str);
    let application = NSApplication::sharedApplication(main_thread);
    // SAFETY: The main-thread marker establishes AppKit thread affinity. Both the retained Dock
    // tile and optional NSString remain alive for the setter call.
    unsafe {
        application.dockTile().setBadgeLabel(label.as_deref());
    }
    Ok(())
}

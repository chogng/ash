#![allow(unsafe_code)]

use super::DEFAULT_PROTOCOL_CLIENT;
use super::ProtocolClientRemoval;
use super::ProtocolClientRequest;
use crate::services::SystemServiceError;

fn workspace() -> Result<objc2::rc::Retained<objc2_app_kit::NSWorkspace>, SystemServiceError> {
    use objc2_foundation::MainThreadMarker;

    MainThreadMarker::new().ok_or_else(|| {
        SystemServiceError::backend(
            DEFAULT_PROTOCOL_CLIENT,
            std::io::Error::other("protocol clients must be accessed on the macOS main thread"),
        )
    })?;
    // SAFETY: The main-thread marker above establishes AppKit's thread precondition.
    Ok(unsafe { objc2_app_kit::NSWorkspace::sharedWorkspace() })
}

fn bundle_identifier() -> Result<objc2::rc::Retained<objc2_foundation::NSString>, SystemServiceError>
{
    use objc2_foundation::NSBundle;

    let bundle = NSBundle::mainBundle();
    // SAFETY: `bundle` is retained for the property access.
    unsafe { bundle.bundleIdentifier() }.ok_or_else(|| {
        SystemServiceError::backend(
            DEFAULT_PROTOCOL_CLIENT,
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "the main application bundle has no identifier",
            ),
        )
    })
}

fn protocol_url(
    request: &ProtocolClientRequest,
) -> Result<objc2::rc::Retained<objc2_foundation::NSURL>, SystemServiceError> {
    use objc2_foundation::NSString;
    use objc2_foundation::NSURL;

    let serialized = NSString::from_str(&format!("{}:", request.scheme().as_str()));
    // SAFETY: The validated ASCII scheme plus `:` is a valid absolute URL string.
    unsafe { NSURL::URLWithString(&serialized) }.ok_or_else(|| {
        SystemServiceError::backend(
            DEFAULT_PROTOCOL_CLIENT,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "LaunchServices rejected the validated protocol URL",
            ),
        )
    })
}

fn set_handler(
    scheme: &objc2_foundation::NSString,
    identifier: &objc2_foundation::NSString,
) -> Result<(), SystemServiceError> {
    use std::ffi::c_void;

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSSetDefaultHandlerForURLScheme(
            url_scheme: *const c_void,
            handler_bundle_identifier: *const c_void,
        ) -> i32;
    }

    // SAFETY: NSString and CFString are toll-free bridged. Both retained objects remain alive for
    // the synchronous LaunchServices call.
    let status = unsafe {
        LSSetDefaultHandlerForURLScheme(
            std::ptr::from_ref(scheme).cast(),
            std::ptr::from_ref(identifier).cast(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(SystemServiceError::backend(
            DEFAULT_PROTOCOL_CLIENT,
            std::io::Error::from_raw_os_error(status),
        ))
    }
}

pub(super) fn set_default(request: &ProtocolClientRequest) -> Result<(), SystemServiceError> {
    use objc2_foundation::NSString;

    workspace()?;
    let scheme = NSString::from_str(request.scheme().as_str());
    let identifier = bundle_identifier()?;
    set_handler(&scheme, &identifier)
}

pub(super) fn is_default(request: &ProtocolClientRequest) -> Result<bool, SystemServiceError> {
    use objc2_foundation::NSBundle;

    let workspace = workspace()?;
    let protocol_url = protocol_url(request)?;
    let identifier = bundle_identifier()?;
    // SAFETY: All objects are retained and this runs on AppKit's main thread.
    let Some(application_url) = (unsafe { workspace.URLForApplicationToOpenURL(&protocol_url) })
    else {
        return Ok(false);
    };
    // SAFETY: The workspace returned a retained application URL.
    let Some(bundle) = (unsafe { NSBundle::bundleWithURL(&application_url) }) else {
        return Ok(false);
    };
    // SAFETY: `bundle` remains retained during the identifier access.
    let Some(default_identifier) = (unsafe { bundle.bundleIdentifier() }) else {
        return Ok(false);
    };
    Ok(default_identifier
        .to_string()
        .eq_ignore_ascii_case(&identifier.to_string()))
}

pub(super) fn remove_default(
    request: &ProtocolClientRequest,
) -> Result<ProtocolClientRemoval, SystemServiceError> {
    use objc2_foundation::NSBundle;
    use objc2_foundation::NSString;

    if !is_default(request)? {
        return Ok(ProtocolClientRemoval::NotCurrent);
    }
    let workspace = workspace()?;
    let protocol_url = protocol_url(request)?;
    let identifier = bundle_identifier()?;
    // SAFETY: All objects are retained and this runs on AppKit's main thread.
    let applications = unsafe { workspace.URLsForApplicationsToOpenURL(&protocol_url) };
    let mut replacement = None;
    for application_url in &applications {
        // SAFETY: The array retains each URL for the duration of iteration.
        let Some(bundle) = (unsafe { NSBundle::bundleWithURL(application_url) }) else {
            continue;
        };
        // SAFETY: `bundle` remains retained during the identifier access.
        let Some(candidate) = (unsafe { bundle.bundleIdentifier() }) else {
            continue;
        };
        if !candidate
            .to_string()
            .eq_ignore_ascii_case(&identifier.to_string())
        {
            replacement = Some(candidate);
            break;
        }
    }
    let replacement = replacement.unwrap_or_else(|| NSString::from_str("None"));
    let scheme = NSString::from_str(request.scheme().as_str());
    set_handler(&scheme, &replacement)?;
    Ok(ProtocolClientRemoval::Removed)
}

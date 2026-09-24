#![allow(unsafe_code)]

#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::io;
#[cfg(target_os = "macos")]
use std::ptr;
#[cfg(target_os = "macos")]
use std::slice;

use super::AboutPanelOptions;
use super::USER_ACTIVITY;
use super::UserActivityInfo;
use crate::services::SystemServiceError;
use crate::window::WindowIcon;
#[cfg(target_os = "macos")]
use objc2::ClassType;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSAboutPanelOptionApplicationName;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSAboutPanelOptionApplicationVersion;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSAboutPanelOptionCredits;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSAboutPanelOptionVersion;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplication;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplicationActivationPolicy;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSBitmapFormat;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSBitmapImageRep;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSDeviceRGBColorSpace;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSImage;
#[cfg(target_os = "macos")]
use objc2_foundation::CGSize;
#[cfg(target_os = "macos")]
use objc2_foundation::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_foundation::NSAttributedString;
#[cfg(target_os = "macos")]
use objc2_foundation::NSData;
#[cfg(target_os = "macos")]
use objc2_foundation::NSDictionary;
#[cfg(target_os = "macos")]
use objc2_foundation::NSJSONReadingOptions;
#[cfg(target_os = "macos")]
use objc2_foundation::NSJSONSerialization;
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
#[cfg(target_os = "macos")]
use objc2_foundation::NSURL;
#[cfg(target_os = "macos")]
use objc2_foundation::NSUserActivity;
#[cfg(target_os = "macos")]
use objc2_foundation::ns_string;

#[cfg(target_os = "windows")]
#[path = "platform/windows.rs"]
mod windows;

#[cfg(target_os = "macos")]
thread_local! {
    static CURRENT_USER_ACTIVITY: RefCell<Option<Retained<NSUserActivity>>> = const {
        RefCell::new(None)
    };
}

#[cfg(target_os = "macos")]
fn application() -> objc2::rc::Retained<NSApplication> {
    let main_thread = MainThreadMarker::new()
        .expect("application presentation operations must run on the macOS main thread");
    NSApplication::sharedApplication(main_thread)
}

pub(in crate::app) fn focus(steal: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        if steal {
            #[allow(deprecated)]
            application().activateIgnoringOtherApps(true);
        } else {
            // SAFETY: `application` returns the process-wide AppKit object on the main thread.
            unsafe { application().activate() };
        }
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = steal;
        false
    }
}

pub(in crate::app) fn is_active() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AppContext methods execute on the native main thread.
        Some(unsafe { application().isActive() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(in crate::app) fn hide() -> bool {
    #[cfg(target_os = "macos")]
    {
        application().hide(None);
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub(in crate::app) fn show() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AppContext methods execute on the native main thread.
        unsafe { application().unhideWithoutActivation() };
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub(in crate::app) fn is_hidden() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AppContext methods execute on the native main thread.
        Some(unsafe { application().isHidden() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(in crate::app) fn is_emoji_panel_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(target_os = "windows")]
    {
        windows::is_emoji_panel_supported()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

pub(in crate::app) fn show_emoji_panel() -> bool {
    #[cfg(target_os = "macos")]
    {
        application().orderFrontCharacterPalette(None);
        true
    }
    #[cfg(target_os = "windows")]
    {
        windows::show_emoji_panel()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

pub(in crate::app) fn show_about_panel(options: &AboutPanelOptions) -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut keys: Vec<&NSString> = Vec::new();
        let mut objects: Vec<Retained<AnyObject>> = Vec::new();
        if let Some(name) = options.name.as_deref() {
            keys.push(unsafe { NSAboutPanelOptionApplicationName });
            objects.push(Retained::into_super(Retained::into_super(
                NSString::from_str(name),
            )));
        }
        if let Some(version) = options.version.as_deref() {
            keys.push(unsafe { NSAboutPanelOptionApplicationVersion });
            objects.push(Retained::into_super(Retained::into_super(
                NSString::from_str(version),
            )));
        }
        if let Some(build) = options.short_version.as_deref() {
            keys.push(unsafe { NSAboutPanelOptionVersion });
            objects.push(Retained::into_super(Retained::into_super(
                NSString::from_str(build),
            )));
        }
        if let Some(copyright) = options.copyright.as_deref() {
            keys.push(ns_string!("Copyright"));
            objects.push(Retained::into_super(Retained::into_super(
                NSString::from_str(copyright),
            )));
        }
        if let Some(credits) = options.credits.as_deref() {
            keys.push(unsafe { NSAboutPanelOptionCredits });
            objects.push(Retained::into_super(Retained::into_super(
                NSAttributedString::from_nsstring(&NSString::from_str(credits)),
            )));
        }
        let options = NSDictionary::<NSString>::from_vec(&keys, objects);
        // SAFETY: AppContext runs on the main thread and the dictionary retains every option for
        // the synchronous AppKit call.
        unsafe { application().orderFrontStandardAboutPanelWithOptions(&options) };
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = options;
        false
    }
}

pub(in crate::app) fn set_dock_visible(visible: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            NSApplicationActivationPolicy::Regular
        } else {
            NSApplicationActivationPolicy::Accessory
        };
        application().setActivationPolicy(policy)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = visible;
        false
    }
}

pub(in crate::app) fn is_dock_visible() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AppContext methods execute on the native main thread.
        Some(unsafe { application().activationPolicy() } == NSApplicationActivationPolicy::Regular)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(in crate::app) fn set_dock_icon(icon: Option<&WindowIcon>) -> bool {
    #[cfg(target_os = "macos")]
    {
        let image = match icon {
            Some(icon) => match icon_image(icon) {
                Some(image) => Some(image),
                None => return false,
            },
            None => None,
        };
        // SAFETY: AppContext runs on the AppKit main thread. NSApplication retains the image, and
        // None restores artwork supplied by the application bundle.
        unsafe { application().setApplicationIconImage(image.as_deref()) };
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = icon;
        false
    }
}

pub(in crate::app) fn set_user_activity(
    activity_type: &str,
    user_info: &UserActivityInfo,
    webpage_url: Option<&url::Url>,
) -> Result<(), SystemServiceError> {
    #[cfg(target_os = "macos")]
    {
        let user_info = user_info_dictionary(user_info)?;
        let webpage_url = webpage_url
            .map(|url| {
                // SAFETY: URL validation already accepted one absolute HTTP(S) URL.
                unsafe { NSURL::URLWithString(&NSString::from_str(url.as_str())) }.ok_or_else(
                    || {
                        SystemServiceError::backend(
                            USER_ACTIVITY,
                            io::Error::other("Foundation rejected a validated Handoff webpage URL"),
                        )
                    },
                )
            })
            .transpose()?;
        // SAFETY: AppContext calls run on the main thread and the validated activity type is
        // copied by Foundation. The retained activity owns its user-info and webpage URL values.
        let activity = unsafe {
            let activity = NSUserActivity::initWithActivityType(
                NSUserActivity::alloc(),
                &NSString::from_str(activity_type),
            );
            activity.setUserInfo(Some(&user_info));
            activity.setWebpageURL(webpage_url.as_deref());
            activity.becomeCurrent();
            activity.setNeedsSave(true);
            activity
        };
        CURRENT_USER_ACTIVITY.with(|current| current.replace(Some(activity)));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (activity_type, user_info, webpage_url);
        Err(SystemServiceError::unsupported(USER_ACTIVITY))
    }
}

pub(in crate::app) fn current_user_activity_type() -> Option<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        Some(CURRENT_USER_ACTIVITY.with(|current| {
            current
                .borrow()
                .as_ref()
                // SAFETY: The retained activity remains live for the copied NSString conversion.
                .map(|activity| unsafe { activity.activityType() }.to_string())
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(in crate::app) fn update_current_activity(
    activity_type: &str,
    user_info: &UserActivityInfo,
) -> Result<(), SystemServiceError> {
    #[cfg(target_os = "macos")]
    {
        CURRENT_USER_ACTIVITY.with(|current| {
            let current = current.borrow();
            let Some(activity) = current.as_ref() else {
                return Ok(());
            };
            // SAFETY: The activity is retained for this borrow and the NSString is copied before
            // the borrow ends.
            if unsafe { activity.activityType() }.to_string() != activity_type {
                return Ok(());
            }
            let user_info = user_info_dictionary(user_info)?;
            // SAFETY: Foundation retains the dictionary entries and marks this live activity for
            // its next Handoff state snapshot.
            unsafe {
                activity.addUserInfoEntriesFromDictionary(&user_info);
                activity.setNeedsSave(true);
            }
            Ok(())
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (activity_type, user_info);
        Err(SystemServiceError::unsupported(USER_ACTIVITY))
    }
}

pub(in crate::app) fn resign_current_activity() -> Result<(), SystemServiceError> {
    #[cfg(target_os = "macos")]
    {
        CURRENT_USER_ACTIVITY.with(|current| {
            if let Some(activity) = current.borrow().as_ref() {
                // SAFETY: The retained activity remains live for the synchronous Foundation call.
                unsafe { activity.resignCurrent() };
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(SystemServiceError::unsupported(USER_ACTIVITY))
    }
}

pub(in crate::app) fn invalidate_current_activity() -> Result<(), SystemServiceError> {
    #[cfg(target_os = "macos")]
    {
        CURRENT_USER_ACTIVITY.with(|current| {
            if let Some(activity) = current.borrow_mut().take() {
                // SAFETY: The retained activity remains live for the synchronous Foundation call.
                unsafe { activity.invalidate() };
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(SystemServiceError::unsupported(USER_ACTIVITY))
    }
}

#[cfg(target_os = "macos")]
fn user_info_dictionary(
    user_info: &UserActivityInfo,
) -> Result<Retained<NSDictionary>, SystemServiceError> {
    let bytes = serde_json::to_vec(user_info)
        .map_err(|source| SystemServiceError::invalid_input(USER_ACTIVITY, source))?;
    let data = NSData::from_vec(bytes);
    // SAFETY: NSData contains one complete JSON object serialized from UserActivityInfo.
    let object = unsafe {
        NSJSONSerialization::JSONObjectWithData_options_error(&data, NSJSONReadingOptions::empty())
    }
    .map_err(|error| {
        SystemServiceError::backend(
            USER_ACTIVITY,
            io::Error::other(error.localizedDescription().to_string()),
        )
    })?;
    // SAFETY: UserActivityInfo always serializes as a top-level JSON object, which Foundation
    // materializes as NSDictionary. The cast preserves the object's +1 retain count.
    Ok(unsafe { Retained::cast(object) })
}

#[cfg(target_os = "macos")]
fn icon_image(icon: &WindowIcon) -> Option<Retained<NSImage>> {
    let width = isize::try_from(icon.width()).ok()?;
    let height = isize::try_from(icon.height()).ok()?;
    let bytes_per_row = width.checked_mul(4)?;
    // SAFETY: A null plane array asks AppKit to allocate exactly the validated icon dimensions.
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            ptr::null_mut(),
            width,
            height,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            NSBitmapFormat::AlphaNonpremultiplied,
            bytes_per_row,
            32,
        )
    }?;
    // SAFETY: WindowIcon validates width * height * 4 bytes, and the bitmap allocation remains
    // live while those bytes are copied into its packed RGBA8 storage.
    let destination = unsafe { slice::from_raw_parts_mut(bitmap.bitmapData(), icon.rgba().len()) };
    destination.copy_from_slice(icon.rgba());
    // SAFETY: The validated finite dimensions initialize one owned image, and AppKit retains the
    // live bitmap representation when it is attached.
    let image = unsafe {
        let image = NSImage::initWithSize(
            NSImage::alloc(),
            CGSize::new(f64::from(icon.width()), f64::from(icon.height())),
        );
        image.addRepresentation(&bitmap);
        image
    };
    Some(image)
}

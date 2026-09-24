#![allow(unsafe_code)]

use super::ApplicationLocale;

#[cfg(target_os = "macos")]
pub(super) fn system_locale() -> Option<ApplicationLocale> {
    use objc2_foundation::NSLocale;

    // SAFETY: NSLocale returns retained immutable Foundation values and requires no caller-owned
    // pointers. Detection runs on the application startup thread.
    let identifier = unsafe { NSLocale::currentLocale().localeIdentifier() }.to_string();
    ApplicationLocale::from_platform(&identifier)
}

#[cfg(target_os = "windows")]
pub(super) fn system_locale() -> Option<ApplicationLocale> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    let mut buffer = [0_u16; 85];
    // SAFETY: `buffer` is writable for the exact element count passed to the Win32 API.
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), 85) };
    let length = usize::try_from(length).ok()?;
    let identifier = String::from_utf16(buffer.get(..length.checked_sub(1)?)?).ok()?;
    ApplicationLocale::from_platform(&identifier)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) fn system_locale() -> Option<ApplicationLocale> {
    ["LC_ALL", "LC_TIME", "LANG"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter_map(|identifier| identifier.into_string().ok())
        .find_map(|identifier| ApplicationLocale::from_platform(&identifier))
}

#[cfg(not(any(unix, target_os = "windows")))]
pub(super) fn system_locale() -> Option<ApplicationLocale> {
    sys_locale::get_locale().and_then(|identifier| ApplicationLocale::from_platform(&identifier))
}

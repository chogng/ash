//! One-way confinement of a product-owned JS process after engine/source preparation.

/// Denies direct I/O and child processes before any extension code executes.
/// Only macOS is supported; an unsupported OS must refuse execution.
pub fn restrict_javascript_process() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return seatbelt::restrict();
    #[cfg(not(target_os = "macos"))]
    Err("JavaScript process isolation is unavailable on this platform".into())
}

#[cfg(target_os = "macos")]
mod seatbelt {
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::os::raw::c_int;

    unsafe extern "C" {
        fn sandbox_init(profile: *const c_char, flags: u64, error: *mut *mut c_char) -> c_int;
        fn sandbox_free_error(error: *mut c_char);
    }

    pub(super) fn restrict() -> Result<(), String> {
        // V8, ICU and package sources are already in memory. Pipes remain usable without
        // path access; the extension can reach host resources only through the bounded RPC.
        let profile = c"(version 1) (deny default) (allow sysctl-read)";
        let mut error = std::ptr::null_mut();
        // SAFETY: static NUL-terminated profile and a writable error pointer. Seatbelt
        // applies to this process and all its threads, with no way to lift the restriction.
        let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error) };
        if result == 0 {
            return Ok(());
        }
        let message = if error.is_null() {
            "system rejected JavaScript confinement".into()
        } else {
            // SAFETY: Seatbelt owns a NUL-terminated error until sandbox_free_error.
            let message = unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            unsafe { sandbox_free_error(error) };
            message
        };
        Err(message)
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "isolation_tests.rs"]
mod tests;

#![allow(unsafe_code)]

use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Power::PowerClearRequest;
use windows_sys::Win32::System::Power::PowerCreateRequest;
use windows_sys::Win32::System::Power::PowerRequestSystemRequired;
use windows_sys::Win32::System::Power::PowerSetRequest;
use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
use windows_sys::Win32::System::Threading::POWER_REQUEST_CONTEXT_SIMPLE_STRING;
use windows_sys::Win32::System::Threading::REASON_CONTEXT;
use windows_sys::Win32::System::Threading::REASON_CONTEXT_0;

struct Assertion(OwnedHandle);

pub(super) fn acquire(reason: &str) -> io::Result<Box<dyn Send>> {
    let mut reason: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
    let context = REASON_CONTEXT {
        Version: POWER_REQUEST_CONTEXT_VERSION,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 {
            SimpleReasonString: reason.as_mut_ptr(),
        },
    };
    // SAFETY: The context and its terminated string remain valid until Windows copies them.
    let handle = unsafe { PowerCreateRequest(&context) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: PowerCreateRequest transfers this valid, uniquely owned handle to the caller.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    // SAFETY: The owned handle is a live power request; the request type is supported.
    if unsafe { PowerSetRequest(handle.as_raw_handle(), PowerRequestSystemRequired) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Box::new(Assertion(handle)))
}

impl Drop for Assertion {
    fn drop(&mut self) {
        // SAFETY: The handle remains live until OwnedHandle drops after this method.
        if unsafe { PowerClearRequest(self.0.as_raw_handle(), PowerRequestSystemRequired) } == 0 {
            log::warn!("PowerClearRequest failed: {}", io::Error::last_os_error());
        }
    }
}

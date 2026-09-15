#![allow(unsafe_code)]

use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation::string::CFStringRef;
use std::io;

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(
        kind: CFStringRef,
        level: u32,
        reason: CFStringRef,
        id: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

struct Assertion(u32);

pub(super) fn acquire(reason: &str) -> io::Result<Box<dyn Send>> {
    let kind = CFString::new("PreventUserIdleSystemSleep");
    let reason = CFString::new(reason);
    let mut id = 0;
    // SAFETY: Both CFStrings and the writable assertion ID live through the synchronous call.
    let result = unsafe {
        IOPMAssertionCreateWithName(
            kind.as_concrete_TypeRef(),
            1,
            reason.as_concrete_TypeRef(),
            &mut id,
        )
    };
    if result != 0 {
        return Err(io::Error::other(format!(
            "IOPMAssertionCreateWithName returned {result:#x}"
        )));
    }
    Ok(Box::new(Assertion(id)))
}

impl Drop for Assertion {
    fn drop(&mut self) {
        // SAFETY: This ID was created successfully and is released exactly once by its owner.
        let result = unsafe { IOPMAssertionRelease(self.0) };
        if result != 0 {
            log::warn!("IOPMAssertionRelease returned {result:#x}");
        }
    }
}

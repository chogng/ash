#[cfg(all(target_os = "linux", bwrap_available))]
fn main() {
    use std::ffi::CStr;
    use std::ffi::CString;
    use std::os::raw::c_char;
    use std::os::unix::ffi::OsStrExt;

    unsafe extern "C" {
        fn bwrap_main(argc: libc::c_int, argv: *const *const c_char) -> libc::c_int;
    }

    let arguments = std::env::args_os()
        .map(|argument| {
            CString::new(argument.as_os_str().as_bytes())
                .unwrap_or_else(|error| panic!("Bubblewrap argument contains NUL: {error}"))
        })
        .collect::<Vec<_>>();
    let mut argument_pointers = arguments
        .iter()
        .map(CString::as_c_str)
        .map(CStr::as_ptr)
        .collect::<Vec<*const c_char>>();
    argument_pointers.push(std::ptr::null());

    // SAFETY: pointers reference live, NUL-terminated C strings and the pointer array is
    // NUL-terminated for the duration of the call.
    let exit_code =
        unsafe { bwrap_main(arguments.len() as libc::c_int, argument_pointers.as_ptr()) };
    std::process::exit(exit_code);
}

#[cfg(all(target_os = "linux", not(bwrap_available)))]
fn main() {
    eprintln!("bundled Bubblewrap was not compiled for this target");
    std::process::exit(1);
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("bwrap is only supported on Linux");
    std::process::exit(1);
}

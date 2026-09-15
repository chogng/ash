//! Process protection before credentials, runtimes, or worker threads are created.

use std::io;

// Release builds sanitize inherited loader configuration before threads start.
// Development builds preserve debugger and toolchain configuration.
#[ctor::ctor]
fn clean_environment() {
    if cfg!(debug_assertions) {
        return;
    }
    let keys: Vec<_> = std::env::vars_os()
        .map(|(key, _)| key)
        .filter(|key| dangerous_key(key))
        .collect();
    for key in keys {
        // SAFETY: this constructor runs during single-threaded process initialization.
        unsafe { std::env::remove_var(key) };
    }
}

fn dangerous_key(key: &std::ffi::OsStr) -> bool {
    let bytes = key.as_encoded_bytes();
    bytes.starts_with(b"LD_") || bytes.starts_with(b"DYLD_")
}

/// Release builds disable dumps and debugger attachment; development builds preserve them.
/// Windows DLL search protection applies in both modes.
/// Call as the first operation in each executable, before loading secrets or starting threads.
/// Failure must stop startup. Clearing loader variables cannot undo libraries loaded at exec.
pub fn initialize() -> io::Result<()> {
    #[cfg(all(unix, not(debug_assertions)))]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: limit is a valid initialized rlimit; this changes only the current process.
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(all(not(debug_assertions), any(target_os = "linux", target_os = "android")))]
    // SAFETY: PR_SET_DUMPABLE accepts this integer value and no pointer arguments.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    // SAFETY: PT_DENY_ATTACH uses no address or process identity argument.
    if unsafe { libc::ptrace(libc::PT_DENY_ATTACH, 0, std::ptr::null_mut(), 0) } == -1 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Diagnostics::Debug::SEM_NOGPFAULTERRORBOX;
        use windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode;
        use windows_sys::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
        use windows_sys::Win32::System::LibraryLoader::SetDefaultDllDirectories;
        // SAFETY: these APIs take only documented flags, without pointers.
        unsafe {
            if SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) == 0 {
                return Err(io::Error::last_os_error());
            }
            SetErrorMode(SEM_NOGPFAULTERRORBOX);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "hardening_tests.rs"]
mod tests;

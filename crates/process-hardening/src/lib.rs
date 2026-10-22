//! Process protection before credentials, runtimes, or worker threads are created.

use std::io;

mod exit_cleanup;
pub use exit_cleanup::register_exit_cleanup;

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
/// Windows DLL search protection and standard-handle isolation, and Linux descriptor
/// inheritance isolation, apply in both modes.
/// Call as the first operation in each executable, before loading secrets or starting threads.
/// Failure must stop startup. Clearing loader variables cannot undo libraries loaded at exec.
pub fn initialize() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    isolate_inherited_descriptors()?;
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
        use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Foundation::SetHandleInformation;
        use windows_sys::Win32::System::Console::GetStdHandle;
        use windows_sys::Win32::System::Console::STD_ERROR_HANDLE;
        use windows_sys::Win32::System::Console::STD_INPUT_HANDLE;
        use windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE;
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
        for stream in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY: these are borrowed process handles, inspected before worker threads start.
            let handle = unsafe { GetStdHandle(stream) };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            // GUI and service entrypoints may have no standard handles.
            if !handle.is_null()
                // SAFETY: change only inheritance; do not close or replace the handle.
                && unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        // Command explicitly duplicates selected stdio handles. Clearing implicit inheritance
        // prevents an unrelated daemon from keeping the caller's redirected pipes open.
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn isolate_inherited_descriptors() -> io::Result<()> {
    // Electron can pass inheritable inspector sockets and Chromium files to a
    // controller. Keep them usable here, but prevent a detached backend or PTY
    // host from retaining the caller's connections after its process exits.
    // SAFETY: initialization runs before threads; CLOEXEC marks descriptors
    // above stderr without closing them or changing the standard streams.
    if unsafe {
        libc::syscall(
            libc::SYS_close_range,
            3_u32,
            u32::MAX,
            libc::CLOSE_RANGE_CLOEXEC,
        )
    } == 0
    {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
        return Err(error);
    }
    // Older kernels lack close_range or its CLOEXEC flag. This is the startup
    // boundary, not a post-fork callback, so directory iteration may allocate.
    for entry in std::fs::read_dir("/proc/self/fd")? {
        let entry = entry?;
        let Some(fd) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if fd <= libc::STDERR_FILENO {
            continue;
        }
        // SAFETY: inspect and mark only descriptors already owned by this process.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(error);
        }
        // SAFETY: preserve all existing flags and leave the descriptor open here.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "hardening_tests.rs"]
mod tests;

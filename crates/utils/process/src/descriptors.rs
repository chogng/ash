#[cfg(all(unix, not(target_os = "linux")))]
use std::os::fd::RawFd;

// The child has a private descriptor table after fork. Darwin's size query reports
// the table capacity, so this also covers sparse descriptors above a lowered rlimit.
// Only stack values and system calls are used here; no allocator or directory locks.
// See xnu/bsd/kern/proc_info.c::proc_pidfdlist (the null-buffer branch).
#[cfg(target_os = "macos")]
pub(crate) fn close_inherited_fds_except(preserved_fds: &[RawFd]) -> std::io::Result<()> {
    // SAFETY: a null buffer requests the kernel's descriptor-table size.
    let bytes = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if bytes <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let limit = bytes as usize / std::mem::size_of::<libc::proc_fdinfo>();
    for fd in libc::STDERR_FILENO + 1..limit as RawFd {
        if preserved_fds.contains(&fd) {
            continue;
        }
        // Keep std::process's CLOEXEC error pipe open until exec, so spawn failures
        // still reach the parent. All other unselected descriptors close here.
        // SAFETY: this single-threaded child exclusively owns its descriptor table.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(error);
        }
        if flags & libc::FD_CLOEXEC == 0 && unsafe { libc::close(fd) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) use crate::linux_fds::close_inherited_fds_except;

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(crate) fn close_inherited_fds_except(preserved_fds: &[RawFd]) -> std::io::Result<()> {
    if let Ok(dir) = std::fs::read_dir("/dev/fd") {
        let mut fds = Vec::new();
        for entry in dir {
            let num = entry
                .ok()
                .map(|entry| entry.file_name())
                .and_then(|name| name.into_string().ok())
                .and_then(|name| name.parse::<RawFd>().ok());
            if let Some(num) = num {
                if num <= 2 || preserved_fds.contains(&num) {
                    continue;
                }
                // Keep CLOEXEC descriptors open so std::process can still use
                // its internal exec-error pipe to report spawn failures.
                let flags = unsafe { libc::fcntl(num, libc::F_GETFD) };
                if flags == -1 || flags & libc::FD_CLOEXEC != 0 {
                    continue;
                }
                fds.push(num);
            }
        }
        for fd in fds {
            unsafe {
                libc::close(fd);
            }
        }
    }
    Ok(())
}

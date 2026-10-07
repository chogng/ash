//! Descriptor cleanup for a forked Linux child before `exec`.

use std::ffi::CStr;
use std::io;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;
use std::os::fd::RawFd;

/// Marks unselected descriptors close-on-exec using only stack storage and syscalls.
/// Rust's spawn-error pipe is already close-on-exec and must remain open until `exec`.
pub(crate) fn close_inherited_fds_except(preserved_fds: &[RawFd]) -> io::Result<()> {
    // SAFETY: this NUL-terminated path is opened only in the forked child.
    let raw = unsafe {
        libc::open(
            c"/proc/self/fd".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if raw == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: open returned a descriptor owned by this child.
    let directory = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut buffer = [0_u8; 4096];
    loop {
        // SAFETY: getdents64 writes no more than buffer.len() bytes to stack storage.
        let count = unsafe {
            libc::syscall(
                libc::SYS_getdents64,
                directory.as_raw_fd(),
                buffer.as_mut_ptr(),
                buffer.len(),
            )
        };
        if count == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Ok(());
        }
        if count as usize > buffer.len() {
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        let mut entries = &buffer[..count as usize];
        while !entries.is_empty() {
            if entries.len() < 20 {
                return Err(io::Error::from_raw_os_error(libc::EIO));
            }
            let length = u16::from_ne_bytes([entries[16], entries[17]]) as usize;
            if length < 20 || length > entries.len() {
                return Err(io::Error::from_raw_os_error(libc::EIO));
            }
            if let Ok(name) = CStr::from_bytes_until_nul(&entries[19..length])
                && let Ok(name) = name.to_str()
                && let Ok(fd) = name.parse::<RawFd>()
                && fd > libc::STDERR_FILENO
                && !preserved_fds.contains(&fd)
            {
                // SAFETY: fcntl only changes this child's descriptor flags.
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
                if flags == -1 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::EBADF) {
                        return Err(error);
                    }
                } else if flags & libc::FD_CLOEXEC == 0
                    // SAFETY: the descriptor remains available to report an exec failure.
                    && unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1
                {
                    return Err(io::Error::last_os_error());
                }
            }
            entries = &entries[length..];
        }
    }
}

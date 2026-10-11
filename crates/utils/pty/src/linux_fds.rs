//! Descriptor cleanup for a forked Linux child before `exec`.

use std::io;
use std::mem::MaybeUninit;
use std::os::fd::BorrowedFd;
use std::os::fd::RawFd;

use rustix::fs::Mode;
use rustix::fs::OFlags;
use rustix::fs::RawDir;
use rustix::fs::open;
use rustix::io::Errno;
use rustix::io::FdFlags;
use rustix::io::fcntl_getfd;
use rustix::io::fcntl_setfd;

/// Marks unselected descriptors close-on-exec using only stack storage and syscalls.
/// Rust's spawn-error pipe is already close-on-exec and must remain open until `exec`.
pub(crate) fn close_inherited_fds_except(preserved_fds: &[RawFd]) -> io::Result<()> {
    let directory = open(
        c"/proc/self/fd",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    // RawDir uses this stack buffer without allocating or locking after fork.
    let mut buffer = [MaybeUninit::uninit(); 4096];
    let mut entries = RawDir::new(directory, &mut buffer);
    while let Some(entry) = entries.next() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(Errno::INTR) => continue,
            Err(error) => return Err(error.into()),
        };
        let Ok(name) = entry.file_name().to_str() else {
            continue;
        };
        let Ok(fd) = name.parse::<RawFd>() else {
            continue;
        };
        if fd <= libc::STDERR_FILENO || preserved_fds.contains(&fd) {
            continue;
        }
        // SAFETY: /proc enumerates this forked child's descriptors; no other thread
        // changes its descriptor table, and this borrow neither owns nor closes them.
        let fd = unsafe { BorrowedFd::borrow_raw(fd) };
        match fcntl_getfd(fd) {
            Ok(flags) if !flags.contains(FdFlags::CLOEXEC) => {
                fcntl_setfd(fd, flags | FdFlags::CLOEXEC)?;
            }
            Ok(_) | Err(Errno::BADF) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

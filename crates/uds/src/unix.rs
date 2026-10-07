// OS FFI stays in this platform boundary.
#![allow(unsafe_code)]

use crate::PeerIdentity;
use crate::UnixStream;
use std::fs::DirBuilder;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn create_private_directory(path: &Path) -> io::Result<()> {
    DirBuilder::new().mode(0o700).create(path)
}

pub(super) fn open_private_directory(path: &Path) -> io::Result<(PathBuf, File)> {
    let absolute = std::path::absolute(path)?;
    let parent = absolute.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let name = absolute.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let path = std::fs::canonicalize(parent)?.join(name);
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(&path)?;
    let metadata = file.metadata()?;
    // geteuid has no memory or resource preconditions.
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket directory is not private to the current user",
        ));
    }
    Ok((path, file))
}

pub(super) fn peer_identity(stream: &UnixStream) -> io::Result<PeerIdentity> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let user = {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&credentials) as libc::socklen_t;
        // The stream owns a live socket and both output buffers have the required sizes.
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                std::ptr::addr_of_mut!(credentials).cast(),
                &mut length,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        if length as usize != std::mem::size_of_val(&credentials) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "incomplete socket peer credentials",
            ));
        }
        credentials.uid
    };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let user = {
        let mut user = 0;
        let mut group = 0;
        // getpeereid returns the effective IDs attached to this connected Unix socket.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut user, &mut group) } != 0 {
            return Err(io::Error::last_os_error());
        }
        user
    };
    Ok(PeerIdentity {
        same_user: user == unsafe { libc::geteuid() },
        same_elevation: true,
    })
}

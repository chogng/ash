//! Cross-platform synchronous Unix domain socket types.
//!
//! Unix targets use the Rust standard library. Windows uses `uds_windows` while the equivalent
//! standard-library API remains unstable.

#[cfg(windows)]
extern crate windows_sys_052 as windows_sys;

mod directory;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

pub use directory::SocketDirectory;

/// Facts about a connected peer relative to the calling process, obtained from the OS.
/// Callers decide whether their endpoint allows a different user or elevation context.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PeerIdentity {
    pub same_user: bool,
    /// Whether both Windows tokens have equal elevation; true on platforms without UAC.
    pub same_elevation: bool,
}

/// Reads the peer identity before the caller sends or accepts application data.
pub fn peer_identity(stream: &UnixStream) -> std::io::Result<PeerIdentity> {
    #[cfg(unix)]
    {
        unix::peer_identity(stream)
    }
    #[cfg(windows)]
    {
        windows::peer_identity(stream)
    }
}

#[cfg(unix)]
pub use std::os::unix::net::UnixListener;
#[cfg(unix)]
pub use std::os::unix::net::UnixStream;
#[cfg(windows)]
pub use uds_windows::UnixListener;
#[cfg(windows)]
pub use uds_windows::UnixStream;

/// Waits for Windows local sockets to become readable or writable, or for the timeout.
/// The borrowed sockets stay open throughout the wait; callers retry IO after a wakeup.
#[cfg(windows)]
pub fn wait_for_socket_activity(
    listener: Option<&UnixListener>,
    readers: &[&UnixStream],
    writers: &[&UnixStream],
    timeout: std::time::Duration,
) -> std::io::Result<()> {
    windows::wait_for_socket_activity(listener, readers, writers, timeout)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

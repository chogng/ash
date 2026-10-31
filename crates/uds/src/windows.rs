// OS FFI stays in this platform boundary.
#![allow(unsafe_code)]

mod directory;
mod peer;
pub(crate) mod pipe;
mod reactor;
mod readiness;
mod security;

pub(super) use directory::open_private_directory;
pub use pipe::IpcListener;
pub use pipe::IpcStream;
pub(super) use readiness::wait_for_ipc_activity;
pub(super) use security::create_private_directory;

pub(super) fn peer_identity(stream: &IpcStream) -> std::io::Result<crate::PeerIdentity> {
    stream.peer_identity()
}

// OS FFI stays in this platform boundary.
#![allow(unsafe_code)]

mod directory;
mod peer;
mod security;

pub(super) use directory::open_private_directory;
pub(super) use directory::validate_socket;
pub(super) use security::create_private_directory;

pub(super) fn peer_identity(stream: &crate::UnixStream) -> std::io::Result<crate::PeerIdentity> {
    use std::os::windows::io::AsRawSocket;
    peer::peer_identity(stream.as_raw_socket())
}

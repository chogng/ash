//! Product-neutral lifecycle coordination for local Remote connections.
//!
//! The crate owns live SSH tunnel supervision, cancellation, readiness, and recovery. It does
//! not own product configuration, credentials, renderer state, or product event types.

mod readiness;
mod tunnel;

pub use readiness::RemoteTunnelStartup;
pub use readiness::wait_for_remote_tunnel;
pub use tunnel::RemoteTunnelEvent;
pub use tunnel::RemoteTunnelHost;
pub use tunnel::RemoteTunnelId;
pub use tunnel::RemoteTunnelUpdate;

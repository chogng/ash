use std::time::Duration;
use std::time::Instant;

use ash_remote_connections::SshTunnel;
use ash_remote_connections::SshTunnelReadiness;

const TUNNEL_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const TUNNEL_READINESS_POLL: Duration = Duration::from_millis(10);

/// Result of waiting for a local SSH Tunnel to expose its loopback listener.
pub enum RemoteTunnelStartup {
    /// The Tunnel is ready for use.
    Ready(SshTunnel),
    /// The caller requested cancellation while the Tunnel was starting.
    Cancelled,
}

/// Waits for a local SSH Tunnel to become ready or for the caller to cancel it.
pub fn wait_for_remote_tunnel(
    mut tunnel: SshTunnel,
    mut cancelled: impl FnMut() -> bool,
) -> Result<RemoteTunnelStartup, String> {
    let started = Instant::now();
    loop {
        if cancelled() {
            tunnel.stop().map_err(|error| error.to_string())?;
            return Ok(RemoteTunnelStartup::Cancelled);
        }
        match tunnel.poll_readiness().map_err(|error| error.to_string())? {
            SshTunnelReadiness::Ready => return Ok(RemoteTunnelStartup::Ready(tunnel)),
            SshTunnelReadiness::Pending => {}
        }
        if started.elapsed() >= TUNNEL_STARTUP_TIMEOUT {
            return Err(format!(
                "SSH tunnel did not expose local loopback port {} within {} seconds",
                tunnel.local_port(),
                TUNNEL_STARTUP_TIMEOUT.as_secs()
            ));
        }
        std::thread::park_timeout(TUNNEL_READINESS_POLL);
    }
}

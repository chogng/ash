//! app's adapter for the application-neutral Remote Tunnel host.
//!
//! The lifecycle supervisor lives in `ash-remote-host`. This module only translates its typed
//! events into app's `WorkbenchEvent` channel and keeps the host owned by the desktop application.

use std::num::NonZeroU16;
use std::path::PathBuf;

use ash_remote::SshHost;
use ash_remote_host::RemoteTunnelHost as SharedRemoteTunnelHost;
use zui::app::AppProxy;

use crate::workbench_event::WorkbenchEvent;

pub(crate) use ash_remote_host::RemoteTunnelEvent;
pub(crate) use ash_remote_host::RemoteTunnelId;

/// app-owned adapter around the shared Remote Tunnel supervisor.
pub(crate) struct RemoteTunnelHost {
    inner: SharedRemoteTunnelHost,
}

impl RemoteTunnelHost {
    pub(crate) fn new(host: SshHost, ssh_executable: impl Into<PathBuf>) -> Self {
        Self {
            inner: SharedRemoteTunnelHost::new(host, ssh_executable),
        }
    }

    pub(crate) fn host(&self) -> &SshHost {
        self.inner.host()
    }

    pub(crate) fn start(
        &mut self,
        remote_port: NonZeroU16,
        event_proxy: AppProxy<WorkbenchEvent>,
    ) -> Result<RemoteTunnelId, String> {
        self.inner.start(remote_port, move |event| {
            let _ = event_proxy.send_event(WorkbenchEvent::RemoteTunnel(event));
        })
    }

    pub(crate) fn stop(&self, tunnel_id: RemoteTunnelId) -> bool {
        self.inner.stop(tunnel_id)
    }

    pub(crate) fn handle_event(&mut self, event: &RemoteTunnelEvent) -> bool {
        self.inner.handle_event(event)
    }
}

//! Bounded, authenticated loopback streaming of completed OpenTelemetry spans.

mod socket;
mod wire;

pub use socket::AccessToken;

use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkError;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::SpanData;
use opentelemetry_sdk::trace::SpanExporter;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::broadcast;

const BUFFER_FRAMES: usize = 256;
const MAX_FRAME_BYTES: usize = 64 * 1024;

/// Live-only exporter. Clones share a listener; SDK shutdown stops all clones.
#[derive(Clone, Debug)]
pub struct Exporter {
    stream: Arc<Stream>,
    resource: Resource,
}

#[derive(Debug)]
struct Stream {
    server: socket::Server,
    frames: broadcast::Sender<Arc<str>>,
    sequence: Mutex<u64>,
}

impl Exporter {
    /// Binds a loopback address and starts a dedicated I/O thread.
    /// No Tokio runtime is required in the calling thread.
    pub fn bind(address: SocketAddr, token: AccessToken) -> io::Result<Self> {
        let (frames, _) = broadcast::channel(BUFFER_FRAMES);
        let server = socket::Server::bind(address, token, frames.clone())?;
        Ok(Self {
            stream: Arc::new(Stream {
                server,
                frames,
                sequence: Mutex::new(0),
            }),
            resource: Resource::builder_empty().build(),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.stream.server.address
    }
}

impl SpanExporter for Exporter {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        let mut sequence = self.stream.sequence.lock().unwrap();
        if self.stream.server.is_stopped() {
            return Err(OTelSdkError::AlreadyShutdown);
        }
        if self.stream.frames.receiver_count() == 0 {
            return Ok(());
        }
        for span in batch {
            let next = *sequence + 1;
            let frame = wire::encode(&span, &self.resource, next)
                .map_err(|error| OTelSdkError::InternalFailure(error.to_string()))?;
            *sequence = next;
            // A viewer may disconnect during encoding. There is no replay queue.
            let _ = self.stream.frames.send(frame.into());
        }
        Ok(())
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.resource = resource.clone();
    }

    fn shutdown_with_timeout(&mut self, timeout: Duration) -> OTelSdkResult {
        self.stream.server.shutdown(timeout)
    }

    fn shutdown(&mut self) -> OTelSdkResult {
        self.shutdown_with_timeout(Duration::from_secs(5))
    }
}

#[cfg(test)]
#[path = "exporter_tests.rs"]
mod tests;

//! Materializes a renderer's immutable context before it enters durable Turn or queue state.

use crate::client_host::ClientHost;
use crate::client_host::ClientHostError;
use ash_app_server_protocol::protocol::host_resource::HostResourceReadParams;
use ash_app_server_protocol::protocol::host_resource::HostResourceReadResult;
use ash_app_server_protocol::protocol::host_resource::HostResourceRef;
use ash_app_server_protocol::protocol::host_resource::HostResourceReleaseParams;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_async_utils::CancellationSource;
use base64::Engine;
use sha2::Digest;
use sha2::Sha256;
use std::time::Duration;
use std::time::Instant;

const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 256 * 1024;

pub(crate) fn read_context(
    host: &ClientHost,
    owner: u64,
    resource: &HostResourceRef,
) -> Result<String, ClientHostError> {
    read_context_with_timeout(host, owner, resource, Duration::from_secs(30))
}

fn read_context_with_timeout(
    host: &ClientHost,
    owner: u64,
    resource: &HostResourceRef,
    timeout: Duration,
) -> Result<String, ClientHostError> {
    // A slow peer gets one admission budget, not a new timeout for every chunk.
    let deadline = Instant::now() + timeout;
    let cancellation = CancellationSource::new();
    let result = materialize(resource, |offset, max_bytes| {
        host.request_with_timeout(
            owner,
            HostMethod::HostResourceRead,
            &HostResourceReadParams {
                handle: resource.handle.clone(),
                offset,
                max_bytes,
            },
            &cancellation.token(),
            deadline.saturating_duration_since(Instant::now()),
        )
    });
    // Cleanup always addresses the same connection, even after a corrupt chunk or failed read.
    // A closed connection already owns teardown; never reroute a handle to a replacement.
    if resource.handle.is_empty() || resource.handle.len() > 128 {
        return result;
    }
    let release = host.request_with_timeout::<_, ()>(
        owner,
        HostMethod::HostResourceRelease,
        &HostResourceReleaseParams {
            handle: resource.handle.clone(),
        },
        &cancellation.token(),
        deadline.saturating_duration_since(Instant::now()),
    );
    match result {
        Ok(content) => release.map(|()| content),
        Err(error) => Err(error),
    }
}

fn materialize(
    resource: &HostResourceRef,
    mut read: impl FnMut(usize, usize) -> Result<HostResourceReadResult, ClientHostError>,
) -> Result<String, ClientHostError> {
    let invalid = || ClientHostError::Failed("Invalid renderer context snapshot".into());
    if resource.handle.is_empty()
        || resource.handle.len() > 128
        || !(1..=MAX_SNAPSHOT_BYTES).contains(&resource.byte_length)
        || resource.sha256.len() != 71
    {
        return Err(invalid());
    }
    let mut bytes = Vec::with_capacity(resource.byte_length);
    while bytes.len() < resource.byte_length {
        let offset = bytes.len();
        let maximum = MAX_CHUNK_BYTES.min(resource.byte_length - offset);
        let chunk = read(offset, maximum)?;
        if chunk.handle != resource.handle
            || chunk.offset != offset
            || chunk.data_base64.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4
        {
            return Err(invalid());
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&chunk.data_base64)
            .map_err(|_| invalid())?;
        if decoded.is_empty()
            || decoded.len() > maximum
            || chunk.decoded_length != decoded.len()
            || chunk.eof != (offset + decoded.len() == resource.byte_length)
        {
            return Err(invalid());
        }
        bytes.extend_from_slice(&decoded);
    }
    if format!("sha256:{:x}", Sha256::digest(&bytes)) != resource.sha256 {
        return Err(invalid());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

#[cfg(test)]
#[path = "host_resource_host_tests.rs"]
mod tests;

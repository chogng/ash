use std::path::Path;
use std::sync::Arc;

use ash_async_utils::CancellationToken;
use ash_editor_extension_host::HostErrorCode;
use ash_editor_extension_host::HostFailure;
use ash_file_system::FileSystem;
use ash_file_system::FileSystemError;
use extension_protocol::ExtensionClientResult;

use super::source::WorkspaceReadAccess;

const MAX_FILE_BYTES: usize = 256 * 1024;

/// Only the Rust filesystem owner may execute this operation. Package permission and current
/// directory authorization must both allow the read; neither installation nor SDK access grants it.
pub(super) fn read_workspace_file(
    access: WorkspaceReadAccess,
    files: &Result<Arc<dyn FileSystem>, HostFailure>,
    path: &str,
    token: &CancellationToken,
) -> Result<ExtensionClientResult, HostFailure> {
    if access == WorkspaceReadAccess::Denied {
        return Err(failure(
            HostErrorCode::PermissionDenied,
            "extension has no directory read permission",
        ));
    }
    if token.is_cancelled() {
        return Err(failure(
            HostErrorCode::Cancelled,
            "extension request cancelled",
        ));
    }
    let files = files.as_ref().map_err(Clone::clone)?;
    let bytes = files
        .read_file(Path::new(path), MAX_FILE_BYTES)
        .map_err(|error| {
            // Do not forward host paths or platform I/O details to the extension.
            let (code, message) = match error {
                FileSystemError::PermissionDenied(_) | FileSystemError::OsPermissionDenied(_) => (
                    HostErrorCode::PermissionDenied,
                    "workspace read permission denied",
                ),
                FileSystemError::InvalidPath(_) => (
                    HostErrorCode::InvalidRequest,
                    "path is outside the authorized workspace",
                ),
                FileSystemError::ReadLimitExceeded { .. } => (
                    HostErrorCode::QuotaExceeded,
                    "file exceeds the SDK read limit",
                ),
                FileSystemError::NotFound(_) => (
                    HostErrorCode::InvalidRequest,
                    "workspace file does not exist",
                ),
                FileSystemError::NotFile(_) => (
                    HostErrorCode::InvalidRequest,
                    "workspace path is not a file",
                ),
                FileSystemError::NotDirectory(_)
                | FileSystemError::WriteLimitExceeded { .. }
                | FileSystemError::RevisionConflict(_)
                | FileSystemError::ReadOnly(_)
                | FileSystemError::AlreadyExists(_)
                | FileSystemError::ElevationDenied
                | FileSystemError::ElevationUnavailable
                | FileSystemError::ElevationTimedOut
                | FileSystemError::ElevationFailed
                | FileSystemError::Cancelled
                | FileSystemError::WriteOutcomeUnknown
                | FileSystemError::Io(_) => (HostErrorCode::Internal, "workspace read failed"),
            };
            failure(code, message)
        })?;
    if token.is_cancelled() {
        return Err(failure(
            HostErrorCode::Cancelled,
            "extension request cancelled",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| failure(HostErrorCode::InvalidRequest, "workspace file is not UTF-8"))?;
    let result = ExtensionClientResult::File { text };
    // Escaped control characters can exceed the wire quota even within the disk byte limit.
    let encoded = serde_json::to_vec(&result)
        .map_err(|_| failure(HostErrorCode::Internal, "workspace result encoding failed"))?;
    if encoded.len() > extension_protocol::ProtocolLimits::default().maximum_payload_bytes {
        return Err(failure(
            HostErrorCode::QuotaExceeded,
            "file exceeds the SDK response limit",
        ));
    }
    Ok(result)
}

fn failure(code: HostErrorCode, message: &str) -> HostFailure {
    HostFailure {
        code,
        message: message.into(),
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

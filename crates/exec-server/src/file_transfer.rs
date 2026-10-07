//! Revision-pinned reads and bounded uploads owned by the execution host.

use crate::Error;
use ash_async_utils::CancellationToken;
use ash_file_access::Permission;
use ash_file_system::FileSystem;
use ash_file_system::FileWriteCondition;
use ash_file_system::LocalFileSystem;
use exec_server_protocol::ExecError;
use exec_server_protocol::FileChunk;
use exec_server_protocol::FileContent;
use exec_server_protocol::FileWriteState;
use exec_server_protocol::MAX_FILE_BYTES;
use exec_server_protocol::MAX_FILE_CHUNK_BYTES;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use exec_server_protocol::WriteCondition;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 1024;
const UPLOAD_LIFETIME: Duration = Duration::from_secs(60);
const RESULT_LIFETIME: Duration = Duration::from_secs(60 * 60);

struct Upload {
    path: String,
    total_bytes: usize,
    condition: WriteCondition,
    content_revision: String,
    bytes: Vec<u8>,
    state: FileWriteState,
    updated: Instant,
}

#[derive(Default)]
pub(super) struct FileTransfers {
    uploads: Mutex<BTreeMap<String, Upload>>,
}

impl FileTransfers {
    pub(super) fn read(
        &self,
        files: &LocalFileSystem,
        path: &str,
        offset: u64,
        expected_revision: Option<&str>,
    ) -> Result<FileChunk, ExecError> {
        exec_server_protocol::validate_path(path)?;
        if offset > MAX_FILE_BYTES as u64 || (offset != 0 && expected_revision.is_none()) {
            return Err(ExecError::InvalidInput);
        }
        let content = files
            .read_file_with_revision(Path::new(path), MAX_FILE_BYTES)
            .map_err(file_error)?;
        if expected_revision.is_some_and(|revision| revision != content.revision) {
            return Err(ExecError::Conflict);
        }
        let offset = offset as usize;
        if offset > content.bytes.len() {
            return Err(ExecError::InvalidInput);
        }
        let end = (offset + MAX_FILE_CHUNK_BYTES).min(content.bytes.len());
        Ok(FileChunk {
            bytes: content.bytes[offset..end].to_vec(),
            revision: content.revision,
            offset: offset as u64,
            total_bytes: content.bytes.len() as u64,
        })
    }

    pub(super) fn write(
        &self,
        files: &LocalFileSystem,
        request: Request,
    ) -> Result<FileWriteState, ExecError> {
        let operation_id = match &request {
            Request::FileWriteBegin { operation_id, .. }
            | Request::FileWriteChunk { operation_id, .. }
            | Request::FileWriteCommit { operation_id }
            | Request::FileWriteAbort { operation_id }
            | Request::FileWriteStatus { operation_id } => operation_id,
            Request::EnvironmentInfo
            | Request::ProcessStart(_)
            | Request::ProcessRead(_)
            | Request::ProcessCancel { .. }
            | Request::ProcessWrite { .. }
            | Request::ProcessResize { .. }
            | Request::ProcessInterrupt { .. }
            | Request::ProcessCloseInput { .. }
            | Request::FileRead { .. } => {
                unreachable!("only file upload requests enter this handler")
            }
        };
        exec_server_protocol::validate_id(operation_id)?;
        let mut uploads = self.uploads.lock().map_err(|_| ExecError::Busy)?;
        expire(&mut uploads, Instant::now());
        if let Request::FileWriteBegin {
            operation_id,
            path,
            total_bytes,
            content_revision,
            condition,
        } = request
        {
            exec_server_protocol::validate_path(&path)?;
            if total_bytes > MAX_FILE_BYTES as u64
                || !crate::transport::valid_token(&content_revision)
                || matches!(&condition, WriteCondition::ExpectedRevision(revision) if !crate::transport::valid_token(revision))
            {
                return Err(ExecError::InvalidInput);
            }
            files
                .ensure_permission(Permission::WriteFiles)
                .map_err(file_error)?;
            if let Some(upload) = uploads.get(&operation_id) {
                if upload.path != path
                    || upload.total_bytes as u64 != total_bytes
                    || upload.condition != condition
                    || upload.content_revision != content_revision
                {
                    return Err(ExecError::Conflict);
                }
                return Ok(upload.state.clone());
            }
            let reserved: usize = uploads
                .values()
                .filter(|upload| matches!(upload.state, FileWriteState::Uploading { .. }))
                .map(|upload| upload.total_bytes)
                .sum();
            if uploads.len() >= MAX_RECORDS || reserved + total_bytes as usize > MAX_UPLOAD_BYTES {
                return Err(ExecError::Busy);
            }
            let state = FileWriteState::Uploading { next_offset: 0 };
            uploads.insert(
                operation_id,
                Upload {
                    path,
                    total_bytes: total_bytes as usize,
                    condition,
                    content_revision,
                    bytes: Vec::with_capacity(total_bytes as usize),
                    state: state.clone(),
                    updated: Instant::now(),
                },
            );
            return Ok(state);
        }
        let upload = uploads.get_mut(operation_id).ok_or(ExecError::NotFound)?;
        match request {
            Request::FileWriteChunk { offset, bytes, .. } => {
                if bytes.is_empty() || bytes.len() > MAX_FILE_CHUNK_BYTES {
                    return Err(ExecError::InvalidInput);
                }
                if !matches!(upload.state, FileWriteState::Uploading { .. })
                    || offset != upload.bytes.len() as u64
                    || bytes.len() > upload.total_bytes - upload.bytes.len()
                {
                    return Err(ExecError::Conflict);
                }
                upload.bytes.extend_from_slice(&bytes);
                upload.state = FileWriteState::Uploading {
                    next_offset: upload.bytes.len() as u64,
                };
                upload.updated = Instant::now();
            }
            Request::FileWriteCommit { .. } => {
                if matches!(upload.state, FileWriteState::Uploading { .. }) {
                    if upload.bytes.len() != upload.total_bytes {
                        return Err(ExecError::Conflict);
                    }
                    let condition = match &upload.condition {
                        WriteCondition::MissingOrEmpty => FileWriteCondition::MissingOrEmpty,
                        WriteCondition::ExpectedRevision(revision) => {
                            FileWriteCondition::ExpectedRevision(revision.clone())
                        }
                    };
                    // The revision check and publication share the filesystem owner's write lock.
                    // Keep the terminal receipt so a lost response can be observed without publishing again.
                    upload.state = if ash_file_system::file_revision(&upload.bytes)
                        != upload.content_revision
                    {
                        FileWriteState::Rejected {
                            error: ExecError::Conflict,
                        }
                    } else {
                        match files.write_file_with_condition(
                            Path::new(&upload.path),
                            &upload.bytes,
                            MAX_FILE_BYTES,
                            &condition,
                        ) {
                            Ok(_) => FileWriteState::Committed {
                                revision: upload.content_revision.clone(),
                            },
                            // The filesystem contract can fail while reading metadata after
                            // publication. An IO error therefore cannot prove the file was unchanged.
                            Err(ash_file_system::FileSystemError::Io(_)) => {
                                FileWriteState::OutcomeUnknown
                            }
                            Err(error) => FileWriteState::Rejected {
                                error: file_error(error),
                            },
                        }
                    };
                    upload.bytes = Vec::new();
                    upload.updated = Instant::now();
                }
            }
            Request::FileWriteAbort { .. } => {
                if matches!(upload.state, FileWriteState::Uploading { .. }) {
                    upload.bytes = Vec::new();
                    upload.state = FileWriteState::Aborted;
                    upload.updated = Instant::now();
                }
            }
            Request::FileWriteStatus { .. } => {}
            Request::FileWriteBegin { .. }
            | Request::EnvironmentInfo
            | Request::ProcessStart(_)
            | Request::ProcessRead(_)
            | Request::ProcessCancel { .. }
            | Request::ProcessWrite { .. }
            | Request::ProcessResize { .. }
            | Request::ProcessInterrupt { .. }
            | Request::ProcessCloseInput { .. }
            | Request::FileRead { .. } => {
                unreachable!("begin is handled before looking up an upload")
            }
        }
        Ok(upload.state.clone())
    }
}

fn expire(uploads: &mut BTreeMap<String, Upload>, now: Instant) {
    for upload in uploads.values_mut() {
        if matches!(upload.state, FileWriteState::Uploading { .. })
            && now.duration_since(upload.updated) >= UPLOAD_LIFETIME
        {
            upload.bytes = Vec::new();
            upload.state = FileWriteState::Aborted;
            upload.updated = now;
        }
    }
    uploads.retain(|_, upload| now.duration_since(upload.updated) < RESULT_LIFETIME);
}

pub(super) fn read_file(
    request: impl Fn(Request) -> Result<Response, Error>,
    path: &str,
    cancellation: &CancellationToken,
) -> Result<FileContent, Error> {
    exec_server_protocol::validate_path(path).map_err(Error::Remote)?;
    let mut bytes = Vec::new();
    let mut revision = None;
    let mut size = None;
    loop {
        check_cancelled(cancellation)?;
        let Response::File(chunk) = request(Request::FileRead {
            path: path.into(),
            offset: bytes.len() as u64,
            expected_revision: revision.clone(),
        })?
        else {
            return Err(Error::Protocol);
        };
        if chunk.offset != bytes.len() as u64
            || chunk.total_bytes > MAX_FILE_BYTES as u64
            || chunk.bytes.len() > MAX_FILE_CHUNK_BYTES
            || chunk.offset + chunk.bytes.len() as u64 > chunk.total_bytes
            || (chunk.bytes.is_empty() && chunk.offset != chunk.total_bytes)
            || revision
                .as_ref()
                .is_some_and(|revision| revision != &chunk.revision)
            || size.is_some_and(|size| size != chunk.total_bytes)
            || !crate::transport::valid_token(&chunk.revision)
        {
            return Err(Error::Protocol);
        }
        size = Some(chunk.total_bytes);
        revision = Some(chunk.revision);
        bytes.extend(chunk.bytes);
        if bytes.len() as u64 == chunk.total_bytes {
            let revision = revision.expect("a completed read has a revision");
            if ash_file_system::file_revision(&bytes) != revision {
                return Err(Error::Protocol);
            }
            return Ok(FileContent { bytes, revision });
        }
    }
}

pub(super) fn write_file(
    request: impl Fn(Request) -> Result<Response, Error>,
    operation_id: &str,
    path: &str,
    bytes: &[u8],
    condition: WriteCondition,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    exec_server_protocol::validate_id(operation_id).map_err(Error::Remote)?;
    exec_server_protocol::validate_path(path).map_err(Error::Remote)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(Error::Remote(ExecError::InvalidInput));
    }
    check_cancelled(cancellation)?;
    let state = request(Request::FileWriteBegin {
        operation_id: operation_id.into(),
        path: path.into(),
        total_bytes: bytes.len() as u64,
        content_revision: ash_file_system::file_revision(bytes),
        condition,
    })
    .and_then(write_state)
    .map_err(upload_error)?;
    match state {
        FileWriteState::Uploading { next_offset: 0 } => {}
        state => return committed(state, bytes),
    }
    for (index, chunk) in bytes.chunks(MAX_FILE_CHUNK_BYTES).enumerate() {
        if let Err(error) = check_cancelled(cancellation) {
            let _ = request(Request::FileWriteAbort {
                operation_id: operation_id.into(),
            });
            return Err(error);
        }
        let offset = index * MAX_FILE_CHUNK_BYTES;
        let state = request(Request::FileWriteChunk {
            operation_id: operation_id.into(),
            offset: offset as u64,
            bytes: chunk.to_vec(),
        })
        .and_then(write_state)
        .map_err(upload_error)?;
        if state
            != (FileWriteState::Uploading {
                next_offset: (offset + chunk.len()) as u64,
            })
        {
            return Err(Error::Protocol);
        }
    }
    if let Err(error) = check_cancelled(cancellation) {
        let _ = request(Request::FileWriteAbort {
            operation_id: operation_id.into(),
        });
        return Err(error);
    }
    let response = request(Request::FileWriteCommit {
        operation_id: operation_id.into(),
    });
    let response = match response {
        // Observation is safe after a lost commit response; no begin/chunk/commit is repeated.
        Err(Error::Transport(error)) => match request(Request::FileWriteStatus {
            operation_id: operation_id.into(),
        }) {
            Ok(Response::FileWrite(
                state @ (FileWriteState::Committed { .. }
                | FileWriteState::Rejected { .. }
                | FileWriteState::OutcomeUnknown
                | FileWriteState::Aborted),
            )) => Response::FileWrite(state),
            _ => return Err(Error::Transport(error)),
        },
        response => response?,
    };
    committed(write_state(response)?, bytes)
}

fn write_state(response: Response) -> Result<FileWriteState, Error> {
    match response {
        Response::FileWrite(state) => Ok(state),
        _ => Err(Error::Protocol),
    }
}

fn upload_error(error: Error) -> Error {
    // Only Commit can publish. Losing a Begin/Chunk response can leave upload resources,
    // but cannot make the destination file's contents uncertain.
    match error {
        Error::Transport(_) | Error::Protocol => Error::FileNotPublished(error.to_string()),
        Error::Remote(_)
        | Error::Cancelled(_)
        | Error::OutcomeUnknown
        | Error::FileNotPublished(_) => error,
    }
}
fn committed(state: FileWriteState, bytes: &[u8]) -> Result<(), Error> {
    match state {
        FileWriteState::Committed { revision }
            if revision == ash_file_system::file_revision(bytes) =>
        {
            Ok(())
        }
        FileWriteState::Rejected { error } => Err(Error::Remote(error)),
        FileWriteState::OutcomeUnknown => Err(Error::OutcomeUnknown),
        FileWriteState::Aborted => Err(Error::Remote(ExecError::Conflict)),
        FileWriteState::Uploading { .. } | FileWriteState::Committed { .. } => Err(Error::Protocol),
    }
}
fn check_cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    cancellation
        .check()
        .map_err(|signal| Error::Cancelled(signal.reason().to_string()))
}

pub(super) fn file_error(error: ash_file_system::FileSystemError) -> ExecError {
    // Host paths and platform diagnostics stay on the execution host; callers use stable categories.
    match error {
        ash_file_system::FileSystemError::PermissionDenied(_)
        | ash_file_system::FileSystemError::ReadOnly(_) => ExecError::PermissionDenied,
        ash_file_system::FileSystemError::InvalidPath(_)
        | ash_file_system::FileSystemError::NotFile(_)
        | ash_file_system::FileSystemError::NotDirectory(_)
        | ash_file_system::FileSystemError::ReadLimitExceeded { .. }
        | ash_file_system::FileSystemError::WriteLimitExceeded { .. } => ExecError::InvalidInput,
        ash_file_system::FileSystemError::RevisionConflict(_)
        | ash_file_system::FileSystemError::AlreadyExists(_) => ExecError::Conflict,
        ash_file_system::FileSystemError::NotFound(_) => ExecError::NotFound,
        ash_file_system::FileSystemError::Io(_) => ExecError::Io,
    }
}

#[cfg(test)]
#[path = "file_transfer_tests.rs"]
mod tests;

//! The two speech resources belong to the selected backend Profile, independently of Sessions.
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::speech::SpeechInstructionKind;
use ash_app_server_protocol::protocol::speech::SpeechInstructionsDocument;
use ash_app_server_protocol::protocol::speech::SpeechInstructionsReadParams;
use ash_app_server_protocol::protocol::speech::SpeechInstructionsWriteParams;
use ash_app_server_protocol::protocol::speech::SpeechInstructionsWriteResult;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::PathAccessPolicy;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::FileMutation;
use ash_file_system::FileSystemError;
use ash_file_system::LocalFileSystem;
use serde_json::Value;
use std::path::Path;

pub(super) const MAX_BYTES: usize = 64 * 1024;

pub(super) enum Operation {
    Read,
    Write,
}

pub(super) struct Instructions {
    pub text: String,
    pub revision: String,
    pub exists: bool,
}

fn filename(kind: SpeechInstructionKind) -> &'static str {
    match kind {
        SpeechInstructionKind::Voice => "voice.md",
        SpeechInstructionKind::Dictation => "dictation.md",
    }
}

pub(super) fn read(
    root: &Path,
    kind: SpeechInstructionKind,
) -> Result<Instructions, FileSystemError> {
    let dir = Dir::open_local(root).map_err(|error| FileSystemError::Io(error.to_string()))?;
    let handle = dir.directory().handle();
    let path = Path::new(filename(kind));
    let metadata = match handle.symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Instructions {
                text: String::new(),
                revision: "missing".into(),
                exists: false,
            });
        }
        Err(error) => return Err(FileSystemError::Io(error.to_string())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(FileSystemError::NotFile(path.into()));
    }
    // Reuse the filesystem owner's no-follow open and stable read observation.
    let policy =
        PathAccessPolicy::for_exact_file(path).map_err(FileSystemError::PermissionDenied)?;
    let files = LocalFileSystem::new(
        Grant::for_environment(
            dir,
            GrantSource::HostConfiguration,
            Permissions::new([Permission::ReadFiles]),
        )
        .with_path_policy(policy),
    );
    let snapshot = files.read_file_snapshot(path, MAX_BYTES)?;
    let revision = snapshot.content().revision.clone();
    let text = String::from_utf8(snapshot.content().bytes.clone())
        .map_err(|_| FileSystemError::Io("Speech instructions must be UTF-8 Markdown".into()))?;
    Ok(Instructions {
        text,
        revision,
        exists: true,
    })
}

pub(super) fn write(
    root: &Path,
    kind: SpeechInstructionKind,
    text: &str,
    expected: &str,
) -> Result<String, FileSystemError> {
    if text.len() > MAX_BYTES {
        return Err(FileSystemError::WriteLimitExceeded {
            maximum_bytes: MAX_BYTES,
        });
    }
    let path = Path::new(filename(kind));
    let current = read(root, kind)?;
    if current.revision != expected {
        return Err(FileSystemError::RevisionConflict(path.into()));
    }
    let dir = Dir::open_local(root).map_err(|error| FileSystemError::Io(error.to_string()))?;
    let mutation = if current.exists {
        FileMutation::Replace {
            path: path.into(),
            content: text.as_bytes().to_vec(),
            expected_revision: expected.into(),
        }
    } else {
        FileMutation::Create {
            path: path.into(),
            content: text.as_bytes().to_vec(),
        }
    };
    let policy =
        PathAccessPolicy::for_exact_file(path).map_err(FileSystemError::PermissionDenied)?;
    ash_file_system::commit_file_mutations(&dir, &[mutation], &policy)
        .map_err(|error| error.source)?;
    Ok(ash_file_system::file_revision(text.as_bytes()))
}

/// Product hosts edit their own speech Profile; an Agent or browser client cannot read it.
pub(super) fn request(
    home: Option<&ash_home::AshHome>,
    connection: &ConnectionState,
    operation: Operation,
    params: &Value,
) -> Result<Value, RpcError> {
    if !connection.allows_local_media() {
        return Err(RpcError::new(
            -32073,
            AppServerErrorName::PermissionRequired,
        ));
    }
    let home =
        home.ok_or_else(|| RpcError::new(-32000, AppServerErrorName::FileSystemUnavailable))?;
    match operation {
        Operation::Read => {
            let params: SpeechInstructionsReadParams = decode(params)?;
            let document = read(home.root(), params.kind).map_err(rpc_error)?;
            result(&SpeechInstructionsDocument {
                text: document.text,
                revision: document.revision,
                exists: document.exists,
            })
        }
        Operation::Write => {
            let params: SpeechInstructionsWriteParams = decode(params)?;
            let revision = write(
                home.root(),
                params.kind,
                &params.text,
                &params.expected_revision,
            )
            .map_err(rpc_error)?;
            result(&SpeechInstructionsWriteResult { revision })
        }
    }
}

fn rpc_error(error: FileSystemError) -> RpcError {
    let name = if matches!(
        error,
        FileSystemError::RevisionConflict(_) | FileSystemError::AlreadyExists(_)
    ) {
        AppServerErrorName::FileSystemRevisionConflict
    } else {
        AppServerErrorName::FileSystemOperationFailed
    };
    RpcError::with_details(-32000, name, error.to_string())
}

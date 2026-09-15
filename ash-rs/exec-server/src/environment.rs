use crate::Error;
use crate::ExecClient;
use crate::process::Processes;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::FileSystem;
use ash_file_system::FileWriteCondition;
use ash_file_system::LocalFileSystem;
use ash_sandboxing::SandboxBackend;
use exec_server_protocol::EnvironmentInfo;
use exec_server_protocol::ExecError;
use exec_server_protocol::FileAccess;
use exec_server_protocol::FileContent;
use exec_server_protocol::NetworkAccess;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use exec_server_protocol::WriteCondition;
use std::path::Path;
use std::sync::Arc;

/// Host-owned authority and resources for exactly one execution root.
/// Its grant is constructed on this host; no client can supply or expand that grant.
pub struct LocalEnvironment {
    info: EnvironmentInfo,
    files: LocalFileSystem,
    processes: Processes,
}

impl LocalEnvironment {
    pub fn open(
        id: String,
        root: &Path,
        access: FileAccess,
        network: NetworkAccess,
        backend: Arc<dyn SandboxBackend>,
    ) -> Result<Self, Error> {
        exec_server_protocol::validate_id(&id).map_err(Error::Remote)?;
        let dir = Dir::open_local(root).map_err(|_| Error::Remote(ExecError::InvalidInput))?;
        let permissions = match access {
            FileAccess::ReadOnly => vec![Permission::ReadFiles, Permission::ExecuteCommands],
            FileAccess::ReadWrite => vec![
                Permission::ReadFiles,
                Permission::WriteFiles,
                Permission::ExecuteCommands,
            ],
        };
        let grant = Grant::for_environment(
            dir.clone(),
            GrantSource::HostConfiguration,
            Permissions::new(permissions),
        );
        let info = EnvironmentInfo {
            environment_id: id,
            incarnation: crate::random_id()?,
            root: dir
                .canonical_path()
                .to_str()
                .ok_or(Error::Remote(ExecError::InvalidInput))?
                .into(),
            access,
            network,
        };
        Ok(Self {
            processes: Processes::new(grant.clone(), access, network, backend),
            files: LocalFileSystem::new(grant),
            info,
        })
    }

    pub fn info(&self) -> &EnvironmentInfo {
        &self.info
    }

    pub fn request(&self, request: Request) -> Response {
        match self.dispatch(request) {
            Ok(response) => response,
            Err(error) => Response::Error(error),
        }
    }

    fn dispatch(&self, request: Request) -> Result<Response, ExecError> {
        match request {
            Request::EnvironmentInfo => Ok(Response::Environment(self.info.clone())),
            Request::ProcessStart(params) => self.processes.start(params).map(Response::Process),
            Request::ProcessRead(params) => self.processes.read(&params).map(Response::Process),
            Request::ProcessCancel { operation_id } => {
                self.processes.cancel(&operation_id).map(Response::Process)
            }
            Request::ProcessWrite {
                operation_id,
                bytes,
            } => self
                .processes
                .write(&operation_id, bytes)
                .map(|()| Response::ProcessUpdated),
            Request::ProcessCloseInput { operation_id } => self
                .processes
                .close_input(&operation_id)
                .map(|()| Response::ProcessUpdated),
            Request::FileRead { path } => {
                exec_server_protocol::validate_path(&path)?;
                let content = self
                    .files
                    .read_file_with_revision(Path::new(&path), exec_server_protocol::MAX_FILE_BYTES)
                    .map_err(file_error)?;
                Ok(Response::File(FileContent {
                    bytes: content.bytes,
                    revision: content.revision,
                }))
            }
            Request::FileWrite {
                path,
                bytes,
                condition,
            } => {
                exec_server_protocol::validate_path(&path)?;
                if bytes.len() > exec_server_protocol::MAX_FILE_BYTES {
                    return Err(ExecError::InvalidInput);
                }
                let condition = match condition {
                    WriteCondition::MissingOrEmpty => FileWriteCondition::MissingOrEmpty,
                    WriteCondition::ExpectedRevision(value) => {
                        FileWriteCondition::ExpectedRevision(value)
                    }
                };
                self.files
                    .write_file_with_condition(
                        Path::new(&path),
                        &bytes,
                        exec_server_protocol::MAX_FILE_BYTES,
                        &condition,
                    )
                    .map_err(file_error)?;
                Ok(Response::Written)
            }
        }
    }
}

fn file_error(error: ash_file_system::FileSystemError) -> ExecError {
    // The wire exposes stable categories, never host paths or platform error text.
    match error {
        ash_file_system::FileSystemError::PermissionDenied(_) => ExecError::PermissionDenied,
        ash_file_system::FileSystemError::InvalidPath(_)
        | ash_file_system::FileSystemError::NotFile(_)
        | ash_file_system::FileSystemError::NotDirectory(_)
        | ash_file_system::FileSystemError::ReadLimitExceeded { .. }
        | ash_file_system::FileSystemError::WriteLimitExceeded { .. } => ExecError::InvalidInput,
        ash_file_system::FileSystemError::RevisionConflict(_)
        | ash_file_system::FileSystemError::AlreadyExists(_) => ExecError::Conflict,
        ash_file_system::FileSystemError::NotFound(_) => ExecError::NotFound,
        ash_file_system::FileSystemError::ReadOnly(_) => ExecError::PermissionDenied,
        ash_file_system::FileSystemError::Io(_) => ExecError::Io,
    }
}

/// One explicit execution target. Local calls use the same handler without serialization.
#[derive(Clone)]
pub enum ExecutionEnvironment {
    Local(Arc<LocalEnvironment>),
    Remote(ExecClient),
}

impl ExecutionEnvironment {
    pub fn info(&self) -> &EnvironmentInfo {
        match self {
            Self::Local(local) => local.info(),
            Self::Remote(remote) => remote.info(),
        }
    }

    pub fn request(&self, request: Request) -> Result<Response, Error> {
        let response = match self {
            Self::Local(local) => local.request(request),
            Self::Remote(remote) => remote.request(request)?,
        };
        match response {
            Response::Error(error) => Err(Error::Remote(error)),
            response => Ok(response),
        }
    }
}

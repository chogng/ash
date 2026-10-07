use crate::Error;
use crate::ExecClient;
use crate::process::Processes;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::LocalFileSystem;
use ash_sandboxing::SandboxBackend;
use exec_server_protocol::EnvironmentInfo;
use exec_server_protocol::ExecError;
use exec_server_protocol::FileAccess;
use exec_server_protocol::NetworkAccess;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use std::path::Path;
use std::sync::Arc;

/// Host-owned authority and resources for exactly one execution root.
/// Its grant is constructed on this host; no client can supply or expand that grant.
pub struct LocalEnvironment {
    info: EnvironmentInfo,
    files: LocalFileSystem,
    transfers: crate::file_transfer::FileTransfers,
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
            transfers: Default::default(),
            info,
        })
    }

    pub fn info(&self) -> &EnvironmentInfo {
        &self.info
    }

    /// Active commands keep the execution host alive after the last transport disconnects.
    pub fn has_active_processes(&self) -> Result<bool, Error> {
        self.processes.has_active().map_err(Error::Remote)
    }

    /// Explicit host shutdown cancels resources; closing a transport does not.
    pub fn cancel_processes(&self) -> Result<(), Error> {
        self.processes.cancel_all().map_err(Error::Remote)
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
            Request::ProcessResize {
                operation_id,
                rows,
                cols,
            } => self
                .processes
                .resize(&operation_id, rows, cols)
                .map(|()| Response::ProcessUpdated),
            Request::ProcessInterrupt { operation_id } => self
                .processes
                .interrupt(&operation_id)
                .map(|()| Response::ProcessUpdated),
            Request::ProcessCloseInput { operation_id } => self
                .processes
                .close_input(&operation_id)
                .map(|()| Response::ProcessUpdated),
            Request::FileRead {
                path,
                offset,
                expected_revision,
            } => self
                .transfers
                .read(&self.files, &path, offset, expected_revision.as_deref())
                .map(Response::File),
            request @ (Request::FileWriteBegin { .. }
            | Request::FileWriteChunk { .. }
            | Request::FileWriteCommit { .. }
            | Request::FileWriteAbort { .. }
            | Request::FileWriteStatus { .. }) => self
                .transfers
                .write(&self.files, request)
                .map(Response::FileWrite),
        }
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

    /// Reads a complete file without combining bytes from different revisions.
    pub fn read_file(
        &self,
        path: &str,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<exec_server_protocol::FileContent, Error> {
        crate::file_transfer::read_file(|request| self.request(request), path, cancellation)
    }

    /// Uploads bounded ranges, then conditionally publishes once. Transport failures never replay a mutation.
    pub fn write_file(
        &self,
        operation_id: &str,
        path: &str,
        bytes: &[u8],
        condition: exec_server_protocol::WriteCondition,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<(), Error> {
        crate::file_transfer::write_file(
            |request| self.request(request),
            operation_id,
            path,
            bytes,
            condition,
            cancellation,
        )
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

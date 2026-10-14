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
    requirements: ash_config::PermissionRequirements,
    grant: Grant,
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
        let requirements = ash_config::load_system_permission_requirements()
            .map_err(|error| Error::Transport(std::io::Error::other(error.to_string())))?;
        let profile = requirements
            .values
            .constrain(
                ash_config::PermissionsConfig::default()
                    .resolve(":fullAccess")
                    .map_err(|error| Error::Transport(std::io::Error::other(error.to_string())))?,
            )
            .map_err(|error| Error::Transport(std::io::Error::other(error.to_string())))?;
        let constraints = exec_server_protocol::ExecutionConstraints {
            file_access: if profile.file_operations == ash_file_access::PathAccess::ReadOnly {
                FileAccess::ReadOnly
            } else {
                access
            },
            command_access: if profile.file_system == ash_protocol::SandboxMode::ReadOnly {
                FileAccess::ReadOnly
            } else {
                access
            },
            network: if requirements.values.maximum_network
                == Some(ash_config::CommandNetworkAccess::Denied)
            {
                NetworkAccess::Denied
            } else {
                network
            },
            host_read: profile.host_read,
            paths: profile.paths,
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
            network: constraints.network,
            access: constraints.file_access,
            constraints: constraints.clone(),
            permission_source: requirements.source.display().to_string(),
            permission_policy_revision: ash_protocol::ActionDigest::from_canonical_bytes(
                serde_json::to_vec(&requirements.values).map_err(|_| Error::Protocol)?,
            )
            .as_str()
            .to_owned(),
            allowed_approval_modes: requirements
                .values
                .allowed_approval_modes
                .clone()
                .unwrap_or_else(|| ash_protocol::ApprovalMode::ALL.to_vec()),
        };
        Ok(Self {
            processes: Processes::new(
                grant.clone(),
                access,
                network,
                backend,
                requirements.values.clone(),
            ),
            grant,
            requirements: requirements.values,
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

    fn enforce_requirements(&self, request: &Request) -> Result<(), ExecError> {
        use ash_protocol::ActionKind;
        use ash_protocol::CapabilityKind;
        let (kind, capability, path, command) = match request {
            Request::ProcessStart(start) => (
                ActionKind::LocalProcess(ash_protocol::ProcessInvocationKind::Direct),
                CapabilityKind::ProcessSpawn,
                start.cwd.clone(),
                Some(start),
            ),
            Request::FileRead { path, .. } => (
                ActionKind::SystemOperation,
                CapabilityKind::FileRead,
                path.clone(),
                None,
            ),
            Request::FileWriteBegin { path, .. } => (
                ActionKind::FileSystemMutation,
                CapabilityKind::FileWrite,
                path.clone(),
                None,
            ),
            Request::FileWriteCommit { operation_id }
            | Request::FileWriteChunk { operation_id, .. } => (
                ActionKind::FileSystemMutation,
                CapabilityKind::FileWrite,
                self.transfers.upload_path(operation_id)?,
                None,
            ),
            // Teardown and output retrieval never acquire new process or filesystem authority.
            Request::Constrained { .. }
            | Request::EnvironmentInfo
            | Request::FileReadRelease { .. }
            | Request::FileWriteAbort { .. }
            | Request::FileWriteStatus { .. }
            | Request::ProcessRead(_)
            | Request::ProcessCancel { .. }
            | Request::ProcessWrite { .. }
            | Request::ProcessResize { .. }
            | Request::ProcessInterrupt { .. }
            | Request::ProcessCloseInput { .. }
            | Request::ProcessNetworkRequests { .. }
            | Request::ResolveProcessNetworkRequest { .. } => return Ok(()),
        };
        let snapshot = ash_execpolicy::ExecPolicySnapshot::new(
            ash_execpolicy::ExecPolicyDefault::Continue,
            vec![
                self.requirements
                    .layer()
                    .map_err(|_| ExecError::PermissionDenied)?,
            ],
        )
        .map_err(|_| ExecError::PermissionDenied)?;
        let mut action = ash_action_policy::ResolvedAction::new(
            ash_protocol::ActionDigest::from_canonical_bytes(
                serde_json::to_vec(&(request, &self.info.incarnation))
                    .map_err(|_| ExecError::InvalidInput)?,
            ),
            kind,
            "execution-host operation",
            ash_protocol::CapabilitySet::new([ash_protocol::Capability::new(capability, path)]),
        );
        if let Some(command) = command {
            action = action.with_command(command.program.clone(), command.arguments.clone());
        }
        let review = ash_action_policy::ActionReviewRequest::new(
            action,
            ash_protocol::ActionProvenance::new(
                ash_protocol::ActionSource::BuiltInTool,
                "environment",
            ),
            match command {
                Some(_) => ash_action_policy::SandboxCompatibility::Supported(
                    ash_sandboxing::SandboxPolicy::new(
                        ash_sandboxing::FileSystemAccess::DirectoryWrite,
                        ash_sandboxing::NetworkAccess::Denied,
                    ),
                ),
                None => ash_action_policy::SandboxCompatibility::NotApplicable {
                    reason: "host-mediated file IO".into(),
                },
            },
            ash_protocol::ActionPolicyRevision::new(snapshot.revision().as_str()),
        );
        match ash_action_policy::decide_exec_policy(&snapshot, &review)
            .map_err(|_| ExecError::PermissionDenied)?
        {
            Some(
                ash_action_policy::ExecutionDecision::Block(_)
                | ash_action_policy::ExecutionDecision::AskUser(_)
                | ash_action_policy::ExecutionDecision::ReviseAction(_)
                | ash_action_policy::ExecutionDecision::RunAutoReviewed(_)
                | ash_action_policy::ExecutionDecision::RunWithPermissionBypass(_),
            ) => Err(ExecError::PermissionDenied),
            // Every launched process receives the stricter effective kernel policy and path scope.
            None
            | Some(
                ash_action_policy::ExecutionDecision::RunSandboxed(_)
                | ash_action_policy::ExecutionDecision::RunUnsandboxed { .. }
                | ash_action_policy::ExecutionDecision::RunExecPolicyGranted(_),
            ) => Ok(()),
        }
    }

    fn dispatch(&self, request: Request) -> Result<Response, ExecError> {
        self.dispatch_constrained(request, &self.info.constraints)
    }

    fn dispatch_constrained(
        &self,
        request: Request,
        constraints: &exec_server_protocol::ExecutionConstraints,
    ) -> Result<Response, ExecError> {
        self.enforce_requirements(&request)?;
        let files = LocalFileSystem::new(
            self.grant
                .clone()
                .with_path_policy(constraints.path_policy()?),
        );
        match request {
            Request::Constrained {
                constraints: requested,
                request,
            } => {
                requested.validate()?;
                // Reject nested envelopes so bounded transport input cannot create unbounded recursion.
                if matches!(*request, Request::Constrained { .. }) {
                    return Err(ExecError::InvalidInput);
                }
                let effective = self.info.constraints.intersect(&requested);
                effective.validate()?;
                self.dispatch_constrained(*request, &effective)
            }
            Request::EnvironmentInfo => Ok(Response::Environment(self.info.clone())),
            Request::ProcessStart(params) => self
                .processes
                .start(params, constraints)
                .map(Response::Process),
            Request::ProcessRead(params) => self.processes.read(&params).map(Response::Process),
            Request::ProcessNetworkRequests { operation_id } => self
                .processes
                .network_requests(&operation_id)
                .map(Response::ProcessNetworkRequests),
            Request::ResolveProcessNetworkRequest {
                operation_id,
                request_id,
                allow,
            } => self
                .processes
                .resolve_network(&operation_id, &request_id, allow)
                .map(|()| Response::ProcessUpdated),
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
                .read(&files, &path, offset, expected_revision.as_deref())
                .map(Response::File),
            Request::FileReadRelease { path, revision } => self
                .transfers
                .release_read(&path, &revision)
                .map(|()| Response::FileReadReleased),
            request @ (Request::FileWriteBegin { .. }
            | Request::FileWriteChunk { .. }
            | Request::FileWriteCommit { .. }
            | Request::FileWriteAbort { .. }
            | Request::FileWriteStatus { .. }) => self
                .transfers
                .write(
                    &files,
                    request,
                    ash_protocol::ActionDigest::from_canonical_bytes(
                        serde_json::to_vec(&(constraints, &self.info.incarnation))
                            .map_err(|_| ExecError::InvalidInput)?,
                    )
                    .as_str(),
                )
                .map(Response::FileWrite),
        }
    }
}

/// One explicit execution target. Local calls use the same handler without serialization.
#[derive(Clone)]
pub enum ExecutionEnvironment {
    Local(Arc<LocalEnvironment>),
    Remote(ExecClient),
    Constrained {
        environment: Box<ExecutionEnvironment>,
        constraints: exec_server_protocol::ExecutionConstraints,
    },
}

impl ExecutionEnvironment {
    pub fn info(&self) -> &EnvironmentInfo {
        match self {
            Self::Local(local) => local.info(),
            Self::Remote(remote) => remote.info(),
            Self::Constrained { environment, .. } => environment.info(),
        }
    }

    /// Effective snapshot advertised to reviewers; source limits are never replaced by the client.
    pub fn constraints(&self) -> exec_server_protocol::ExecutionConstraints {
        match self {
            Self::Local(_) | Self::Remote(_) => self.info().constraints.clone(),
            Self::Constrained {
                environment,
                constraints,
            } => environment.constraints().intersect(constraints),
        }
    }

    /// Freezes caller intent for all chunks and retries of one admitted operation.
    pub fn constrained(
        self,
        constraints: exec_server_protocol::ExecutionConstraints,
    ) -> Result<Self, Error> {
        constraints.validate().map_err(Error::Remote)?;
        match self {
            Self::Constrained {
                environment,
                constraints: existing,
            } => Ok(Self::Constrained {
                environment,
                constraints: existing.intersect(&constraints),
            }),
            environment => Ok(Self::Constrained {
                environment: Box::new(environment),
                constraints,
            }),
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
            Self::Constrained {
                environment,
                constraints,
            } => {
                return environment.request(Request::Constrained {
                    constraints: constraints.clone(),
                    request: Box::new(request),
                });
            }
        };
        match response {
            Response::Error(error) => Err(Error::Remote(error)),
            response => Ok(response),
        }
    }
}

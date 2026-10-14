//! Agent requests enter Core's durable interaction; this service issues only the approved ephemeral leases.
use super::*;
use ash_core::ToolInteractionService;
use ash_protocol::PermissionGrantDuration;
use ash_protocol::PermissionRequest;
use ash_protocol::RequestedDirectoryGrant;
use serde::Deserialize;

pub(super) struct PermissionRequests {
    pub(super) threads: Arc<ash_core::ThreadController>,
    pub(super) grants: Arc<DirGrants>,
    pub(super) authorization: Authorization,
    pub(super) profile: ash_config::ResolvedPermissionProfile,
    pub(super) requirements: ash_config::PermissionRequirements,
    pub(super) revision: ActionPolicyRevision,
    pub(super) enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    duration: PermissionGrantDuration,
    directories: Vec<RequestedDirectoryGrant>,
    network_hosts: Vec<String>,
    reason: String,
}

impl PermissionRequests {
    fn request(&self, call: &ToolCall) -> Result<(PermissionRequest, Vec<Dir>), CoreError> {
        if !self.enabled
            || self
                .requirements
                .approval_prompts
                .as_ref()
                .is_some_and(|controls| !controls.permission_requests)
        {
            return Err(CoreError::Policy(
                "permission requests are disabled by approval policy".into(),
            ));
        }
        let args: Arguments = serde_json::from_value(call.arguments.clone())
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        if args.reason.trim().is_empty()
            || args.reason.len() > 4096
            || args.directories.len() > 16
            || args.network_hosts.len() > 64
            || args.directories.is_empty() && args.network_hosts.is_empty()
        {
            return Err(CoreError::InvalidInput(
                "permission request is empty or exceeds its limits".into(),
            ));
        }
        let mut directories = Vec::new();
        let mut bindings = Vec::new();
        let mut identities = std::collections::BTreeSet::new();
        for entry in args.directories {
            if !Path::new(&entry.path).is_absolute()
                || entry.permissions.is_empty()
                || entry.permissions.len() > 15
            {
                return Err(CoreError::InvalidInput("permission request requires absolute directory paths and explicit capabilities".into()));
            }
            let dir = Dir::open_local(&entry.path)
                .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
            if !identities.insert(dir.id()) {
                return Err(CoreError::InvalidInput(
                    "duplicate permission request directory".into(),
                ));
            }
            let mut permissions = std::collections::BTreeSet::new();
            for permission in entry.permissions {
                if !permissions.insert(permission) {
                    return Err(CoreError::InvalidInput(
                        "duplicate requested capability".into(),
                    ));
                }
                if !matches!(
                    permission,
                    DirPermission::ReadFiles
                        | DirPermission::WriteFiles
                        | DirPermission::ExecuteCommands
                        | DirPermission::BrowseFiles
                        | DirPermission::SearchFiles
                ) {
                    return Err(CoreError::InvalidInput("Agent permission requests support file and process capabilities; service discovery remains with its host owner".into()));
                }
                if matches!(
                    permission,
                    DirPermission::WriteFiles | DirPermission::MutateRepository
                ) && (self.requirements.maximum_file_system
                    == Some(ash_protocol::SandboxMode::ReadOnly)
                    || self.profile.scope == ash_config::PermissionProfileScope::AllOperations
                        && self.profile.file_system == ash_protocol::SandboxMode::ReadOnly)
                {
                    return Err(CoreError::Policy(
                        "write permissions exceed the configured ceiling".into(),
                    ));
                }
            }
            directories.push(RequestedDirectoryGrant {
                path: dir
                    .canonical_path()
                    .to_str()
                    .ok_or_else(|| {
                        CoreError::InvalidInput("permission directory requires a UTF-8 path".into())
                    })?
                    .into(),
                permissions: permissions.into_iter().collect(),
            });
            bindings.push(dir);
        }
        let mut hosts = std::collections::BTreeSet::new();
        for host in args.network_hosts {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if host.len() > 253
                || host.is_empty()
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .chars()
                            .all(|character| character.is_ascii_alphanumeric() || character == '-')
                })
            {
                return Err(CoreError::InvalidInput(
                    "network permission hosts must be exact names".into(),
                ));
            }
            if !hosts.insert(host) {
                return Err(CoreError::InvalidInput(
                    "duplicate network permission host".into(),
                ));
            }
        }
        if !hosts.is_empty()
            && (self.requirements.maximum_network == Some(ash_config::CommandNetworkAccess::Denied)
                || self.profile.scope == ash_config::PermissionProfileScope::AllOperations
                    && self.profile.network == ash_config::CommandNetworkAccess::Denied)
        {
            return Err(CoreError::Policy(
                "network permissions exceed the configured ceiling".into(),
            ));
        }
        Ok((
            PermissionRequest {
                environment_id: self.authorization.dir().env().as_str().into(),
                duration: args.duration,
                directories,
                network_hosts: hosts.into_iter().collect(),
                reason: args.reason,
            },
            bindings,
        ))
    }

    pub(super) fn execute(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: &dyn ToolInteractionService,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.authorization
            .ensure_active()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Policy("permission request requires a durable caller".into())
        })?;
        let thread = self.threads.read_thread(identity.thread_id())?;
        if &thread.session_id != identity.session_id()
            || !thread.turns.iter().any(|turn| {
                &turn.turn_id == identity.turn_id()
                    && turn.status == ash_protocol::TurnStatus::Running
            })
        {
            return Err(CoreError::Policy(
                "permission request is outside the running Turn".into(),
            ));
        }
        let (request, bindings) = self.request(call)?;
        let response = interactions.request_permissions(request.clone())?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        self.authorization
            .ensure_active()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let Some(response) = response else {
            return Ok(ToolExecutionOutput::Success(
                json!({"granted":false}).to_string(),
            ));
        };
        if !request.accepts(&response) {
            return Err(CoreError::Policy(
                "approved permissions exceed the request".into(),
            ));
        }
        self.grants
            .grant_requested(
                identity.session_id().clone(),
                identity.thread_id().clone(),
                identity.turn_id().clone(),
                &response,
                &bindings,
            )
            .map_err(CoreError::Policy)?;
        Ok(ToolExecutionOutput::Success(json!({"granted":response.directories.iter().any(|entry| !entry.permissions.is_empty()) || !response.network_hosts.is_empty(), "permissions":response}).to_string()))
    }

    pub(super) fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let (request, bindings) = self.request(call)?;
        let canonical = serde_json::to_vec(&json!({"request":request,"directoryIds":bindings.iter().map(Dir::id).collect::<Vec<_>>()})).map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                "request temporary permissions",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "request_permissions"),
            SandboxCompatibility::NotApplicable {
                reason: "grants require the exact user's permission response".into(),
            },
            self.revision.clone(),
        ))
    }

    pub(super) fn definition() -> ToolDefinition {
        ToolDefinition { name: ash_protocol::ToolName::new("request_permissions").expect("static name"),
            description: "Request temporary directory capabilities or exact network hosts from the user. The user may approve a subset for this turn or this session. Policy ceilings remain enforced; grants expire and are not persisted.".into(),
            strict: true, parameters: json!({"type":"object","additionalProperties":false,"properties":{
                "duration":{"type":"string","enum":["turn","session"]},"reason":{"type":"string"},
                "directories":{"type":"array","maxItems":16,"items":{"type":"object","additionalProperties":false,"properties":{"path":{"type":"string"},"permissions":{"type":"array","items":{"enum":ash_protocol::DirectoryCapability::ALL.into_iter().filter(|permission| matches!(permission,
                    DirPermission::ReadFiles | DirPermission::WriteFiles | DirPermission::ExecuteCommands | DirPermission::BrowseFiles | DirPermission::SearchFiles)).collect::<Vec<_>>()}}},"required":["path","permissions"]}},
                "network_hosts":{"type":"array","maxItems":64,"items":{"type":"string"}}},"required":["duration","reason","directories","network_hosts"]}) }
    }
}

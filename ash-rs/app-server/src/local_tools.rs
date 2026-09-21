use ash_action_policy::ActionClassifier;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyEngine;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::AssessmentId;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ClassifierAssessment;
use ash_action_policy::ClassifierRecommendation;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ProcessInvocationKind;
use ash_action_policy::ResolvedAction;
use ash_action_policy::ReviewFailurePolicy;
use ash_action_policy::SandboxCompatibility;
use ash_apply_patch::ApplyPatchLimits;
use ash_apply_patch::ApplyPatchTool;
use ash_async_utils::CancellationToken;
use ash_config::DirExecPolicyConfig;
use ash_config::DirId;
use ash_config::ResolvedConfig;
use ash_config::UserExecPolicyConfig;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_execpolicy::ExecPolicyActionKind;
use ash_execpolicy::ExecPolicyDefault;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyLayer;
use ash_execpolicy::ExecPolicyLayerId;
use ash_execpolicy::ExecPolicyLayerKind;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_execpolicy::ExecPolicySelector;
use ash_execpolicy::ExecPolicySnapshot;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Permission as DirPermission;
use ash_install_context::ExecutableCandidates;
use ash_install_context::InstallContext;
use ash_install_context::ManagedExecutable;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolOutputStream;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::PatternMatchTiming;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxPathAccess;
use ash_sandboxing::SandboxPathRule;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_shell_command::ApprovalPolicy;
use ash_shell_command::ApprovalRequirement;
use ash_shell_command::CommandExecutionAuthority;
use ash_shell_command::CommandExecutionOutcome;
use ash_shell_command::ExecutionError;
use ash_shell_command::RipgrepDiscoveryError;
use ash_shell_command::RipgrepExecutable;
use ash_shell_command::ShellCommandLimits;
use ash_shell_command::ShellCommandRequest;
use ash_shell_command::ShellCommandTool;
use ash_tools::ToolPayload;
use ash_tools::to_protocol_tool_definition;
use core_api::ActionPolicyService;
use core_api::CoreError;
use serde_json::json;
use std::fmt;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use crate::dir_grants::DirGrants;
use crate::tool_composition::ToolCompositionError;
use crate::tool_composition::ToolPort;
use crate::tool_executor_adapter::PreparedToolExecution;
use crate::tool_executor_adapter::ToolExecutorReviewer;

mod grep_output;
mod suite;

pub(crate) use suite::LocalToolSuite;

const LOCAL_GRANT_SNAPSHOT_REVISION: &str = "local-static-grants-v1";
const LOCAL_REVIEWER_POLICY_REVISION: &str = "local-network-review-v6";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTPUT_BYTES: usize = 256 * 1024;

pub(crate) struct LocalToolComposition {
    pub(crate) tools: Arc<dyn ToolService>,
    pub(crate) policy: Arc<dyn ActionPolicyService>,
    action_policy_revision: ActionPolicyRevision,
    executors: Vec<LocalExecutorContribution>,
}

/// Durable configuration inputs used to compose the local Agent Tool suite.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct LocalToolConfig {
    user: UserExecPolicyConfig,
    dir_config: Option<(DirId, DirExecPolicyConfig)>,
}

impl LocalToolConfig {
    pub(crate) fn from_resolved(config: &ResolvedConfig) -> Self {
        Self {
            user: config.exec_policy.clone(),
            dir_config: config
                .dir_config
                .as_ref()
                .map(|dir| (dir.dir_id.clone(), dir.exec_policy.clone())),
        }
    }

    fn snapshot(&self) -> Result<ExecPolicySnapshot, LocalToolError> {
        ash_config::compose_exec_policy(
            ExecPolicyDefault::Deny("action is outside the local Tool policy contract".into()),
            vec![LOCAL_EXEC_POLICY_HOST_LAYER.clone()],
            &self.user,
            self.dir_config.as_ref().map(|(dir_id, dir)| (dir_id, dir)),
        )
        .map_err(LocalToolError::policy)
    }
}

struct LocalExecutorContribution {
    executor: Arc<dyn ash_tools::ToolExecutor>,
    environment_id: ash_tools::EnvId,
    reviewer: Arc<dyn ToolExecutorReviewer>,
}

pub(crate) fn compose_local_tools_with_config(
    grant: ash_file_access::Grant,
    config: &LocalToolConfig,
    dir_grants: Arc<DirGrants>,
    grep: Arc<grep::Service>,
    file_search: Arc<file_search::Service>,
    pty_helper: Option<&std::path::PathBuf>,
) -> Result<LocalToolComposition, LocalToolError> {
    let authorization = grant
        .authorize(DirPermission::ExecuteCommands)
        .map_err(|error| LocalToolError::permission(error.to_string()))?;
    let install_context = InstallContext::current();
    let sandbox = || {
        let sandbox = exec_server::LocalSandbox::new(install_context.clone());
        match pty_helper {
            Some(executable) => sandbox.with_pty_helper(executable.clone()).build(),
            None => sandbox.build(),
        }
    };
    let ripgrep = resolve_ripgrep(&install_context).map_err(LocalToolError::ripgrep)?;
    let environment_id = ash_tools::EnvId::local();
    let exec_policy = config.snapshot()?;
    let shell_policy = configured_shell_policy(&exec_policy);
    let action_policy_revision = ActionPolicyRevision::from_components(
        exec_policy.revision(),
        LOCAL_GRANT_SNAPSHOT_REVISION,
        LOCAL_REVIEWER_POLICY_REVISION,
    );
    let reviewer: Arc<dyn ToolExecutorReviewer> = Arc::new(LocalExecutorReviewer {
        shell_policy,
        authorization: authorization.clone(),
        ripgrep: ripgrep.clone(),
        action_policy_revision: action_policy_revision.clone(),
        dir_grants: Arc::clone(&dir_grants),
    });
    let shell_executor: Arc<dyn ash_tools::ToolExecutor> = Arc::new(
        ShellCommandTool::new(
            environment_id.clone(),
            authorization.dir().clone(),
            sandbox(),
            CoreAuthorized,
            ShellCommandLimits {
                timeout: DEFAULT_TIMEOUT,
                max_output_bytes: DEFAULT_OUTPUT_BYTES,
            },
        )
        .map_err(LocalToolError::definition)?,
    );
    let apply_patch_executor: Arc<dyn ash_tools::ToolExecutor> = Arc::new(
        ApplyPatchTool::new(
            environment_id.clone(),
            authorization.dir().clone(),
            ApplyPatchLimits::default(),
        )
        .map_err(LocalToolError::definition)?,
    );
    let policy = LocalShellPolicy {
        exec_policy,
        action_policy_revision: action_policy_revision.clone(),
    };
    let shell = LocalShellToolService::new_with_action_policy_revision(
        authorization.clone(),
        ripgrep.clone(),
        sandbox(),
        action_policy_revision.clone(),
        shell_policy,
    )?;
    let service = LocalToolSuite::new(shell, grep, file_search, dir_grants, grant);
    Ok(LocalToolComposition {
        tools: Arc::new(service),
        policy: Arc::new(policy),
        action_policy_revision,
        executors: vec![
            LocalExecutorContribution {
                executor: shell_executor,
                environment_id: environment_id.clone(),
                reviewer: Arc::clone(&reviewer),
            },
            LocalExecutorContribution {
                executor: apply_patch_executor,
                environment_id,
                reviewer,
            },
        ],
    })
}

impl LocalToolComposition {
    #[cfg(test)]
    pub(crate) fn without_executors(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        Self {
            tools,
            policy,
            action_policy_revision: local_policy_revision(),
            executors: Vec::new(),
        }
    }

    pub(crate) fn action_policy_revision(&self) -> &ActionPolicyRevision {
        &self.action_policy_revision
    }

    pub(crate) fn tool_port(&self) -> Result<ToolPort, ToolCompositionError> {
        let mut port = ToolPort::local(Arc::clone(&self.tools), Arc::clone(&self.policy));
        let local_definitions = self.tools.definitions();
        let shell_name =
            ash_protocol::ToolName::new("shell-command").expect("static local tool name is valid");
        if local_definitions
            .iter()
            .any(|definition| definition.name == shell_name)
        {
            port = port.with_tool_exposure(&shell_name, ash_tools::ToolExposure::Hidden)?;
        }
        for contribution in &self.executors {
            port = port.with_executor(
                Arc::clone(&contribution.executor),
                contribution.environment_id.clone(),
                Arc::clone(&contribution.reviewer),
            )?;
        }
        Ok(port)
    }
}

pub(crate) fn append_local_tool(
    composition: LocalToolComposition,
    tool: Arc<dyn ToolService>,
) -> LocalToolComposition {
    LocalToolComposition {
        tools: Arc::new(ExtendedLocalTools {
            primary: composition.tools,
            extension: tool,
        }),
        policy: composition.policy,
        action_policy_revision: composition.action_policy_revision,
        executors: composition.executors,
    }
}

struct ExtendedLocalTools {
    primary: Arc<dyn ToolService>,
    extension: Arc<dyn ToolService>,
}

impl ToolService for ExtendedLocalTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions = self.primary.definitions();
        definitions.extend(self.extension.definitions());
        definitions
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension.prepare(call)
        } else {
            self.primary.prepare(call)
        }
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension.prepare_with_facts(call, facts)
        } else {
            self.primary.prepare_with_facts(call, facts)
        }
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension.execute(call, authorization, cancellation)
        } else {
            self.primary.execute(call, authorization, cancellation)
        }
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension
                .execute_streaming(call, authorization, cancellation, sink)
        } else {
            self.primary
                .execute_streaming(call, authorization, cancellation, sink)
        }
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension
                .execute_with_facts(call, authorization, cancellation, facts)
        } else {
            self.primary
                .execute_with_facts(call, authorization, cancellation, facts)
        }
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension.execute_streaming_with_facts(
                call,
                authorization,
                cancellation,
                facts,
                sink,
            )
        } else {
            self.primary.execute_streaming_with_facts(
                call,
                authorization,
                cancellation,
                facts,
                sink,
            )
        }
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Arc<dyn ash_core::ToolInteractionService>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if self
            .extension
            .definitions()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            self.extension
                .execute_streaming_with_facts_and_interactions(
                    call,
                    authorization,
                    cancellation,
                    facts,
                    interactions,
                    sink,
                )
        } else {
            self.primary.execute_streaming_with_facts_and_interactions(
                call,
                authorization,
                cancellation,
                facts,
                interactions,
                sink,
            )
        }
    }
}

fn resolve_ripgrep(context: &InstallContext) -> Result<RipgrepExecutable, RipgrepDiscoveryError> {
    match context.executable_candidates(ManagedExecutable::Ripgrep) {
        ExecutableCandidates::ExplicitOverride(explicit_override) => {
            RipgrepExecutable::from_override(explicit_override.variable(), explicit_override.path())
        }
        ExecutableCandidates::SearchPaths(paths) => RipgrepExecutable::discover_candidates(paths),
    }
}

struct CoreAuthorized;

impl ApprovalPolicy for CoreAuthorized {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

struct LocalShellToolService<B> {
    authorization: Authorization,
    ripgrep: RipgrepExecutable,
    shell: ShellCommandTool<CoreAuthorized, B>,
    definition: ToolDefinition,
    action_policy_revision: ActionPolicyRevision,
    shell_policy: SandboxPolicy,
}

impl<B: SandboxBackend> LocalShellToolService<B> {
    #[cfg(all(test, unix))]
    fn new(
        authorization: Authorization,
        ripgrep: RipgrepExecutable,
        backend: B,
    ) -> Result<Self, LocalToolError> {
        Self::new_with_action_policy_revision(
            authorization,
            ripgrep,
            backend,
            local_policy_revision(),
            shell_sandbox(),
        )
    }

    fn new_with_action_policy_revision(
        authorization: Authorization,
        ripgrep: RipgrepExecutable,
        backend: B,
        action_policy_revision: ActionPolicyRevision,
        shell_policy: SandboxPolicy,
    ) -> Result<Self, LocalToolError> {
        let shell = ShellCommandTool::new(
            ash_tools::EnvId::local(),
            authorization.dir().clone(),
            backend,
            CoreAuthorized,
            ShellCommandLimits {
                timeout: DEFAULT_TIMEOUT,
                max_output_bytes: DEFAULT_OUTPUT_BYTES,
            },
        )
        .map_err(LocalToolError::definition)?;
        let definition = to_protocol_tool_definition(shell.host_definition())
            .map_err(LocalToolError::definition)?;
        Ok(Self {
            authorization,
            ripgrep,
            shell,
            definition,
            shell_policy,
            action_policy_revision,
        })
    }

    fn materialize(&self, call: &ToolCall) -> Result<ShellCommandRequest, CoreError> {
        self.materialize_in_dir(call, None)
    }

    fn materialize_in_dir(
        &self,
        call: &ToolCall,
        authorization: Option<&Authorization>,
    ) -> Result<ShellCommandRequest, CoreError> {
        self.authorization
            .ensure_active()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        if call.name != self.definition.name {
            return Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            )));
        }
        let request = ShellCommandRequest::from_arguments(&ToolPayload::FunctionArguments(
            call.arguments.clone(),
        ))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let selected_root = authorization
            .map(Authorization::dir)
            .unwrap_or_else(|| self.authorization.dir());
        let requested_directory = request.working_directory();
        let relative = if requested_directory.is_absolute() {
            requested_directory
                .strip_prefix(selected_root.canonical_path())
                .or_else(|_| requested_directory.strip_prefix(selected_root.requested_path()))
                .or_else(|_| {
                    requested_directory.strip_prefix(self.authorization.dir().canonical_path())
                })
                .or_else(|_| {
                    requested_directory.strip_prefix(self.authorization.dir().requested_path())
                })
                .map(Path::to_path_buf)
                .map_err(|_| {
                    CoreError::Policy(
                        "shell-command working directory is outside the Thread directory".into(),
                    )
                })?
        } else {
            requested_directory.to_path_buf()
        };
        self.materialize_at(request, selected_root, relative)
    }

    fn materialize_at(
        &self,
        mut request: ShellCommandRequest,
        selected_root: &Dir,
        relative: PathBuf,
    ) -> Result<ShellCommandRequest, CoreError> {
        request = request
            .with_working_directory(if relative.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                relative
            })
            .with_dir_root(selected_root.canonical_path());
        if request.program() == "rg" {
            validate_dir_arguments(selected_root, &request)?;
        }
        let working_directory = selected_root
            .resolve_existing(request.working_directory())
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        if !working_directory.is_dir() {
            return Err(CoreError::Policy(
                "shell-command working directory must be a directory".into(),
            ));
        }
        if request.program() == "rg" {
            self.ripgrep
                .materialize(request)
                .map_err(|error| CoreError::Policy(error.to_string()))
        } else {
            Ok(request)
        }
    }

    fn prepare_at(
        &self,
        call: &ToolCall,
        authorization: &Authorization,
        relative: PathBuf,
    ) -> Result<ActionReviewRequest, CoreError> {
        let request = ShellCommandRequest::from_arguments(&ToolPayload::FunctionArguments(
            call.arguments.clone(),
        ))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let request = self.materialize_at(request, authorization.dir(), relative)?;
        let scope = local_sandbox_scope(authorization.dir())?;
        self.review_request_scoped(&request, Some(&scope))
    }

    fn prepare_session_at(
        &self,
        request: ShellCommandRequest,
        authorization: &Authorization,
        relative: PathBuf,
    ) -> Result<ActionReviewRequest, CoreError> {
        let request = self.materialize_at(request, authorization.dir(), relative)?;
        let scope = local_sandbox_scope(authorization.dir())?;
        self.review_request_scoped(&request, Some(&scope))
    }

    fn execute_at(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        dir_authorization: &Authorization,
        relative: PathBuf,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let request = ShellCommandRequest::from_arguments(&ToolPayload::FunctionArguments(
            call.arguments.clone(),
        ))
        .map_err(|error| CoreError::Execution(error.to_string()))?;
        let request = self.materialize_at(request, dir_authorization.dir(), relative)?;
        let scope = local_sandbox_scope(dir_authorization.dir())?;
        self.execute_request_scoped(
            request,
            authorization,
            cancellation,
            Some(&scope),
            network_policy,
        )
    }

    fn review_request(
        &self,
        request: &ShellCommandRequest,
    ) -> Result<ActionReviewRequest, CoreError> {
        let selected_root = request
            .dir_root()
            .map(Dir::open_local)
            .transpose()
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .unwrap_or_else(|| self.authorization.dir().clone());
        let scope = local_sandbox_scope(&selected_root)?;
        self.review_request_scoped(request, Some(&scope))
    }

    fn review_request_scoped(
        &self,
        request: &ShellCommandRequest,
        sandbox_scope: Option<&SandboxScope>,
    ) -> Result<ActionReviewRequest, CoreError> {
        let selected_root = request
            .dir_root()
            .map(Dir::open_local)
            .transpose()
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .unwrap_or_else(|| self.authorization.dir().clone());
        let canonical_working_directory = selected_root
            .resolve_existing(request.working_directory())
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let canonical = serde_json::to_vec(&json!({
            "program": request.program(),
            "arguments": request.arguments(),
            "working_directory": canonical_working_directory,
            "sandboxScope": sandbox_scope.map(|scope| json!({
                "commandDir": scope.command_dir().id(),
                "grants": scope.grants().iter().map(|grant| json!({
                    "dirId": grant.dir().id(),
                    "access": format!("{:?}", grant.access()),
                })).collect::<Vec<_>>(),
                "hiddenDirs": scope.hidden_dirs().iter().map(Dir::id).collect::<Vec<_>>(),
            })),
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let is_ripgrep = request.program() == self.ripgrep.path().to_string_lossy();
        let capabilities = if is_ripgrep {
            local_capabilities(&selected_root, &self.ripgrep)
        } else {
            shell_capabilities()
        };
        let sandbox = if is_ripgrep {
            read_only_sandbox()
        } else {
            self.shell_policy
        };
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::LocalProcess(if is_ripgrep {
                    ProcessInvocationKind::Direct
                } else {
                    ProcessInvocationKind::Shell
                }),
                format!(
                    "run {} in {}",
                    request.program(),
                    canonical_working_directory.display()
                ),
                capabilities,
            )
            .with_command(request.program().to_owned(), request.arguments().to_vec()),
            ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
            SandboxCompatibility::Supported(sandbox),
            self.action_policy_revision.clone(),
        ))
    }

    fn execute_request(
        &self,
        request: ShellCommandRequest,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let selected_root = request
            .dir_root()
            .map(Dir::open_local)
            .transpose()
            .map_err(|error| CoreError::Execution(error.to_string()))?
            .unwrap_or_else(|| self.authorization.dir().clone());
        let scope = local_sandbox_scope(&selected_root)?;
        self.execute_request_scoped(request, authorization, cancellation, Some(&scope), None)
    }

    fn execute_request_scoped(
        &self,
        request: ShellCommandRequest,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sandbox_scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let authority = local_command_authority(authorization, self.shell_policy, sandbox_scope)?;
        let effective_scope = matches!(authority, CommandExecutionAuthority::Sandboxed(_))
            .then_some(sandbox_scope)
            .flatten();
        match self.shell.execute_authorized_with_network(
            request,
            authority,
            cancellation,
            effective_scope,
            network_policy,
        ) {
            Ok(CommandExecutionOutcome::Completed(output)) => {
                let mut value = json!({
                    "exit_code": output.exit_code,
                    "stdout": output.stdout,
                    "stderr": output.stderr,
                    "stdout_truncated": output.stdout_truncated,
                    "stderr_truncated": output.stderr_truncated,
                });
                if effective_scope.is_some() {
                    value["managed_scope"] = true.into();
                }
                let text = serde_json::to_string_pretty(&value)
                    .map_err(|error| CoreError::Execution(error.to_string()))?;
                Ok(ToolExecutionOutput::Success(text))
            }
            Ok(CommandExecutionOutcome::SandboxDenied(denial)) => {
                Ok(ToolExecutionOutput::SandboxDenied(denial))
            }
            Err(ExecutionError::CancelledAfterStart(reason)) => {
                Ok(ToolExecutionOutput::OutcomeUnknown(format!(
                    "shell command was cancelled after process start: {reason}"
                )))
            }
            Err(ExecutionError::TimedOut) => Ok(ToolExecutionOutput::OutcomeUnknown(
                "shell command timed out after process start".into(),
            )),
            Err(error) => Ok(ToolExecutionOutput::Failure(execution_error(error))),
        }
    }
}

impl<B: SandboxBackend> ToolService for LocalShellToolService<B> {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![self.definition.clone()]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        self.review_request(&self.materialize(call)?)
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_request(self.materialize(call)?, authorization, cancellation)
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let output = self.execute(call, authorization, cancellation)?;
        if let ToolExecutionOutput::Success(text) = &output
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(text)
        {
            if let Some(stdout) = value.get("stdout").and_then(serde_json::Value::as_str) {
                sink.emit(ToolOutputStream::Stdout, stdout.to_owned())?;
            }
            if let Some(stderr) = value.get("stderr").and_then(serde_json::Value::as_str) {
                sink.emit(ToolOutputStream::Stderr, stderr.to_owned())?;
            }
        }
        Ok(output)
    }
}

struct LocalExecutorReviewer {
    shell_policy: SandboxPolicy,
    authorization: Authorization,
    ripgrep: RipgrepExecutable,
    action_policy_revision: ActionPolicyRevision,
    dir_grants: Arc<DirGrants>,
}

impl ToolExecutorReviewer for LocalExecutorReviewer {
    fn prepare(&self, call: &ToolCall) -> Result<PreparedToolExecution, CoreError> {
        self.prepare_for_session(call, None, None)
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<PreparedToolExecution, CoreError> {
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Policy("local executors require durable caller identity".into())
        })?;
        self.prepare_for_session(
            call,
            Some(identity.session_id()),
            Some(identity.thread_id()),
        )
    }
}

impl LocalExecutorReviewer {
    fn prepare_for_session(
        &self,
        call: &ToolCall,
        session_id: Option<&ash_protocol::SessionId>,
        thread_id: Option<&ash_protocol::ThreadId>,
    ) -> Result<PreparedToolExecution, CoreError> {
        self.authorization
            .ensure_active()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        if call.name.as_str() == "shell-command" {
            let (review, request, authorizations) =
                self.prepare_shell(call, session_id, thread_id)?;
            let mut prepared = PreparedToolExecution::new(
                review,
                ToolPayload::FunctionArguments(json!({
                    "program": request.program(),
                    "arguments": request.arguments(),
                    "working_directory": request.working_directory(),
                    "dir_root": request.dir_root(),
                })),
            );
            for authorization in authorizations {
                prepared = prepared.with_dir_authorization(authorization);
            }
            return Ok(prepared);
        }
        if call.name.as_str() == "apply_patch" {
            let (review, patch, authorization) =
                self.prepare_apply_patch(call, session_id, thread_id)?;
            let execution_dir = authorization.dir().canonical_path().to_path_buf();
            return Ok(PreparedToolExecution::new(
                review,
                ToolPayload::FunctionArguments(json!({"patch": patch})),
            )
            .with_dir_authorization(authorization)
            .with_execution_dir(execution_dir));
        }
        let review = match call.name.as_str() {
            _ => Err(CoreError::Policy(format!(
                "local executor reviewer does not own tool {}",
                call.name
            ))),
        }?;
        Ok(PreparedToolExecution::new(
            review,
            ToolPayload::FunctionArguments(call.arguments.clone()),
        )
        .with_dir_authorization(self.authorization.clone()))
    }

    fn prepare_shell(
        &self,
        call: &ToolCall,
        session_id: Option<&ash_protocol::SessionId>,
        thread_id: Option<&ash_protocol::ThreadId>,
    ) -> Result<(ActionReviewRequest, ShellCommandRequest, Vec<Authorization>), CoreError> {
        if call.arguments.get("dir_root").is_some() {
            return Err(CoreError::Policy(
                "shell-command dir_root is host-owned".into(),
            ));
        }
        let mut request = ShellCommandRequest::from_arguments(&ToolPayload::FunctionArguments(
            call.arguments.clone(),
        ))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let (authorization, relative_working_directory, working_directory) =
            self.resolve_execution_dir(request.working_directory(), session_id, thread_id)?;
        request = request
            .with_working_directory(relative_working_directory)
            .with_dir_root(authorization.dir().canonical_path());
        if request.program() == "rg" {
            validate_dir_arguments(authorization.dir(), &request)?;
        }
        if !working_directory.is_dir() {
            return Err(CoreError::Policy(
                "shell-command working directory must be a directory".into(),
            ));
        }
        if request.program() == "rg" {
            request = self
                .ripgrep
                .materialize(request)
                .map_err(|error| CoreError::Policy(error.to_string()))?;
        }
        let is_ripgrep = request.program() == self.ripgrep.path().to_string_lossy();
        let capabilities = if is_ripgrep {
            local_capabilities(authorization.dir(), &self.ripgrep)
        } else {
            shell_capabilities()
        };
        let sandbox = if is_ripgrep {
            read_only_sandbox()
        } else {
            self.shell_policy
        };
        let canonical = serde_json::to_vec(&json!({
            "program": request.program(),
            "arguments": request.arguments(),
            "working_directory": working_directory,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let review = ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::LocalProcess(if is_ripgrep {
                    ProcessInvocationKind::Direct
                } else {
                    ProcessInvocationKind::Shell
                }),
                format!(
                    "run {} in {}",
                    request.program(),
                    working_directory.display()
                ),
                capabilities,
            )
            .with_command(request.program().to_owned(), request.arguments().to_vec()),
            ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
            SandboxCompatibility::Supported(sandbox),
            self.action_policy_revision.clone(),
        );
        Ok((review, request, vec![authorization]))
    }

    fn resolve_execution_dir(
        &self,
        requested: &Path,
        session_id: Option<&ash_protocol::SessionId>,
        thread_id: Option<&ash_protocol::ThreadId>,
    ) -> Result<(Authorization, std::path::PathBuf, std::path::PathBuf), CoreError> {
        let thread_scope = thread_id
            .map(|thread_id| {
                self.dir_grants
                    .thread_scope(thread_id, DirPermission::ExecuteCommands)
                    .map_err(|error| CoreError::Policy(error.to_string()))
            })
            .transpose()?
            .flatten();
        if requested.is_relative() {
            let authorization = thread_scope
                .as_ref()
                .map(|scope| scope.primary().clone())
                .unwrap_or_else(|| self.authorization.clone());
            let absolute = authorization
                .dir()
                .resolve_existing(requested)
                .map_err(|error| CoreError::Policy(error.to_string()))?;
            return Ok((authorization, requested.to_path_buf(), absolute));
        }
        let mut authorizations = thread_scope
            .as_ref()
            .map(|scope| scope.authorizations().cloned().collect::<Vec<_>>())
            .unwrap_or_else(|| vec![self.authorization.clone()]);
        if !authorizations
            .iter()
            .any(|value| value.dir() == self.authorization.dir())
        {
            authorizations.push(self.authorization.clone());
        }
        if let Some(session_id) = session_id
            && let Some(snapshot) = self
                .dir_grants
                .snapshot_for(session_id, DirPermission::ExecuteCommands)
                .map_err(|error| CoreError::Policy(error.to_string()))?
        {
            authorizations.extend(snapshot.authorizations().iter().cloned());
        }
        let (authorization, relative) = authorizations
            .into_iter()
            .filter_map(|authorization| {
                requested
                    .strip_prefix(authorization.dir().canonical_path())
                    .or_else(|_| requested.strip_prefix(authorization.dir().requested_path()))
                    .ok()
                    .map(|relative| (authorization, relative.to_path_buf()))
            })
            .max_by_key(|(authorization, _)| {
                authorization.dir().canonical_path().components().count()
            })
            .ok_or_else(|| {
                CoreError::Policy(format!(
                    "shell-command working directory is not authorized: {}",
                    requested.display()
                ))
            })?;
        let relative = if relative.as_os_str().is_empty() {
            std::path::PathBuf::from(".")
        } else {
            relative
        };
        let absolute = authorization
            .dir()
            .resolve_existing(&relative)
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok((authorization, relative, absolute))
    }

    fn prepare_apply_patch(
        &self,
        call: &ToolCall,
        session_id: Option<&ash_protocol::SessionId>,
        thread_id: Option<&ash_protocol::ThreadId>,
    ) -> Result<(ActionReviewRequest, String, Authorization), CoreError> {
        if call.arguments.get("dir_root").is_some() {
            return Err(CoreError::Policy(
                "apply_patch dir_root is host-owned".into(),
            ));
        }
        let patch = call
            .arguments
            .get("patch")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| CoreError::Policy("apply_patch patch must be a string".into()))?;
        let thread_scope = thread_id
            .map(|thread_id| {
                self.dir_grants
                    .thread_scope(thread_id, DirPermission::MutateRepository)
                    .map_err(|error| CoreError::Policy(error.to_string()))
            })
            .transpose()?
            .flatten();
        let mut authorizations = thread_scope
            .as_ref()
            .map(|scope| scope.authorizations().cloned().collect::<Vec<_>>())
            .unwrap_or_else(|| vec![self.authorization.clone()]);
        if !authorizations
            .iter()
            .any(|value| value.dir() == self.authorization.dir())
        {
            authorizations.push(self.authorization.clone());
        }
        if let Some(session_id) = session_id
            && let Some(snapshot) = self
                .dir_grants
                .snapshot_for(session_id, DirPermission::MutateRepository)
                .map_err(|error| CoreError::Policy(error.to_string()))?
        {
            authorizations.extend(snapshot.authorizations().iter().cloned());
        }
        let (authorization, rewritten_patch, targets) =
            materialize_patch_targets(&authorizations, patch, &[])?;
        let capabilities = targets.iter().flat_map(|target| {
            [
                Capability::new(CapabilityKind::FileRead, target.clone()),
                Capability::new(CapabilityKind::FileWrite, target.clone()),
            ]
        });
        let canonical = serde_json::to_vec(&json!({
            "tool": call.name,
            "patch": patch,
            "targets": &targets,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let review = ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::FileSystemMutation,
                format!("apply patch to {} directory file(s)", targets.len()),
                CapabilitySet::new(capabilities),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "apply_patch"),
            SandboxCompatibility::NotApplicable {
                reason: "apply_patch validates every target through Dir and commits host-mediated file mutations".into(),
            },
            self.action_policy_revision.clone(),
        );
        Ok((review, rewritten_patch, authorization))
    }
}

fn materialize_patch_targets(
    authorizations: &[Authorization],
    patch: &str,
    source_aliases: &[(Dir, Authorization)],
) -> Result<(Authorization, String, Vec<String>), CoreError> {
    let primary = authorizations
        .first()
        .ok_or_else(|| CoreError::Policy("apply_patch has no writable directory".into()))?;
    let mut selected: Option<Authorization> = None;
    let mut targets = Vec::new();
    let mut rewritten = Vec::new();
    for line in patch.lines() {
        let operation = [
            ("*** Update File: ", true),
            ("*** Delete File: ", true),
            ("*** Add File: ", false),
        ]
        .into_iter()
        .find_map(|(prefix, existing)| line.strip_prefix(prefix).map(|path| (path, existing)));
        let Some((path, existing)) = operation else {
            rewritten.push(line.to_owned());
            continue;
        };
        if path.trim().is_empty() {
            return Err(CoreError::Policy(
                "apply_patch contains an empty target path".into(),
            ));
        }
        let path = Path::new(path);
        let (authorization, relative) = if path.is_absolute() {
            if let Some((authorization, relative)) = source_aliases
                .iter()
                .filter_map(|(source, authorization)| {
                    path.strip_prefix(source.canonical_path())
                        .or_else(|_| path.strip_prefix(source.requested_path()))
                        .ok()
                        .map(|relative| {
                            (
                                authorization.clone(),
                                relative.to_path_buf(),
                                source.canonical_path().components().count(),
                            )
                        })
                })
                .max_by_key(|(_, _, depth)| *depth)
                .map(|(authorization, relative, _)| (authorization, relative))
            {
                (authorization, relative)
            } else {
                authorizations
                    .iter()
                    .filter_map(|authorization| {
                        path.strip_prefix(authorization.dir().canonical_path())
                            .or_else(|_| path.strip_prefix(authorization.dir().requested_path()))
                            .ok()
                            .map(|relative| (authorization.clone(), relative.to_path_buf()))
                    })
                    .max_by_key(|(authorization, _)| {
                        authorization.dir().canonical_path().components().count()
                    })
                    .ok_or_else(|| {
                        CoreError::Policy(format!(
                            "apply_patch target is not in an authorized writable directory: {}",
                            path.display()
                        ))
                    })?
            }
        } else {
            (primary.clone(), path.to_path_buf())
        };
        if let Some(selected) = &selected
            && selected.dir() != authorization.dir()
        {
            return Err(CoreError::Policy(
                "one apply_patch call cannot modify more than one directory".into(),
            ));
        }
        selected = Some(authorization.clone());
        let resolved = if existing {
            authorization.dir().resolve_existing(&relative)
        } else {
            authorization.dir().resolve_for_write(&relative)
        }
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        ensure_local_file_access(authorization.dir(), &resolved, true)?;
        targets.push(resolved.display().to_string());
        let prefix = if existing && line.starts_with("*** Update File: ") {
            "*** Update File: "
        } else if existing {
            "*** Delete File: "
        } else {
            "*** Add File: "
        };
        rewritten.push(format!("{prefix}{}", relative.display()));
    }
    targets.sort();
    targets.dedup();
    if targets.is_empty() {
        return Err(CoreError::Policy(
            "apply_patch contains no file operations to review".into(),
        ));
    }
    Ok((
        selected.expect("a patch with targets selected one directory"),
        rewritten.join("\n"),
        targets,
    ))
}

struct LocalShellPolicy {
    exec_policy: ExecPolicySnapshot,
    action_policy_revision: ActionPolicyRevision,
}

impl Default for LocalShellPolicy {
    fn default() -> Self {
        let exec_policy = LocalToolConfig::default()
            .snapshot()
            .expect("static local execution policy is valid");
        Self {
            exec_policy,
            action_policy_revision: local_policy_revision(),
        }
    }
}

static LOCAL_EXEC_POLICY_HOST_LAYER: LazyLock<ExecPolicyLayer> = LazyLock::new(|| {
    let rules = [
        local_rule(
            "local-shell",
            "shell-command",
            ExecPolicyActionKind::LocalProcess,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "local-read-file",
            "read_file",
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "local-grep",
            "grep",
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "local-glob",
            "glob",
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "local-write-file",
            "write_file",
            ExecPolicyActionKind::FileSystemMutation,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "local-edit",
            "edit",
            ExecPolicyActionKind::FileSystemMutation,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "local-apply-patch",
            "apply_patch",
            ExecPolicyActionKind::FileSystemMutation,
            ExecPolicyEffect::Continue,
        ),
        local_rule(
            "codebase-read",
            crate::codebase_retrieval_tool::CODE_RETRIEVAL_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:read_instruction",
            "read_instruction",
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:update_plan",
            crate::server::update_plan_tool::UPDATE_PLAN_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:get_goal",
            goal::GET_GOAL_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:create_goal",
            goal::CREATE_GOAL_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:update_goal",
            goal::UPDATE_GOAL_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:spawn_agent",
            agent::SPAWN_AGENT_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:send_agent_message",
            agent::SEND_AGENT_MESSAGE_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
        local_rule(
            "built-in:wait_agent",
            agent::WAIT_AGENT_TOOL_NAME,
            ExecPolicyActionKind::SystemOperation,
            ExecPolicyEffect::AllowUnsandboxed,
        ),
    ];
    ExecPolicyLayer::new(
        ExecPolicyLayerId::new("local-host"),
        ExecPolicyLayerKind::Host,
        rules,
    )
});

static LOCAL_ACTION_POLICY_REVISION: LazyLock<ActionPolicyRevision> = LazyLock::new(|| {
    let exec_policy = LocalToolConfig::default()
        .snapshot()
        .expect("static local execution policy is valid");
    ActionPolicyRevision::from_components(
        exec_policy.revision(),
        LOCAL_GRANT_SNAPSHOT_REVISION,
        LOCAL_REVIEWER_POLICY_REVISION,
    )
});

fn local_rule(
    rule_id: &str,
    source_id: &str,
    action_kind: ExecPolicyActionKind,
    effect: ExecPolicyEffect,
) -> ExecPolicyRule {
    ExecPolicyRule::new(
        ExecPolicyRuleId::new(rule_id),
        ExecPolicySelector::all([
            ExecPolicySelector::source(Some("built_in_tool".into()), Some(source_id.into())),
            ExecPolicySelector::ActionKind { action_kind },
        ]),
        effect,
    )
}

pub(crate) fn local_policy_revision() -> ActionPolicyRevision {
    LOCAL_ACTION_POLICY_REVISION.clone()
}

struct LocalPolicyClassifier;

impl ActionClassifier for LocalPolicyClassifier {
    type Error = std::convert::Infallible;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        let _ = cancellation.check();
        let reason = if matches!(
            request.phase(),
            ash_action_policy::ActionReviewPhase::SandboxDenial(_)
        ) {
            "the command requires authority outside the configured sandbox"
        } else {
            "the action requires user approval"
        };
        Ok(ClassifierAssessment::new(
            AssessmentId::from_response(
                request.action().digest(),
                request.action_policy_revision(),
                LOCAL_REVIEWER_POLICY_REVISION,
                reason,
            ),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            LOCAL_REVIEWER_POLICY_REVISION,
            ClassifierRecommendation::AskUser {
                reason: reason.into(),
            },
        ))
    }
}

impl ActionPolicyService for LocalShellPolicy {
    fn revision(&self) -> String {
        self.action_policy_revision.as_str().to_owned()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        ActionPolicyEngine::new(
            self.action_policy_revision.clone(),
            self.exec_policy.clone(),
            LocalPolicyClassifier,
            ReviewFailurePolicy::Block,
        )
        .decide(request, cancellation)
        .map_err(|error| CoreError::Policy(error.to_string()))
    }
}

fn local_capabilities(authorization: &Dir, ripgrep: &RipgrepExecutable) -> CapabilitySet {
    CapabilitySet::new([
        Capability::new(
            CapabilityKind::FileRead,
            authorization.canonical_path().to_string_lossy(),
        ),
        Capability::new(
            CapabilityKind::ProcessSpawn,
            ripgrep.path().to_string_lossy(),
        ),
    ])
}

fn shell_capabilities() -> CapabilitySet {
    CapabilitySet::new([
        Capability::new(CapabilityKind::FileRead, "/"),
        Capability::new(CapabilityKind::FileWrite, "/"),
        Capability::new(CapabilityKind::ProcessSpawn, "*"),
        Capability::new(CapabilityKind::Network, "*"),
        Capability::new(CapabilityKind::CredentialUse, "*"),
        Capability::new(CapabilityKind::ExternalMutation, "*"),
        Capability::new(CapabilityKind::SystemConfiguration, "*"),
        Capability::new(CapabilityKind::UserInterface, "*"),
    ])
}

fn local_acl_changes() -> ash_sandboxing::HostAclChanges {
    if cfg!(windows) {
        ash_sandboxing::HostAclChanges::ScopedWithTraversal
    } else {
        ash_sandboxing::HostAclChanges::Scoped
    }
}

fn local_isolation() -> ash_sandboxing::FileSystemIsolation {
    if cfg!(windows) {
        ash_sandboxing::FileSystemIsolation::WindowsAccount
    } else {
        ash_sandboxing::FileSystemIsolation::Strict
    }
}

const LOCAL_DENIED_GLOBS: &[&str] = &["**/.env"];

fn local_sandbox_scope(dir: &Dir) -> Result<SandboxScope, CoreError> {
    let rules = LOCAL_DENIED_GLOBS
        .iter()
        .map(|pattern| {
            SandboxPathRule::pattern(
                dir.clone(),
                *pattern,
                SandboxPathAccess::Denied,
                PatternMatchTiming::PreparationSnapshot,
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CoreError::Policy(error.to_string()))?;
    SandboxScope::single(dir.clone())
        .with_path_rules(rules)
        .map_err(|error| CoreError::Policy(error.to_string()))
}

fn local_command_authority(
    authorization: &ToolAuthorization,
    shell_policy: SandboxPolicy,
    scope: Option<&SandboxScope>,
) -> Result<CommandExecutionAuthority, CoreError> {
    match authorization {
        ToolAuthorization::Sandboxed(policy) => {
            return Ok(CommandExecutionAuthority::Sandboxed(*policy));
        }
        ToolAuthorization::UnsandboxedGrant { .. }
        | ToolAuthorization::ExecPolicyGranted(_)
        | ToolAuthorization::AutoReviewed(_)
        | ToolAuthorization::PermissionBypassed(_)
        | ToolAuthorization::ApprovedOnce(_) => {}
    }
    // Ordinary execution approval widens the remaining access, not explicit
    // files denied by this execution's preparation snapshot.
    let denied = scope
        .map(|scope| {
            scope
                .resolve_filesystem(FileSystemAccess::FullAccess)
                .map(|filesystem| !filesystem.denied_paths().is_empty())
        })
        .transpose()
        .map_err(|error| CoreError::Policy(error.to_string()))?
        .unwrap_or(false);
    let network = shell_policy.network();
    if denied || network == NetworkAccess::Managed {
        return Ok(CommandExecutionAuthority::Sandboxed(
            SandboxPolicy::new(
                FileSystemAccess::FullAccess,
                if network == NetworkAccess::Managed {
                    NetworkAccess::Managed
                } else {
                    NetworkAccess::Allowed
                },
            )
            .with_host_acl_changes(shell_policy.host_acl_changes())
            .with_file_system_isolation(shell_policy.file_system_isolation()),
        ));
    }
    Ok(CommandExecutionAuthority::Unrestricted)
}

fn ensure_local_file_access(dir: &Dir, path: &Path, write: bool) -> Result<(), CoreError> {
    let filesystem = local_sandbox_scope(dir)?
        .resolve_filesystem(FileSystemAccess::DirectoryWrite)
        .map_err(|error| CoreError::Policy(error.to_string()))?;
    let allowed = if write {
        filesystem.allows_write(path)
    } else {
        filesystem.allows_read(path)
    };
    if allowed {
        Ok(())
    } else {
        Err(CoreError::Policy(format!(
            "path is denied by the local filesystem policy: {}",
            path.display()
        )))
    }
}

fn read_only_sandbox() -> SandboxPolicy {
    SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied)
        .with_host_acl_changes(local_acl_changes())
        .with_file_system_isolation(local_isolation())
}

#[cfg(test)]
fn shell_sandbox() -> SandboxPolicy {
    SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
        .with_host_acl_changes(local_acl_changes())
        .with_file_system_isolation(local_isolation())
}

fn configured_shell_policy(policy: &ExecPolicySnapshot) -> SandboxPolicy {
    let network = if policy
        .layers()
        .iter()
        .flat_map(|layer| layer.rules())
        .any(|rule| rule.selector().targets_network())
    {
        NetworkAccess::Managed
    } else {
        NetworkAccess::Denied
    };
    SandboxPolicy::new(FileSystemAccess::DirectoryWrite, network)
        .with_host_acl_changes(local_acl_changes())
        .with_file_system_isolation(local_isolation())
}

fn validate_dir_arguments(
    authorization: &Dir,
    request: &ShellCommandRequest,
) -> Result<(), CoreError> {
    for argument in request.arguments() {
        let path = Path::new(argument);
        if path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(CoreError::Policy(format!(
                "ripgrep argument escapes the directory: {argument}"
            )));
        }
        let dir_relative = request.working_directory().join(path);
        if authorization.canonical_path().join(&dir_relative).exists() {
            authorization.resolve_existing(&dir_relative).map_err(|_| {
                CoreError::Policy(format!(
                    "ripgrep argument resolves outside the directory: {argument}"
                ))
            })?;
        }
    }
    Ok(())
}

fn execution_error(error: ExecutionError) -> String {
    match error {
        ExecutionError::Network(message) => format!("shell command network failed: {message}"),
        ExecutionError::ApprovalRequired => {
            "shell command unexpectedly requires host approval".into()
        }
        ExecutionError::Denied => "shell command was denied by the execution policy".into(),
        ExecutionError::Spawn(reason) => format!("could not execute shell command: {reason}"),
        ExecutionError::CancelledBeforeStart(reason) => {
            format!("ripgrep was cancelled before process start: {reason}")
        }
        ExecutionError::CancelledAfterStart(reason) => {
            format!("ripgrep was cancelled after process start: {reason}")
        }
        ExecutionError::TimedOut => "shell command timed out".into(),
        ExecutionError::Sandbox(error) => format!("shell command sandbox failed: {error}"),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LocalToolError(String);

impl LocalToolError {
    fn permission(error: impl fmt::Display) -> Self {
        Self(format!(
            "directory permission rejected local tools: {error}"
        ))
    }

    fn ripgrep(error: impl fmt::Display) -> Self {
        Self(format!("could not resolve ripgrep: {error}"))
    }

    fn definition(error: impl fmt::Display) -> Self {
        Self(format!("could not construct local tool registry: {error}"))
    }

    fn policy(error: impl fmt::Display) -> Self {
        Self(format!("could not compose local execution policy: {error}"))
    }
}

impl fmt::Display for LocalToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for LocalToolError {}

#[cfg(test)]
#[path = "local_tools_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "local_tools_policy_tests.rs"]
mod policy_tests;

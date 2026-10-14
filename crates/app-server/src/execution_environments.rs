//! Host-selected execution environments exposed to the existing Core tool lifecycle.

use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::Capability;
use ash_protocol::CapabilityKind;
use ash_protocol::CapabilitySet;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use core_api::ActionPolicyService;
use core_api::CoreError;
use exec_server::ExecutionEnvironment;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

const REVISION: &str = "execution-environments-v2";
const READ_WAIT_MILLIS: u64 = 500;
const RECOVERY_BUDGET: Duration = Duration::from_secs(5);

pub(crate) struct EnvironmentTools {
    environments: BTreeMap<String, ExecutionEnvironment>,
    permissions: Arc<dyn Fn() -> crate::local_tools::LocalToolConfig + Send + Sync>,
}

impl EnvironmentTools {
    pub(crate) fn new(
        environments: Vec<ExecutionEnvironment>,
        permissions: Arc<dyn Fn() -> crate::local_tools::LocalToolConfig + Send + Sync>,
    ) -> Result<Self, String> {
        let mut mapped = BTreeMap::new();
        for environment in environments {
            let id = environment.info().environment_id.clone();
            if mapped.insert(id.clone(), environment).is_some() {
                return Err(format!("duplicate execution environment: {id}"));
            }
        }
        if mapped.is_empty() {
            return Err("execution environments cannot be empty".into());
        }
        Ok(Self {
            environments: mapped,
            permissions,
        })
    }

    fn permission_snapshot(
        &self,
        environment: &ExecutionEnvironment,
    ) -> Result<ExecutionEnvironment, CoreError> {
        let config = (self.permissions)();
        let requirements = config
            .requirements
            .as_ref()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let profile = requirements
            .values
            .constrain(
                config
                    .profile()
                    .map_err(|error| CoreError::Policy(error.to_string()))?,
            )
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        // Endpoint rules use the execution host's proxy and Core's exact network approvals;
        // an explicitly denied profile remains a ceiling even when rules permit one target.
        let managed_network = config
            .common_policy_snapshot(None)
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .layers()
            .iter()
            .flat_map(|layer| layer.rules())
            .any(|rule| rule.selector().targets_network());
        let constraints = exec_server_protocol::ExecutionConstraints {
            file_access: if profile.file_operations == ash_file_access::PathAccess::ReadOnly {
                exec_server_protocol::FileAccess::ReadOnly
            } else {
                exec_server_protocol::FileAccess::ReadWrite
            },
            command_access: if profile.file_system == ash_protocol::SandboxMode::ReadOnly {
                exec_server_protocol::FileAccess::ReadOnly
            } else {
                exec_server_protocol::FileAccess::ReadWrite
            },
            network: if profile.scope == ash_config::PermissionProfileScope::AllOperations
                && profile.network == ash_config::CommandNetworkAccess::Denied
                || requirements.values.maximum_network
                    == Some(ash_config::CommandNetworkAccess::Denied)
            {
                exec_server_protocol::NetworkAccess::Denied
            } else if managed_network {
                exec_server_protocol::NetworkAccess::Managed
            } else if profile.network == ash_config::CommandNetworkAccess::Denied {
                exec_server_protocol::NetworkAccess::Denied
            } else {
                exec_server_protocol::NetworkAccess::Allowed
            },
            host_read: profile.host_read,
            paths: profile.paths,
        };
        environment
            .clone()
            .constrained(constraints)
            .map_err(|error| CoreError::Policy(error.to_string()))
    }

    fn materialize(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<(ExecutionEnvironment, PreparedOperation), CoreError> {
        let arguments: Arguments = serde_json::from_value(call.arguments.clone())
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let environment = self
            .environments
            .get(&arguments.environment)
            .ok_or_else(|| CoreError::Policy("unknown execution environment".into()))?;
        let environment = self.permission_snapshot(environment)?;
        let request = match arguments.operation {
            Operation::Command {
                program,
                arguments,
                cwd,
                timeout_millis,
            } => {
                let id = operation_id(&environment, call, facts)?;
                let params = ProcessStart {
                    input: exec_server_protocol::ProcessInput::Closed,
                    operation_id: id,
                    program,
                    arguments,
                    cwd,
                    timeout_millis,
                };
                params.validate().map_err(|error| {
                    CoreError::Policy(format!("invalid process request: {error:?}"))
                })?;
                PreparedOperation::Command(params)
            }
            Operation::Read { path } => {
                validate_path(&path)?;
                PreparedOperation::Read { path }
            }
            Operation::Write {
                path,
                content,
                expected_revision,
            } => {
                validate_path(&path)?;
                if content.len() > exec_server_protocol::MAX_FILE_BYTES {
                    return Err(CoreError::Policy("file content exceeds limit".into()));
                }
                PreparedOperation::Write {
                    operation_id: operation_id(&environment, call, facts)?,
                    path,
                    bytes: content.into_bytes(),
                    condition: match expected_revision {
                        Some(revision) => {
                            exec_server_protocol::WriteCondition::ExpectedRevision(revision)
                        }
                        None => exec_server_protocol::WriteCondition::MissingOrEmpty,
                    },
                }
            }
        };
        Ok((environment, request))
    }
}

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum PreparedOperation {
    Command(ProcessStart),
    Read {
        path: String,
    },
    Write {
        operation_id: String,
        path: String,
        bytes: Vec<u8>,
        condition: exec_server_protocol::WriteCondition,
    },
}

fn operation_id(
    environment: &ExecutionEnvironment,
    call: &ToolCall,
    facts: &ToolExecutionFacts,
) -> Result<String, CoreError> {
    let identity = facts.execution_identity().ok_or_else(|| {
        CoreError::Policy("execution requires a durable Thread and Turn identity".into())
    })?;
    let key = serde_json::to_vec(&(
        environment.info().incarnation.as_str(),
        identity.session_id(),
        identity.thread_id(),
        identity.turn_id(),
        &call.id,
    ))
    .map_err(|error| CoreError::Policy(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(key)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    environment: String,
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    Command {
        program: String,
        arguments: Vec<String>,
        cwd: String,
        timeout_millis: u64,
    },
    Read {
        path: String,
    },
    Write {
        path: String,
        content: String,
        expected_revision: Option<String>,
    },
}
fn validate_path(path: &str) -> Result<(), CoreError> {
    exec_server_protocol::validate_path(path)
        .map_err(|_| CoreError::Policy("execution path must be relative to its environment".into()))
}

impl ToolService for EnvironmentTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("environment").expect("static tool name"),
            description: "Execute a command or read/write a file in an explicitly selected execution environment. Paths are relative to that environment's root. Read before overwriting and supply its revision; null revision only permits a new/empty file. Commands are never retried after connection loss.".into(),
            parameters: json!({"type":"object","additionalProperties":false,"properties":{
                "environment":{"type":"string","enum":self.environments.keys().collect::<Vec<_>>()},
                "operation":{"anyOf":[
                    {"type":"object","additionalProperties":false,"properties":{"type":{"type":"string","enum":["command"]},"program":{"type":"string"},"arguments":{"type":"array","items":{"type":"string"}},"cwd":{"type":"string"},"timeout_millis":{"type":"integer","minimum":1,"maximum":43200000}},"required":["type","program","arguments","cwd","timeout_millis"]},
                    {"type":"object","additionalProperties":false,"properties":{"type":{"type":"string","enum":["read"]},"path":{"type":"string"}},"required":["type","path"]},
                    {"type":"object","additionalProperties":false,"properties":{"type":{"type":"string","enum":["write"]},"path":{"type":"string"},"content":{"type":"string"},"expected_revision":{"type":["string","null"]}},"required":["type","path","content","expected_revision"]}
                ]}},"required":["environment","operation"]}),
            strict: true,
        }]
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Err(CoreError::Policy(
            "execution requires durable execution facts".into(),
        ))
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        let (environment, request) = self.materialize(call, facts)?;
        let kind = match &request {
            PreparedOperation::Read { .. } => CapabilityKind::FileRead,
            PreparedOperation::Write { .. } => CapabilityKind::FileWrite,
            PreparedOperation::Command(_) => CapabilityKind::ProcessSpawn,
        };
        // Operation IDs prevent transport replay; they are not part of the action being approved.
        let action_value = match &request {
            PreparedOperation::Command(start) => {
                json!({"type":"command", "program": start.program, "arguments": start.arguments,
                "cwd": start.cwd, "timeoutMillis": start.timeout_millis, "input": start.input})
            }
            PreparedOperation::Read { path } => json!({"type":"read", "path": path}),
            PreparedOperation::Write {
                path,
                bytes,
                condition,
                ..
            } => json!({"type":"write", "path": path, "bytes": bytes, "condition": condition}),
        };
        let canonical =
            serde_json::to_vec(&json!({"environment":environment.info(),"permissions":environment.constraints(),"request":action_value}))
                .map_err(|error| CoreError::Policy(error.to_string()))?;
        let mut action = ResolvedAction::new(
            ActionDigest::from_canonical_bytes(&canonical),
            match &request {
                PreparedOperation::Command(_) => {
                    ActionKind::LocalProcess(ash_protocol::ProcessInvocationKind::Direct)
                }
                PreparedOperation::Read { .. } => ActionKind::SystemOperation,
                PreparedOperation::Write { .. } => ActionKind::FileSystemMutation,
            },
            match &request {
                PreparedOperation::Command(start) => format!(
                    "Run {} in environment {} (directory {})",
                    start.program,
                    environment.info().environment_id,
                    start.cwd
                ),
                PreparedOperation::Read { path } => format!(
                    "Read {path} in environment {}",
                    environment.info().environment_id
                ),
                PreparedOperation::Write { path, .. } => format!(
                    "Write {path} in environment {}",
                    environment.info().environment_id
                ),
            },
            CapabilitySet::new([Capability::new(
                kind,
                format!(
                    "{}:{}",
                    environment.info().environment_id,
                    environment.info().incarnation
                ),
            )]),
        );
        if let PreparedOperation::Command(start) = &request {
            action = action.with_command(start.program.clone(), start.arguments.clone());
        }
        Ok(ActionReviewRequest::new(action,
            ActionProvenance::new(ActionSource::BuiltInTool, "environment"),
            match &request {
                PreparedOperation::Command(_) => SandboxCompatibility::Supported(ash_sandboxing::SandboxPolicy::new(
                    if environment.constraints().command_access == exec_server_protocol::FileAccess::ReadOnly { ash_sandboxing::FileSystemAccess::ReadOnly }
                    else { ash_sandboxing::FileSystemAccess::DirectoryWrite }, match environment.constraints().network {
                        exec_server_protocol::NetworkAccess::Denied => ash_sandboxing::NetworkAccess::Denied,
                        exec_server_protocol::NetworkAccess::Managed => ash_sandboxing::NetworkAccess::Managed,
                        exec_server_protocol::NetworkAccess::Allowed => ash_sandboxing::NetworkAccess::Allowed })),
                PreparedOperation::Read { .. } | PreparedOperation::Write { .. } => SandboxCompatibility::NotApplicable {
                    reason: "the execution host enforces its own immutable filesystem and caller ceilings".into() },
            },
            ActionPolicyRevision::new(REVISION),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Policy(
            "execution requires durable execution facts".into(),
        ))
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_streaming_with_facts(
            call,
            authorization,
            cancellation,
            facts,
            &mut DiscardOutput,
        )
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_admitted(call, authorization, cancellation, facts, None, sink)
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
        self.execute_admitted(
            call,
            authorization,
            cancellation,
            facts,
            Some(interactions),
            sink,
        )
    }
}

impl EnvironmentTools {
    fn execute_admitted(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Option<Arc<dyn ash_core::ToolInteractionService>>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let (mut environment, request) = self.materialize(call, facts)?;
        if let ToolAuthorization::Sandboxed(policy) = authorization {
            let mut ceiling = environment.constraints();
            if policy.file_system() == ash_sandboxing::FileSystemAccess::ReadOnly {
                ceiling.command_access = exec_server_protocol::FileAccess::ReadOnly;
            }
            if policy.network() == ash_sandboxing::NetworkAccess::Denied {
                ceiling.network = exec_server_protocol::NetworkAccess::Denied;
            }
            environment = environment
                .constrained(ceiling)
                .map_err(|error| CoreError::Policy(error.to_string()))?;
        }
        let parent = self.prepare_with_facts(call, facts)?;
        let outcome = match request {
            PreparedOperation::Command(start) => {
                return run_command(
                    &environment,
                    start,
                    cancellation,
                    interactions,
                    parent,
                    sink,
                );
            }
            PreparedOperation::Read { path } => match environment.read_file(&path, cancellation) {
                Ok(content) => Ok(match String::from_utf8(content.bytes) {
                    Ok(text) => ToolExecutionOutput::Success(
                        json!({"content":text,"revision":content.revision}).to_string(),
                    ),
                    Err(_) => ToolExecutionOutput::Failure("file is not UTF-8 text".into()),
                }),
                Err(error @ exec_server::Error::Cancelled(_)) => Err(error),
                Err(error) => Ok(ToolExecutionOutput::Failure(error.to_string())),
            },
            PreparedOperation::Write {
                operation_id,
                path,
                bytes,
                condition,
            } => environment
                .write_file(&operation_id, &path, &bytes, condition, cancellation)
                .map(|()| ToolExecutionOutput::Success("file written".into())),
        };
        match outcome {
            Ok(output) => Ok(output),
            Err(exec_server::Error::Cancelled(reason)) => Err(CoreError::Cancelled(reason)),
            Err(error @ exec_server::Error::FileNotPublished(_)) => {
                Ok(ToolExecutionOutput::Failure(error.to_string()))
            }
            Err(exec_server::Error::Remote(error)) => Ok(ToolExecutionOutput::Failure(format!(
                "execution rejected: {error:?}"
            ))),
            Err(error) => Ok(ToolExecutionOutput::OutcomeUnknown(error.to_string())),
        }
    }
}

struct DiscardOutput;
impl ToolOutputSink for DiscardOutput {
    fn emit(&mut self, _: ToolOutputStream, _: String) -> Result<(), CoreError> {
        Ok(())
    }
}

fn run_command(
    environment: &ExecutionEnvironment,
    start: ProcessStart,
    cancellation: &CancellationToken,
    interactions: Option<Arc<dyn ash_core::ToolInteractionService>>,
    parent: ActionReviewRequest,
    sink: &mut dyn ToolOutputSink,
) -> Result<ToolExecutionOutput, CoreError> {
    let network = if environment.constraints().network
        == exec_server_protocol::NetworkAccess::Managed
    {
        Some(crate::network_policy::ExecutionNetworkPolicy::new(
            parent,
            interactions.ok_or_else(|| {
                CoreError::Policy(
                    "managed execution networking requires Core's live approval authority".into(),
                )
            })?,
        ))
    } else {
        None
    };
    let id = start.operation_id.clone();
    let deadline =
        Instant::now() + Duration::from_millis(start.timeout_millis) + Duration::from_secs(10);
    // A lost start response is reconciled with read, never by sending start again.
    let started = environment.request(Request::ProcessStart(start));
    if let Err(exec_server::Error::Remote(error)) = started {
        return Ok(ToolExecutionOutput::Failure(format!(
            "execution rejected: {error:?}"
        )));
    }
    let mut stdout_gap = false;
    let mut stderr_gap = false;
    let mut stdout_tail = String::new();
    let mut stderr_tail = String::new();
    let mut stdout_cursor = 0;
    let mut stderr_cursor = 0;
    let mut cancelled = false;
    let mut cancel_deadline = None;
    let mut recovery_deadline = None;
    loop {
        if cancellation.check().is_err() && !cancelled {
            cancelled = true;
            cancel_deadline = Some(Instant::now() + RECOVERY_BUDGET);
            let _ = environment.request(Request::ProcessCancel {
                operation_id: id.clone(),
            });
        }
        if let Some(network) = &network {
            match environment.request(Request::ProcessNetworkRequests {
                operation_id: id.clone(),
            }) {
                Ok(Response::ProcessNetworkRequests(requests)) => {
                    for request in requests {
                        exec_server_protocol::validate_id(&request.request_id).map_err(|_| {
                            CoreError::Policy("invalid remote network correlation".into())
                        })?;
                        let mut target = network_proxy::NetworkRequest::new(
                            request.protocol,
                            &request.host,
                            request.port,
                        )
                        .map_err(|error| CoreError::Policy(error.to_string()))?;
                        if let Some(method) = &request.method {
                            if method.is_empty()
                                || method.len() > 64
                                || !method
                                    .bytes()
                                    .all(|byte| byte.is_ascii_uppercase() || byte == b'-')
                            {
                                return Err(CoreError::Policy(
                                    "invalid remote network method".into(),
                                ));
                            }
                            target = target.with_method(method);
                        }
                        let allow = matches!(
                            network.decide_blocking(target, cancellation),
                            network_proxy::NetworkDecision::Allow
                        );
                        if let Err(error) =
                            environment.request(Request::ResolveProcessNetworkRequest {
                                operation_id: id.clone(),
                                request_id: request.request_id,
                                allow,
                            })
                        {
                            let _ = environment.request(Request::ProcessCancel {
                                operation_id: id.clone(),
                            });
                            return Ok(ToolExecutionOutput::OutcomeUnknown(format!(
                                "remote network approval reply was lost: {error}"
                            )));
                        }
                    }
                }
                Err(exec_server::Error::Remote(exec_server_protocol::ExecError::NotFound)) => {}
                other => {
                    let _ = environment.request(Request::ProcessCancel {
                        operation_id: id.clone(),
                    });
                    return Ok(ToolExecutionOutput::OutcomeUnknown(format!(
                        "remote network approval authority is unavailable: {other:?}"
                    )));
                }
            }
        }
        match environment.request(Request::ProcessRead(ProcessRead {
            operation_id: id.clone(),
            stdout_cursor,
            stderr_cursor,
            wait_millis: READ_WAIT_MILLIS,
        })) {
            Ok(Response::Process(mut snapshot)) => {
                recovery_deadline = None;
                stdout_gap |= snapshot.stdout.gap;
                stderr_gap |= snapshot.stderr.gap;
                stdout_cursor = snapshot.stdout.next_cursor;
                stderr_cursor = snapshot.stderr.next_cursor;
                // Transient delivery cannot abort or replay an already-started process.
                for (stream, output) in [
                    (ToolOutputStream::Stdout, &snapshot.stdout),
                    (ToolOutputStream::Stderr, &snapshot.stderr),
                ] {
                    if output.gap {
                        let _ = sink.emit(stream, "[execution output truncated]\n".into());
                    }
                    if !output.text.is_empty() {
                        let _ = sink.emit(stream, output.text.clone());
                    }
                }
                append_tail(&mut stdout_tail, &snapshot.stdout.text);
                append_tail(&mut stderr_tail, &snapshot.stderr.text);
                if snapshot.state != ProcessState::Running {
                    snapshot.stdout.text = stdout_tail;
                    snapshot.stderr.text = stderr_tail;
                    snapshot.stdout.gap = stdout_gap
                        || snapshot.stdout.next_cursor > snapshot.stdout.text.len() as u64;
                    snapshot.stderr.gap = stderr_gap
                        || snapshot.stderr.next_cursor > snapshot.stderr.text.len() as u64;
                    let final_snapshot = snapshot;
                    let text = serde_json::to_string(&final_snapshot)
                        .map_err(|error| CoreError::Execution(error.to_string()))?;
                    return Ok(match final_snapshot.state {
                        ProcessState::Exited { code: Some(0) } => {
                            ToolExecutionOutput::Success(text)
                        }
                        _ => ToolExecutionOutput::Failure(text),
                    });
                }
            }
            Ok(_) => return Err(CoreError::Execution("unexpected process response".into())),
            Err(exec_server::Error::Transport(error)) => {
                let until =
                    *recovery_deadline.get_or_insert_with(|| Instant::now() + RECOVERY_BUDGET);
                if Instant::now() >= until {
                    return Ok(ToolExecutionOutput::OutcomeUnknown(format!(
                        "operation {id}: {error}"
                    )));
                }
                // Reconnect only to observe the same operation and incarnation. Never repeat
                // start, write, or control requests whose response may have been lost.
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Ok(ToolExecutionOutput::OutcomeUnknown(format!(
                    "operation {id}: {error}"
                )));
            }
        }
        if Instant::now() >= deadline
            || cancel_deadline.is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Ok(ToolExecutionOutput::OutcomeUnknown(format!(
                "operation {id}: final state unavailable"
            )));
        }
    }
}

fn append_tail(tail: &mut String, text: &str) {
    tail.push_str(text);
    let mut remove = tail
        .len()
        .saturating_sub(exec_server_protocol::MAX_OUTPUT_BYTES);
    while !tail.is_char_boundary(remove) {
        remove += 1;
    }
    tail.drain(..remove);
}

#[derive(Default)]
pub(crate) struct EnvironmentPolicy {
    tools: Option<Arc<EnvironmentTools>>,
}
impl ActionPolicyService for EnvironmentPolicy {
    fn check_approval_mode(&self, mode: ash_protocol::ApprovalMode) -> Result<(), CoreError> {
        if self.tools.as_ref().is_some_and(|tools| {
            tools
                .environments
                .values()
                .any(|environment| !environment.info().allowed_approval_modes.contains(&mode))
        }) {
            return Err(CoreError::Policy(
                "approval mode is prohibited by an execution host's permission requirements".into(),
            ));
        }
        Ok(())
    }
    fn permission_context(
        &self,
        _: &ash_protocol::SessionId,
        _: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_protocol::ReviewEvidence>, CoreError> {
        let Some(tools) = &self.tools else {
            return Ok(vec![]);
        };
        tools.environments.values().take(32).map(|environment| {
            let constrained = tools.permission_snapshot(environment)?;
            Ok(ash_protocol::ReviewEvidence::new(ash_protocol::ReviewEvidenceKind::EnvironmentFact,
                ash_protocol::ReviewEvidenceTrust::TrustedHost, format!("execution-permissions:{}", environment.info().environment_id),
                json!({"environment": environment.info(), "effectiveConstraints": constrained.constraints(),
                    "networkApproval": "core-exact-request"}).to_string()))
        }).collect()
    }
    fn revision(&self) -> String {
        REVISION.into()
    }
    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        if request.action_policy_revision().as_str() != REVISION
            || request.provenance().source_id() != "environment"
        {
            return Err(CoreError::Policy(
                "execution policy revision mismatch".into(),
            ));
        }
        Ok(ExecutionDecision::AskUser(ApprovalRequest::new(
            request.action().digest().clone(),
            request.action().required_capabilities().clone(),
            "Approve this operation in the selected execution environment.",
        )))
    }
}

/// Credential references are host configuration, never model-controlled tool arguments.
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum EndpointConfig {
    Tcp {
        environment: String,
        address: std::net::SocketAddr,
        token_file: std::path::PathBuf,
    },
    Ssh {
        environment: String,
        host: String,
        root: String,
        runtime: String,
        ssh_executable: Option<std::path::PathBuf>,
        #[serde(default)]
        network: exec_server_protocol::NetworkAccess,
    },
}

pub(crate) fn load_environments(path: &Path) -> Result<Vec<ExecutionEnvironment>, String> {
    load_environments_observed(path, &mut |measurement| {
        // Standalone App Server startup has no global log logger. Its existing
        // stderr diagnostic stream remains separate from the stdio RPC transport.
        eprintln!(
            "Ash execution environment initial_connection: transport={:?} outcome={:?} elapsed_micros={}",
            measurement.transport,
            measurement.outcome,
            measurement.elapsed.as_micros(),
        );
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConnectionTransport {
    Tcp,
    Ssh,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConnectionOutcome {
    Success,
    Failure,
}

#[derive(Clone, Copy, Debug)]
struct ConnectionMeasurement {
    transport: ConnectionTransport,
    outcome: ConnectionOutcome,
    elapsed: Duration,
}

// The host owns configured environment installation, including credential preparation
// and the expected identity check. Measure that whole operation once; pooled socket
// replacement and tool requests are not new installations. This synchronous loader
// has no cancellation contract, so it does not invent cancellation outcomes.
fn load_environments_observed(
    path: &Path,
    observer: &mut impl FnMut(ConnectionMeasurement),
) -> Result<Vec<ExecutionEnvironment>, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let entries: Vec<EndpointConfig> =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    entries
        .into_iter()
        .map(|entry| {
            let transport = match &entry {
                EndpointConfig::Tcp { .. } => ConnectionTransport::Tcp,
                EndpointConfig::Ssh { .. } => ConnectionTransport::Ssh,
            };
            let started = Instant::now();
            let result = connect_environment(path, entry);
            observer(ConnectionMeasurement {
                transport,
                outcome: if result.is_ok() {
                    ConnectionOutcome::Success
                } else {
                    ConnectionOutcome::Failure
                },
                elapsed: started.elapsed(),
            });
            result
        })
        .collect()
}

fn connect_environment(path: &Path, entry: EndpointConfig) -> Result<ExecutionEnvironment, String> {
    let (environment, client) = match entry {
        EndpointConfig::Tcp {
            environment,
            address,
            token_file,
        } => {
            let token_path = if token_file.is_absolute() {
                token_file
            } else {
                path.parent()
                    .ok_or("Execution configuration path has no parent")?
                    .join(token_file)
            };
            let token = std::fs::read_to_string(token_path).map_err(|error| error.to_string())?;
            let endpoint = exec_server::RemoteEndpoint::new(address, token.trim().into())
                .map_err(|error| error.to_string())?;
            (environment, exec_server::ExecClient::connect(endpoint))
        }
        EndpointConfig::Ssh {
            environment,
            host,
            root,
            runtime,
            ssh_executable,
            network,
        } => {
            let mut target = exec_server::SshEndpoint::new(&host, &root, &runtime, &environment)
                .map_err(|error| error.to_string())?
                .with_network_access(network);
            if let Some(executable) = ssh_executable {
                target = target.with_executable(executable);
            }
            (environment, exec_server::ExecClient::connect_ssh(target))
        }
    };
    let client = client.map_err(|error| error.to_string())?;
    if client.info().environment_id != environment {
        return Err("execution environment identity mismatch".into());
    }
    Ok(ExecutionEnvironment::Remote(client))
}

pub(crate) fn port(
    environments: Vec<ExecutionEnvironment>,
    permissions: Arc<dyn Fn() -> crate::local_tools::LocalToolConfig + Send + Sync>,
) -> Result<crate::tool_composition::ToolPort, String> {
    let tools = Arc::new(EnvironmentTools::new(environments, permissions)?);
    Ok(crate::tool_composition::ToolPort::environment(
        tools.clone(),
        Arc::new(EnvironmentPolicy { tools: Some(tools) }),
    ))
}

#[cfg(test)]
#[path = "execution_environment_config_tests.rs"]
mod config_tests;

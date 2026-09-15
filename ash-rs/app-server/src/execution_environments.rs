//! Host-selected execution environments exposed to the existing Core tool lifecycle.

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ActionPolicyService;
use ash_core::CoreError;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use exec_server::ExecutionEnvironment;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use serde::Deserialize;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

const REVISION: &str = "execution-environments-v1";

pub(crate) struct EnvironmentTools {
    environments: BTreeMap<String, ExecutionEnvironment>,
}

impl EnvironmentTools {
    pub(crate) fn new(environments: Vec<ExecutionEnvironment>) -> Result<Self, String> {
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
        })
    }

    fn materialize(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<(&ExecutionEnvironment, Request), CoreError> {
        let arguments: Arguments = serde_json::from_value(call.arguments.clone())
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let environment = self
            .environments
            .get(&arguments.environment)
            .ok_or_else(|| CoreError::Policy("unknown execution environment".into()))?;
        let request = match arguments.operation {
            Operation::Command {
                program,
                arguments,
                cwd,
                timeout_millis,
            } => {
                let identity = facts.execution_identity().ok_or_else(|| {
                    CoreError::Policy(
                        "execution requires a durable Thread and Turn identity".into(),
                    )
                })?;
                let key = serde_json::to_vec(&(
                    environment.info().incarnation.as_str(),
                    identity.session_id(),
                    identity.thread_id(),
                    identity.turn_id(),
                    &call.id,
                ))
                .map_err(|error| CoreError::Policy(error.to_string()))?;
                let id = format!("{:x}", Sha256::digest(key));
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
                Request::ProcessStart(params)
            }
            Operation::Read { path } => {
                validate_path(&path)?;
                Request::FileRead { path }
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
                Request::FileWrite {
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
            Request::FileRead { .. } => CapabilityKind::FileRead,
            Request::FileWrite { .. } => CapabilityKind::FileWrite,
            _ => CapabilityKind::ProcessSpawn,
        };
        let canonical =
            serde_json::to_vec(&json!({"environment":environment.info(),"request":request}))
                .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(&canonical),
                ActionKind::ExternalServiceMutation,
                match &request {
                    Request::ProcessStart(start) => format!(
                        "Run {} in environment {} (directory {})",
                        start.program,
                        environment.info().environment_id,
                        start.cwd
                    ),
                    Request::FileRead { path } => format!(
                        "Read {path} in environment {}",
                        environment.info().environment_id
                    ),
                    Request::FileWrite { path, .. } => format!(
                        "Write {path} in environment {}",
                        environment.info().environment_id
                    ),
                    _ => unreachable!(),
                },
                CapabilitySet::new([Capability::new(
                    kind,
                    format!(
                        "{}:{}",
                        environment.info().environment_id,
                        environment.info().incarnation
                    ),
                )]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "environment"),
            SandboxCompatibility::NotApplicable {
                reason:
                    "the execution host enforces its own immutable filesystem and network ceiling"
                        .into(),
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
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let (environment, request) = self.materialize(call, facts)?;
        if let Request::ProcessStart(start) = request {
            return run_command(environment, start, cancellation, sink);
        }
        match environment.request(request) {
            Ok(Response::File(content)) => match String::from_utf8(content.bytes) {
                Ok(text) => Ok(ToolExecutionOutput::Success(
                    json!({"content":text,"revision":content.revision}).to_string(),
                )),
                Err(_) => Ok(ToolExecutionOutput::Failure(
                    "file is not UTF-8 text".into(),
                )),
            },
            Ok(Response::Written) => Ok(ToolExecutionOutput::Success("file written".into())),
            Ok(_) => Err(CoreError::Execution("unexpected execution response".into())),
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
    sink: &mut dyn ToolOutputSink,
) -> Result<ToolExecutionOutput, CoreError> {
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
    loop {
        if cancellation.check().is_err() && !cancelled {
            cancelled = true;
            cancel_deadline = Some(Instant::now() + Duration::from_secs(5));
            let _ = environment.request(Request::ProcessCancel {
                operation_id: id.clone(),
            });
        }
        match environment.request(Request::ProcessRead(ProcessRead {
            operation_id: id.clone(),
            stdout_cursor,
            stderr_cursor,
        })) {
            Ok(Response::Process(mut snapshot)) => {
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
        std::thread::sleep(Duration::from_millis(25));
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

pub(crate) struct EnvironmentPolicy;
impl ActionPolicyService for EnvironmentPolicy {
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
#[serde(deny_unknown_fields)]
struct EndpointConfig {
    environment: String,
    address: std::net::SocketAddr,
    token_file: std::path::PathBuf,
}

pub(crate) fn load_environments(path: &Path) -> Result<Vec<ExecutionEnvironment>, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let entries: Vec<EndpointConfig> =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    entries
        .into_iter()
        .map(|entry| {
            let token_path = if entry.token_file.is_absolute() {
                entry.token_file
            } else {
                path.parent()
                    .unwrap_or(Path::new("."))
                    .join(entry.token_file)
            };
            let token = std::fs::read_to_string(token_path).map_err(|error| error.to_string())?;
            let endpoint = exec_server::RemoteEndpoint::new(entry.address, token.trim().into())
                .map_err(|error| error.to_string())?;
            let client =
                exec_server::ExecClient::connect(endpoint).map_err(|error| error.to_string())?;
            if client.info().environment_id != entry.environment {
                return Err("execution environment identity mismatch".into());
            }
            Ok(ExecutionEnvironment::Remote(client))
        })
        .collect()
}

pub(crate) fn port(
    environments: Vec<ExecutionEnvironment>,
) -> Result<crate::tool_composition::ToolPort, String> {
    Ok(crate::tool_composition::ToolPort::environment(
        Arc::new(EnvironmentTools::new(environments)?),
        Arc::new(EnvironmentPolicy),
    ))
}

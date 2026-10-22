//! Real child commands for history/RPC tests, independent of provisioned OS sandboxes.
//! Windows account isolation has its own explicitly provisioned acceptance test.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolExecutionOutput;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_file_access::Permission;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::Capability;
use ash_protocol::CapabilityKind;
use ash_protocol::CapabilitySet;
use ash_protocol::ProcessInvocationKind;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxBackends;
use ash_sandboxing::SandboxPolicy;
use core_api::ActionPolicyService;
use core_api::CoreError;
use exec_server::execution::CommandExecutionAuthority;
use exec_server::execution::CommandExecutionOutcome;
use exec_server::execution::CommandInput;
use exec_server::execution::CommandRequest;
use exec_server::execution::ExecutionLimits;
use exec_server::execution::ProcessExecutor;

pub(crate) fn install(server: crate::AppServer) -> crate::AppServer {
    let grants = server.env_runtime.read().unwrap().dir_grants.clone();
    server.with_tool_service(Arc::new(Shell { grants }), Arc::new(Policy))
}

struct Shell {
    grants: Arc<crate::dir_grants::DirGrants>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    program: String,
    arguments: Vec<String>,
    working_directory: PathBuf,
}

impl ToolService for Shell {
    fn tool_set(&self, _: &ash_protocol::ToolName) -> Option<&'static str> {
        Some("core.execution")
    }

    fn tool_category(&self, _: &ash_protocol::ToolName) -> Option<ash_protocol::ToolCategory> {
        Some(ash_protocol::ToolCategory::Execute)
    }

    fn activity(&self, call: &ToolCall) -> Option<ash_protocol::ToolActivity> {
        let arguments: Arguments = serde_json::from_value(call.arguments.clone()).ok()?;
        Some(ash_protocol::ToolActivity::Command {
            program: arguments.program,
            arguments: arguments.arguments,
            working_directory: arguments.working_directory.to_string_lossy().into_owned(),
        })
    }

    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ash_protocol::ToolName::new("shell-command").unwrap(),
            description: "Execute the history fixture's child command".into(),
            parameters: serde_json::json!({
                "type":"object", "properties":{
                    "program":{"type":"string"}, "arguments":{"type":"array","items":{"type":"string"}},
                    "working_directory":{"type":"string"}
                }, "required":["program","arguments","working_directory"], "additionalProperties":false
            }),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(call.arguments.to_string()),
                ActionKind::LocalProcess(ProcessInvocationKind::Shell),
                "execute isolated history fixture command",
                CapabilitySet::new([
                    Capability::new(CapabilityKind::FileRead, "/"),
                    Capability::new(CapabilityKind::FileWrite, "/"),
                    Capability::new(CapabilityKind::ProcessSpawn, "fixture"),
                ]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
            SandboxCompatibility::Supported(policy()),
            ActionPolicyRevision::new("history-fixture-v1"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Policy(
            "history fixture requires durable Thread identity".into(),
        ))
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let identity = facts
            .execution_identity()
            .ok_or_else(|| CoreError::Policy("missing fixture caller".into()))?;
        let scope = self
            .grants
            .thread_scope(identity.thread_id(), Permission::ExecuteCommands)
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .ok_or_else(|| CoreError::Policy("missing fixture directory grant".into()))?;
        let authorization = scope.primary();
        let arguments: Arguments = serde_json::from_value(call.arguments.clone())
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let executor = ProcessExecutor::new(
            authorization.dir().clone(),
            SandboxBackends::new(Vec::new()),
            ExecutionLimits {
                timeout: Duration::from_secs(30),
                max_output_bytes: 64 * 1024,
            },
        );
        // Keep the real command, process lifecycle and current Thread grant. This fixture
        // exercises history capture; it does not claim to enforce a kernel sandbox.
        let outcome = authorization
            .execute(
                authorization.subject(),
                authorization.dir(),
                Permission::ExecuteCommands,
                || {
                    executor.execute(
                        CommandRequest {
                            program: arguments.program,
                            arguments: arguments.arguments,
                            working_directory: arguments.working_directory,
                            input: CommandInput::Closed,
                        },
                        CommandExecutionAuthority::Unrestricted,
                        cancellation,
                    )
                },
            )
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .map_err(|error| CoreError::Execution(format!("{error:?}")))?;
        match outcome {
            CommandExecutionOutcome::Completed(output) => Ok(ToolExecutionOutput::Success(serde_json::json!({
                "exit_code":output.exit_code, "stdout":output.stdout, "stderr":output.stderr,
                "stdout_truncated":output.stdout_truncated, "stderr_truncated":output.stderr_truncated,
            }).to_string())),
            CommandExecutionOutcome::SandboxDenied(denial) => Ok(ToolExecutionOutput::Failure(denial.reason().into())),
        }
    }
}

struct Policy;

impl ActionPolicyService for Policy {
    fn revision(&self) -> String {
        "history-fixture-v1".into()
    }
    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunSandboxed(policy()))
    }
}

fn policy() -> SandboxPolicy {
    SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
}

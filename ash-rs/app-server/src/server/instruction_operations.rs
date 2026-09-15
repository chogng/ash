use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::instructions::InstructionDiagnosticDto;
use ash_app_server_protocol::protocol::instructions::InstructionDto;
use ash_app_server_protocol::protocol::instructions::InstructionListParams;
use ash_app_server_protocol::protocol::instructions::InstructionListResult;
use ash_app_server_protocol::protocol::instructions::InstructionLoadDto;
use ash_app_server_protocol::protocol::instructions::InstructionScopeDto;
use ash_instructions::InstructionCatalogSnapshot;
use ash_instructions::InstructionLoadPolicy;
use ash_protocol::SessionId;
use ash_protocol::UserInput;
use serde_json::Value;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

struct InstructionSource {
    root: PathBuf,
    files: PathBuf,
    scope: InstructionScopeDto,
    snapshot: Arc<InstructionCatalogSnapshot>,
}

impl AppServer {
    fn instruction_sources(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<InstructionSource>, RpcError> {
        let mut sources = Vec::new();
        if let Some(home) = &self.home {
            sources.push(InstructionSource {
                root: home.root().to_path_buf(),
                files: home.root().join("instructions"),
                scope: InstructionScopeDto::User,
                snapshot: home.instructions(),
            });
        }
        let runtime = self
            .env_runtime
            .read()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if let Some(contributions) = &runtime._dir_contributions {
            sources.extend(
                contributions
                    .directory_instruction_sources(session_id)
                    .into_iter()
                    .map(|(root, snapshot)| InstructionSource {
                        files: root.join(".ash/instructions"),
                        root,
                        snapshot,
                        scope: InstructionScopeDto::Directory,
                    }),
            );
        }
        Ok(sources)
    }

    pub(super) fn instruction_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: InstructionListParams = decode(params)?;
        let mut response = InstructionListResult {
            instructions: Vec::new(),
            diagnostics: Vec::new(),
        };
        for source in self.instruction_sources(&params.session_id)? {
            for (path, _) in source.snapshot.always_on_files() {
                response.instructions.push(InstructionDto {
                    path: source.root.join(path).display().to_string(),
                    scope: source.scope,
                    name: path.display().to_string(),
                    description: None,
                    load: InstructionLoadDto::Global,
                    patterns: Vec::new(),
                });
            }
            for entry in source.snapshot.entries() {
                let (load, patterns) = match entry.load_policy() {
                    InstructionLoadPolicy::Global => (InstructionLoadDto::Global, Vec::new()),
                    InstructionLoadPolicy::Contextual { patterns } => {
                        (InstructionLoadDto::Contextual, patterns.clone())
                    }
                    InstructionLoadPolicy::OnDemand => (InstructionLoadDto::OnDemand, Vec::new()),
                };
                response.instructions.push(InstructionDto {
                    path: source
                        .files
                        .join(entry.relative_path())
                        .display()
                        .to_string(),
                    scope: source.scope,
                    name: entry.name().into(),
                    description: entry.description().map(str::to_owned),
                    load,
                    patterns,
                });
            }
            response
                .diagnostics
                .extend(source.snapshot.diagnostics().iter().map(|diagnostic| {
                    InstructionDiagnosticDto {
                        path: source
                            .root
                            .join(diagnostic.relative_path().unwrap_or(Path::new(".")))
                            .display()
                            .to_string(),
                        message: diagnostic.message().into(),
                    }
                }));
        }
        response
            .instructions
            .sort_by(|left, right| left.path.cmp(&right.path));
        response
            .diagnostics
            .sort_by(|left, right| left.path.cmp(&right.path));
        result(&response)
    }

    pub(super) fn attach_instruction(
        &self,
        session_id: &SessionId,
        path: &str,
    ) -> Result<UserInput, RpcError> {
        // Select only from current authorized catalogs; never read an arbitrary client path.
        for source in self.instruction_sources(session_id)? {
            if let Some(body) =
                source
                    .snapshot
                    .body_at(Path::new(path), &source.root, &source.files)
            {
                return Ok(UserInput::Context {
                    name: path.into(),
                    content: ash_core::HarnessInstruction::new(
                        match source.scope {
                            InstructionScopeDto::User => ash_core::InstructionScope::User,
                            InstructionScopeDto::Directory => ash_core::InstructionScope::Directory,
                        },
                        path,
                        source.root.display().to_string(),
                        ash_core::InstructionActivation::Selected,
                        body,
                    )
                    .render(),
                });
            }
        }
        Err(RpcError::new(-32602, AppServerErrorName::InvalidParams))
    }
}

/// Reads catalog-owned rules without granting access to other files in the user's home.
pub(super) struct InstructionToolService {
    catalogs: Arc<super::dir_contributions::DirContributions>,
    revision: ash_action_policy::ActionPolicyRevision,
}

impl InstructionToolService {
    pub(super) fn new(
        catalogs: Arc<super::dir_contributions::DirContributions>,
        revision: ash_action_policy::ActionPolicyRevision,
    ) -> Self {
        Self { catalogs, revision }
    }
}

impl ash_core::ToolService for InstructionToolService {
    fn definitions(&self) -> Vec<ash_protocol::ToolDefinition> {
        vec![ash_protocol::ToolDefinition {
            name: ash_protocol::ToolName::new("read_instruction").expect("valid tool name"),
            description: "Read the complete body of an instruction file from the current authorized instruction catalog. Use the exact path from available-instructions or instruction preflight feedback. Cannot read arbitrary files.".into(),
            parameters: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            strict: true,
        }]
    }
    fn prepare(
        &self,
        call: &ash_protocol::ToolCall,
    ) -> Result<ash_action_policy::ActionReviewRequest, core_api::CoreError> {
        if call.name.as_str() != "read_instruction" {
            return Err(core_api::CoreError::InvalidInput(
                "unknown instruction tool".into(),
            ));
        }
        Ok(ash_action_policy::ActionReviewRequest::new(
            ash_action_policy::ResolvedAction::new(
                ash_action_policy::ActionDigest::from_canonical_bytes(
                    serde_json::to_vec(call)
                        .map_err(|error| core_api::CoreError::InvalidInput(error.to_string()))?,
                ),
                ash_action_policy::ActionKind::SystemOperation,
                "read a catalog instruction",
                ash_action_policy::CapabilitySet::new([]),
            ),
            ash_action_policy::ActionProvenance::new(
                ash_action_policy::ActionSource::BuiltInTool,
                "read_instruction",
            ),
            ash_action_policy::SandboxCompatibility::NotApplicable {
                reason: "reads only the authorized instruction catalog".into(),
            },
            self.revision.clone(),
        ))
    }
    fn execute(
        &self,
        _: &ash_protocol::ToolCall,
        _: &ash_core::ToolAuthorization,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ToolExecutionOutput, core_api::CoreError> {
        Err(core_api::CoreError::Execution(
            "instruction reading requires a session identity".into(),
        ))
    }
    fn execute_with_facts(
        &self,
        call: &ash_protocol::ToolCall,
        _: &ash_core::ToolAuthorization,
        cancellation: &ash_async_utils::CancellationToken,
        facts: &ash_core::ToolExecutionFacts,
    ) -> Result<ash_protocol::ToolExecutionOutput, core_api::CoreError> {
        cancellation
            .check()
            .map_err(|signal| core_api::CoreError::Cancelled(signal.reason().to_string()))?;
        let identity = facts.execution_identity().ok_or_else(|| {
            core_api::CoreError::Execution("instruction reading requires a session identity".into())
        })?;
        let path = call
            .arguments
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                core_api::CoreError::InvalidInput("instruction path is required".into())
            })?;
        Ok(
            match self
                .catalogs
                .read_instruction(identity.session_id(), Path::new(path))
            {
                Some(body) => ash_protocol::ToolExecutionOutput::Success(body),
                None => ash_protocol::ToolExecutionOutput::Failure(
                    "Instruction is not present in the current authorized catalog".into(),
                ),
            },
        )
    }
    fn execute_streaming_with_facts(
        &self,
        call: &ash_protocol::ToolCall,
        authorization: &ash_core::ToolAuthorization,
        cancellation: &ash_async_utils::CancellationToken,
        facts: &ash_core::ToolExecutionFacts,
        _: &mut dyn ash_core::ToolOutputSink,
    ) -> Result<ash_protocol::ToolExecutionOutput, core_api::CoreError> {
        self.execute_with_facts(call, authorization, cancellation, facts)
    }
}

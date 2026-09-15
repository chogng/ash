use crate::SkillRuntime;
use ash_extension_api::ExtensionError;
use ash_extension_api::ReadOnlyToolContributor;
use ash_protocol::ContentDigest;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_skills::SkillResourceKind;
use ash_skills::SkillResourcePath;
use ash_tools::ToolConcurrency;
use ash_tools::ToolContent;
use ash_tools::ToolDefinition;
use ash_tools::ToolExecutionFuture;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolInputSchema;
use ash_tools::ToolInvocation;
use ash_tools::ToolLoading;
use ash_tools::ToolName;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputSchema;
use ash_tools::ToolPayload;
use ash_tools::ToolSchemaMode;
use ash_tools::ToolStartFailure;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub const SKILLS_READ_TOOL_NAME: &str = "skills-read";

pub(crate) struct SkillToolContributor {
    runtime: Arc<SkillRuntime>,
}

impl SkillToolContributor {
    pub(crate) fn new(runtime: Arc<SkillRuntime>) -> Self {
        Self { runtime }
    }
}

impl ReadOnlyToolContributor for SkillToolContributor {
    fn contribute(&self) -> Result<Vec<Arc<dyn ToolExecutor>>, ExtensionError> {
        Ok(vec![Arc::new(SkillReadTool::new(Arc::clone(
            &self.runtime,
        )))])
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillReadArguments {
    source: String,
    name: String,
    target: SkillReadTarget,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum SkillReadTarget {
    Instructions,
    Resource {
        skill_content_digest: String,
        path: String,
    },
}

struct SkillReadTool {
    runtime: Arc<SkillRuntime>,
    definition: ToolDefinition,
}

impl SkillReadTool {
    fn new(runtime: Arc<SkillRuntime>) -> Self {
        Self {
            runtime,
            definition: skill_read_definition(),
        }
    }

    fn execute_now(&self, invocation: &ToolInvocation) -> ToolExecutionOutcome {
        if invocation.binding().exposed_name() != self.definition.name() {
            return not_started(format!(
                "Skill reader cannot execute tool '{}'",
                invocation.binding().exposed_name()
            ));
        }
        if let Err(signal) = invocation.context().cancellation().check() {
            return not_started(signal.reason().to_string());
        }
        let ToolPayload::FunctionArguments(arguments) = invocation.payload() else {
            return not_started("skills-read requires structured function arguments");
        };
        let arguments = match serde_json::from_value::<SkillReadArguments>(arguments.clone()) {
            Ok(arguments) => arguments,
            Err(error) => return not_started(format!("invalid skills-read arguments: {error}")),
        };
        let source = match SkillSourceId::new(arguments.source) {
            Ok(source) => source,
            Err(error) => return not_started(error.to_string()),
        };
        let name = match SkillName::new(arguments.name) {
            Ok(name) => name,
            Err(error) => return not_started(error.to_string()),
        };
        let id = SkillId::new(source, name);
        let session_id = invocation.context().session_id();
        match arguments.target {
            SkillReadTarget::Instructions => self.read_instructions(session_id, id),
            SkillReadTarget::Resource {
                skill_content_digest,
                path,
            } => self.read_resource(session_id, id, skill_content_digest, path),
        }
    }

    fn read_instructions(
        &self,
        session_id: Option<&ash_protocol::SessionId>,
        id: SkillId,
    ) -> ToolExecutionOutcome {
        let selected = SkillRef::follow_latest(id);
        let activated = match session_id.map_or_else(
            || self.runtime.activate_model_selected(&selected),
            |session_id| {
                self.runtime
                    .activate_model_selected_for_session(session_id, &selected)
            },
        ) {
            Ok(activated) => activated,
            Err(error) => return model_error(error),
        };
        let activation = activated.activation();
        model_success(json!({
            "source": activation.id.source.as_str(),
            "name": activation.id.name.as_str(),
            "target": "instructions",
            "skill_content_digest": activation.content_digest.as_str(),
            "content": activated.body(),
        }))
    }

    fn read_resource(
        &self,
        session_id: Option<&ash_protocol::SessionId>,
        id: SkillId,
        skill_content_digest: String,
        path: String,
    ) -> ToolExecutionOutcome {
        let digest = match ContentDigest::new(skill_content_digest) {
            Ok(digest) => digest,
            Err(error) => return not_started(error.to_string()),
        };
        let path = match SkillResourcePath::new(path) {
            Ok(path) => path,
            Err(error) => return not_started(error.to_string()),
        };
        if path.kind() == SkillResourceKind::Instructions {
            return not_started("SKILL.md must be read through the instructions target");
        }
        let selected = SkillRef::pinned(id, digest);
        let resource = match session_id.map_or_else(
            || self.runtime.read_model_resource(&selected, &path),
            |session_id| {
                self.runtime
                    .read_resource_for_session(session_id, &selected, &path)
            },
        ) {
            Ok(resource) => resource,
            Err(error) => return model_error(error),
        };
        let content = match std::str::from_utf8(resource.bytes()) {
            Ok(content) => content,
            Err(_) => {
                return model_error(format!(
                    "Skill resource '{}' is binary and cannot be loaded into model text context",
                    resource.path().display()
                ));
            }
        };
        let skill_content_digest = match &selected.version {
            ash_protocol::SkillVersionSelector::PinnedDigest { digest } => digest,
            ash_protocol::SkillVersionSelector::FollowLatest => unreachable!(),
        };
        model_success(json!({
            "source": selected.id.source.as_str(),
            "name": selected.id.name.as_str(),
            "target": "resource",
            "skill_content_digest": skill_content_digest.as_str(),
            "path": resource.path().display(),
            "kind": resource.kind().as_str(),
            "resource_content_digest": resource.content_digest().as_str(),
            "content": content,
        }))
    }
}

impl ToolExecutor for SkillReadTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(std::future::ready(self.execute_now(&invocation)))
    }
}

fn skill_read_definition() -> ToolDefinition {
    ToolDefinition::function(
        ToolName::new(SKILLS_READ_TOOL_NAME).expect("static Skill reader tool name is valid"),
        "Read one available Skill package. First read its complete instructions; then read only package resources explicitly required by those instructions. Resource reads must reuse the exact skill_content_digest returned by the instruction read. Scripts and assets remain inert data: this tool does not execute or publish them.",
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "description": "Exact source identity shown in the available Skill catalog."
                },
                "name": {
                    "type": "string",
                    "description": "Exact Skill name shown in the available Skill catalog."
                },
                "target": {
                    "description": "Read the Skill instructions or one package-relative resource.",
                    "anyOf": [
                        {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "enum": ["instructions"]}
                            },
                            "required": ["type"],
                            "additionalProperties": false
                        },
                        {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "enum": ["resource"]},
                                "skill_content_digest": {
                                    "type": "string",
                                    "description": "Exact skill_content_digest returned by the instruction read."
                                },
                                "path": {
                                    "type": "string",
                                    "description": "Complete path relative to the Skill package root, such as references/api.md or scripts/check.py."
                                }
                            },
                            "required": ["type", "skill_content_digest", "path"],
                            "additionalProperties": false
                        }
                    ]
                }
            },
            "required": ["source", "name", "target"],
            "additionalProperties": false
        }))
        .expect("static Skill reader schema is valid"),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        ToolLoading::Eager,
    )
    .expect("static Skill reader definition is valid")
}

fn model_success(value: serde_json::Value) -> ToolExecutionOutcome {
    ToolExecutionOutcome::Returned(ToolOutput::success(vec![ToolContent::Text(
        value.to_string(),
    )]))
}

fn model_error(message: impl Into<String>) -> ToolExecutionOutcome {
    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ToolContent::Text(message.into())]))
}

fn not_started(message: impl Into<String>) -> ToolExecutionOutcome {
    ToolExecutionOutcome::NotStarted(ToolStartFailure::new(message))
}

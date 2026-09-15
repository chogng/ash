//! Bounded, read-only filesystem operations exposed as one model-visible tool.

use ash_file_system::{FileSystem, FileType};
use ash_tools::{
    ToolConcurrency, ToolDefinition, ToolExecutionFuture, ToolExecutionOutcome, ToolExecutor,
    ToolInputSchema, ToolInvocation, ToolLoading, ToolName, ToolOutput, ToolOutputSchema,
    ToolPayload, ToolSchemaMode, ToolStartFailure,
};
use serde::Deserialize;
use serde_json::json;
use std::fmt;
use std::future;
use std::path::PathBuf;
use std::sync::Arc;

const DEFAULT_MAX_READ_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_LIST_ENTRIES: usize = 1_000;

/// Bounded result limits for the read-only file-system tool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileSystemLimits {
    max_read_bytes: usize,
    max_list_entries: usize,
}

impl FileSystemLimits {
    pub fn new(
        max_read_bytes: usize,
        max_list_entries: usize,
    ) -> Result<Self, FileSystemToolError> {
        if max_read_bytes == 0 {
            return Err(FileSystemToolError::InvalidLimit {
                kind: "maximum read bytes",
            });
        }
        if max_list_entries == 0 {
            return Err(FileSystemToolError::InvalidLimit {
                kind: "maximum list entries",
            });
        }
        Ok(Self {
            max_read_bytes,
            max_list_entries,
        })
    }

    pub fn max_read_bytes(self) -> usize {
        self.max_read_bytes
    }

    pub fn max_list_entries(self) -> usize {
        self.max_list_entries
    }
}

impl Default for FileSystemLimits {
    fn default() -> Self {
        Self {
            max_read_bytes: DEFAULT_MAX_READ_BYTES,
            max_list_entries: DEFAULT_MAX_LIST_ENTRIES,
        }
    }
}

/// Error raised while configuring the file-system tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileSystemToolError {
    InvalidLimit { kind: &'static str },
    Definition(String),
}

impl fmt::Display for FileSystemToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit { kind } => write!(formatter, "{kind} must be greater than zero"),
            Self::Definition(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for FileSystemToolError {}

/// Reads, lists, or describes an existing directory path without modifying it.
pub struct FileSystemTool {
    environment_id: ash_tools::EnvId,
    file_system: Arc<dyn FileSystem>,
    limits: FileSystemLimits,
    definition: ToolDefinition,
}

impl FileSystemTool {
    pub fn new(
        environment_id: ash_tools::EnvId,
        file_system: Arc<dyn FileSystem>,
        limits: FileSystemLimits,
    ) -> Result<Self, FileSystemToolError> {
        Ok(Self {
            environment_id,
            file_system,
            limits,
            definition: file_system_definition()?,
        })
    }

    fn run(&self, invocation: ToolInvocation) -> ToolExecutionOutcome {
        if invocation.context().environment_id() != &self.environment_id {
            return not_started("tool invocation selected a different local environment");
        }
        if let Err(outcome) = validate_invocation(&self.definition, &invocation) {
            return outcome;
        }
        let input: FileSystemInput = match decode_arguments(&invocation) {
            Ok(input) => input,
            Err(outcome) => return outcome,
        };
        match input.operation {
            FileSystemOperation::Read => self.read(input.path),
            FileSystemOperation::List => self.list(input.path),
            FileSystemOperation::Metadata => self.metadata(input.path),
        }
    }

    fn read(&self, path: PathBuf) -> ToolExecutionOutcome {
        match self
            .file_system
            .read_file(&path, self.limits.max_read_bytes())
        {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => returned_json(json!({
                    "tool": "file-system",
                    "result": {"operation": "read", "path": path, "content": text}
                })),
                Err(_) => returned_error("could not read file: file is not valid UTF-8 text"),
            },
            Err(error) => returned_error(format!("could not read file: {error}")),
        }
    }

    fn list(&self, path: PathBuf) -> ToolExecutionOutcome {
        let directory_path = if path.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            path.clone()
        };
        let mut entries = match self.file_system.read_directory(&directory_path) {
            Ok(entries) => entries,
            Err(error) => return returned_error(format!("could not list directory: {error}")),
        };
        let truncated = entries.len() > self.limits.max_list_entries();
        entries.truncate(self.limits.max_list_entries());
        let entries = entries
            .into_iter()
            .map(|entry| {
                json!({
                    "name": entry.name,
                    "kind": file_type_name(entry.file_type),
                })
            })
            .collect::<Vec<_>>();
        returned_json(json!({
            "tool": "file-system",
            "result": {
                "operation": "list",
                "path": path,
                "entries": entries,
                "truncated": truncated,
            }
        }))
    }

    fn metadata(&self, path: PathBuf) -> ToolExecutionOutcome {
        match self.file_system.get_metadata(&path) {
            Ok(metadata) => returned_json(json!({
                "tool": "file-system",
                "result": {
                    "operation": "metadata",
                    "path": path,
                    "kind": file_type_name(metadata.file_type),
                    "size_bytes": metadata.size_bytes,
                    "readonly": metadata.readonly,
                }
            })),
            Err(error) => returned_error(format!("could not inspect path: {error}")),
        }
    }
}

impl ToolExecutor for FileSystemTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(future::ready(self.run(invocation)))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum FileSystemOperation {
    Read,
    List,
    Metadata,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileSystemInput {
    operation: FileSystemOperation,
    path: PathBuf,
}

fn file_system_definition() -> Result<ToolDefinition, FileSystemToolError> {
    ToolDefinition::function(
        ToolName::new("file-system").map_err(definition_error)?,
        "Read an existing directory file, list one directory directory, or inspect path metadata. This tool never modifies files.",
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "operation": { "type": "string", "enum": ["read", "list", "metadata"] },
                "path": { "type": "string", "description": "Relative path within the selected directory." }
            },
            "required": ["operation", "path"],
            "additionalProperties": false
        }))
        .map_err(definition_error)?,
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .map_err(definition_error)
}

fn file_type_name(file_type: FileType) -> &'static str {
    match file_type {
        FileType::Directory => "directory",
        FileType::File => "file",
        FileType::SymbolicLink => "symlink",
        FileType::Other => "other",
    }
}

fn definition_error(error: impl fmt::Display) -> FileSystemToolError {
    FileSystemToolError::Definition(error.to_string())
}

fn validate_invocation(
    definition: &ToolDefinition,
    invocation: &ToolInvocation,
) -> Result<(), ToolExecutionOutcome> {
    if invocation.context().cancellation().is_cancelled() {
        return Err(not_started(
            "tool invocation was cancelled before it started",
        ));
    }
    if invocation.binding().exposed_name() != definition.name()
        || invocation.binding().definition_digest() != &definition.digest()
    {
        return Err(not_started(
            "tool binding does not match this executor definition",
        ));
    }
    Ok(())
}

fn decode_arguments<T: serde::de::DeserializeOwned>(
    invocation: &ToolInvocation,
) -> Result<T, ToolExecutionOutcome> {
    let ToolPayload::FunctionArguments(arguments) = invocation.payload() else {
        return Err(not_started("tool requires structured function arguments"));
    };
    serde_json::from_value(arguments.clone())
        .map_err(|error| returned_error(format!("invalid tool arguments: {error}")))
}

fn returned_error(message: impl Into<String>) -> ToolExecutionOutcome {
    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ash_tools::ToolContent::Text(
        message.into(),
    )]))
}

fn returned_json(value: serde_json::Value) -> ToolExecutionOutcome {
    match serde_json::to_string_pretty(&value) {
        Ok(text) => {
            ToolExecutionOutcome::Returned(ToolOutput::success(vec![ash_tools::ToolContent::Text(
                text,
            )]))
        }
        Err(error) => returned_error(format!("could not encode tool output: {error}")),
    }
}

fn not_started(message: impl Into<String>) -> ToolExecutionOutcome {
    ToolExecutionOutcome::NotStarted(ToolStartFailure::new(message))
}

#[cfg(test)]
#[path = "file_system_tool_tests.rs"]
mod tests;

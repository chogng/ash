//! Validated dir patch application as one model-visible tool.
//!
//! The parser accepts a documented patch grammar with context anchors, EOF markers, and moves. Every operation is prepared before any file
//! is changed, and replacement writes are atomic per file.
//! Updates retain existing line endings and EOF conventions. New files use the selected
//! directory's EditorConfig rules, shared with text writes and replacements by the filesystem layer.

mod file_update;
mod parser;
mod patch_commit;

use crate::file_update::apply_hunks;
use crate::file_update::new_file_content;
use crate::parser::PatchDocument;
use crate::parser::PatchError;
use crate::parser::PatchOperation;
use crate::patch_commit::commit;
use ash_file_access::Dir;
use ash_file_system::FileMutation;
use ash_file_system::TextFileFormat;
use ash_file_system::file_revision;
use ash_tools::{
    ToolConcurrency, ToolConflictClass, ToolDefinition, ToolExecutionFuture, ToolExecutionOutcome,
    ToolExecutor, ToolInputSchema, ToolInvocation, ToolLoading, ToolName, ToolOutput,
    ToolOutputSchema, ToolPayload, ToolSchemaMode, ToolStartFailure, ToolUncertainOutcome,
};
use serde::Deserialize;
use serde_json::json;
use std::fmt;
use std::future;

const DEFAULT_MAX_PATCH_BYTES: usize = 512 * 1024;
const DEFAULT_MAX_CHANGED_FILES: usize = 128;

/// Limits the patch text accepted and files changed by one `apply_patch` invocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApplyPatchLimits {
    max_patch_bytes: usize,
    max_changed_files: usize,
}

impl ApplyPatchLimits {
    pub fn new(max_patch_bytes: usize, max_changed_files: usize) -> Result<Self, ApplyPatchError> {
        if max_patch_bytes == 0 {
            return Err(ApplyPatchError::InvalidLimit {
                kind: "maximum patch bytes",
            });
        }
        if max_changed_files == 0 {
            return Err(ApplyPatchError::InvalidLimit {
                kind: "maximum changed files",
            });
        }
        Ok(Self {
            max_patch_bytes,
            max_changed_files,
        })
    }

    pub fn max_patch_bytes(self) -> usize {
        self.max_patch_bytes
    }

    pub fn max_changed_files(self) -> usize {
        self.max_changed_files
    }
}

impl Default for ApplyPatchLimits {
    fn default() -> Self {
        Self {
            max_patch_bytes: DEFAULT_MAX_PATCH_BYTES,
            max_changed_files: DEFAULT_MAX_CHANGED_FILES,
        }
    }
}

/// Error raised while configuring the apply_patch tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApplyPatchError {
    InvalidLimit { kind: &'static str },
    Definition(String),
}

impl fmt::Display for ApplyPatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit { kind } => write!(formatter, "{kind} must be greater than zero"),
            Self::Definition(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ApplyPatchError {}

/// Returns mutation targets using the same bounded grammar as patch execution.
/// Hosts use these paths to load applicable instructions before a patch can run.
pub fn changed_paths(
    patch: &str,
    limits: ApplyPatchLimits,
) -> Result<Vec<std::path::PathBuf>, String> {
    if patch.len() > limits.max_patch_bytes() {
        return Err("patch exceeds the byte limit".into());
    }
    let document = PatchDocument::parse(patch).map_err(|error| error.to_string())?;
    if document.paths().len() > limits.max_changed_files() {
        return Err("patch exceeds the changed-file limit".into());
    }
    Ok(document.paths())
}

/// Applies a validated, dir-contained patch.
///
/// The accepted grammar has `*** Begin Patch` / `*** End Patch` delimiters and `*** Update File:`,
/// `*** Add File:`, and `*** Delete File:` operations. Every hunk is matched against the current
/// file before any write begins; commit checks its exact byte revision again. A partial multi-file commit is reported as an uncertain outcome.
pub struct ApplyPatchTool {
    environment_id: ash_tools::EnvId,
    dir: Dir,
    limits: ApplyPatchLimits,
    definition: ToolDefinition,
}

impl ApplyPatchTool {
    pub fn new(
        environment_id: ash_tools::EnvId,
        dir: Dir,
        limits: ApplyPatchLimits,
    ) -> Result<Self, ApplyPatchError> {
        Ok(Self {
            environment_id,
            dir,
            limits,
            definition: apply_patch_definition()?,
        })
    }

    fn run(&self, invocation: ToolInvocation) -> ToolExecutionOutcome {
        if invocation.context().environment_id() != &self.environment_id {
            return not_started("tool invocation selected a different local environment");
        }
        if let Err(outcome) = validate_invocation(&self.definition, &invocation) {
            return outcome;
        }
        let input: ApplyPatchInput = match decode_arguments(&invocation) {
            Ok(input) => input,
            Err(outcome) => return outcome,
        };
        if input.patch.is_empty() {
            return returned_error("patch must not be empty");
        }
        if input.patch.len() > self.limits.max_patch_bytes() {
            return returned_error(format!(
                "patch exceeds the {}-byte limit",
                self.limits.max_patch_bytes()
            ));
        }
        let dir = match invocation.context().execution_dir() {
            Some(path) => match Dir::open_local(path) {
                Ok(dir) => dir,
                Err(error) => {
                    return not_started(format!(
                        "host-selected patch directory is unavailable: {error}"
                    ));
                }
            },
            None => self.dir.clone(),
        };
        let document = match PatchDocument::parse(&input.patch) {
            Ok(document) => document,
            Err(error) => return returned_error(format!("invalid patch: {error}")),
        };
        if document.paths().len() > self.limits.max_changed_files() {
            return returned_error(format!(
                "patch changes {} files, exceeding the {}-file limit",
                document.paths().len(),
                self.limits.max_changed_files()
            ));
        }
        if invocation.context().cancellation().is_cancelled() {
            return not_started("patch application was cancelled before writes began");
        }

        let prepared = match Self::prepare(&dir, document) {
            Ok(prepared) => prepared,
            Err(error) => return returned_error(format!("patch could not be prepared: {error}")),
        };
        if invocation.context().cancellation().is_cancelled() {
            return not_started("patch application was cancelled before writes began");
        }

        match commit(&dir, prepared) {
            Ok(summary) => returned_json(json!({
                "tool": "apply_patch",
                "result": {
                    "updated_files": summary.updated,
                    "added_files": summary.added,
                    "deleted_files": summary.deleted,
                    "moved_files": summary.moved.into_iter().map(|(from, to)| json!({"from": from, "to": to})).collect::<Vec<_>>(),
                }
            })),
            Err(error) if !error.publication_started => returned_error(format!(
                "patch commit rejected before any file changed: {error}"
            )),
            Err(error) => {
                ToolExecutionOutcome::OutcomeUncertain(ToolUncertainOutcome::new(format!(
                    "patch commit failed; completed paths: {:?}; further changes may have been written: {error}",
                    error.completed_paths
                )))
            }
        }
    }

    fn prepare(dir: &Dir, document: PatchDocument) -> Result<Vec<FileMutation>, PatchError> {
        document
            .operations
            .into_iter()
            .map(|operation| Self::prepare_operation(dir, operation))
            .collect()
    }

    fn prepare_operation(dir: &Dir, operation: PatchOperation) -> Result<FileMutation, PatchError> {
        match operation {
            PatchOperation::Update {
                path,
                move_path,
                hunks,
            } => {
                dir.resolve_existing(&path).map_err(PatchError::sandbox)?;
                let bytes = dir
                    .directory()
                    .handle()
                    .read(&path)
                    .map_err(PatchError::io)?;
                let expected_revision = file_revision(&bytes);
                let original = String::from_utf8(bytes).map_err(PatchError::sandbox)?;
                let content = apply_hunks(&original, &hunks)?.into_bytes();
                match move_path {
                    Some(target) => {
                        dir.resolve_for_write(&target)
                            .map_err(PatchError::sandbox)?;
                        Ok(FileMutation::MoveAndReplace {
                            path,
                            target,
                            content,
                            expected_revision,
                        })
                    }
                    None => Ok(FileMutation::Replace {
                        path,
                        content,
                        expected_revision,
                    }),
                }
            }
            PatchOperation::Add { path, lines } => {
                dir.resolve_for_write(&path).map_err(PatchError::sandbox)?;
                let content = TextFileFormat::for_new_file(dir, &path)
                    .map_err(PatchError::io)?
                    .normalize(&new_file_content(&lines))
                    .into_bytes();
                Ok(FileMutation::Create { path, content })
            }
            PatchOperation::Delete { path } => {
                dir.resolve_existing(&path).map_err(PatchError::sandbox)?;
                let bytes = dir
                    .directory()
                    .handle()
                    .read(&path)
                    .map_err(PatchError::io)?;
                Ok(FileMutation::Remove {
                    path,
                    expected_revision: file_revision(&bytes),
                })
            }
        }
    }
}

impl ToolExecutor for ApplyPatchTool {
    fn activity(&self, _call: &ash_tools::ToolCall) -> Option<ash_tools::ToolActivity> {
        Some(ash_tools::ToolActivity::Edit {
            target: "files".into(),
        })
    }

    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ConflictClass(
            ToolConflictClass::new("dir-write").expect("constant conflict class is valid"),
        )
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(future::ready(self.run(invocation)))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyPatchInput {
    patch: String,
}

fn apply_patch_definition() -> Result<ToolDefinition, ApplyPatchError> {
    ToolDefinition::function(
        ToolName::new("apply_patch").map_err(definition_error)?,
        "Apply a validated dir patch. Use *** Begin Patch and *** End Patch, with *** Update File:, *** Add File:, or *** Delete File: operations. Update hunks start with @@ or @@ followed by a context line; their lines start with a space (context), - (remove), or + (add). An update may use *** Move to: to move to an absent destination. *** End of File anchors a hunk at EOF; a hunk containing only additions appends to the file. Paths are relative to the selected directory and parents must exist. Prefer this tool for general multi-hunk or multi-file code changes; use edit for one exact local replacement.",
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "patch": { "type": "string", "description": "Patch text using the documented Begin/End Patch grammar." }
            },
            "required": ["patch"],
            "additionalProperties": false
        }))
        .map_err(definition_error)?,
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .map_err(definition_error)
}

fn definition_error(error: impl fmt::Display) -> ApplyPatchError {
    ApplyPatchError::Definition(error.to_string())
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
#[path = "apply_patch_tests.rs"]
mod tests;

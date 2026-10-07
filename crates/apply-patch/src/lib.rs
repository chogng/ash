//! Validated dir patch application as one model-visible tool.
//!
//! The parser accepts a documented patch grammar with context anchors, EOF markers, and moves. Every operation is prepared before any file
//! is changed. Editor-bound execution commits through versioned document edits and the editor's
//! save service; explicit disk execution publishes replacement writes atomically per file.
//! Updates retain existing line endings and EOF conventions. New files use the selected
//! directory's EditorConfig rules, shared with text writes and replacements by the filesystem layer.

mod file_update;
mod parser;
mod patch_commit;

use crate::file_update::apply_hunks;
use crate::file_update::new_file_content;
use crate::parser::PatchDocument;
use crate::parser::PatchOperation;
use ash_file_access::Dir;
use ash_file_system::FileTextDocuments;
use ash_file_system::TextFileFormat;
use ash_tools::{
    TextDocumentChange, TextDocumentEditor, TextDocumentEditorProvider, TextDocumentError,
};
use ash_tools::{
    ToolConcurrency, ToolConflictClass, ToolDefinition, ToolExecutionFuture, ToolExecutionOutcome,
    ToolExecutor, ToolInputSchema, ToolInvocation, ToolLoading, ToolName, ToolOutput,
    ToolOutputSchema, ToolPayload, ToolSchemaMode, ToolStartFailure, ToolUncertainOutcome,
};
use serde::Deserialize;
use serde_json::json;
use std::fmt;
use std::future;
use std::sync::Arc;

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
/// document before any change begins. Editor commits recheck model versions and preserve undo;
/// disk commits recheck byte revisions. A lost editor reply or partial disk commit is uncertain.
pub struct ApplyPatchTool {
    environment_id: ash_tools::EnvId,
    dir: Dir,
    limits: ApplyPatchLimits,
    definition: ToolDefinition,
    documents: Option<Arc<dyn TextDocumentEditorProvider>>,
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
            documents: None,
        })
    }

    pub fn with_text_document_editor(
        mut self,
        documents: Arc<dyn TextDocumentEditorProvider>,
    ) -> Self {
        self.documents = Some(documents);
        self
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

        if let (Some(provider), Some(thread)) = (&self.documents, invocation.context().thread_id())
        {
            match provider.for_turn(thread, invocation.turn_id()) {
                Ok(Some(editor)) => {
                    return Self::run_document_patch(&dir, document, editor.as_ref(), &invocation);
                }
                Ok(None) => {}
                Err(error) => return returned_error(error.to_string()),
            }
        }
        let files = FileTextDocuments::new(dir.clone());
        Self::run_document_patch(&dir, document, &files, &invocation)
    }

    fn run_document_patch(
        dir: &Dir,
        document: PatchDocument,
        editor: &dyn TextDocumentEditor,
        invocation: &ToolInvocation,
    ) -> ToolExecutionOutcome {
        let cancellation = invocation.context().cancellation();
        let mut snapshots = Vec::new();
        let prepared = (|| -> Result<_, String> {
            let mut changes = Vec::new();
            let mut summary = crate::patch_commit::PatchSummary {
                updated: Vec::new(),
                added: Vec::new(),
                deleted: Vec::new(),
                moved: Vec::new(),
            };
            for operation in document.operations {
                match operation {
                    PatchOperation::Add { path, lines } => {
                        let absolute = dir.resolve_for_write(&path).map_err(|e| e.to_string())?;
                        let text = TextFileFormat::for_new_file(dir, &path)
                            .map_err(|e| e.to_string())?
                            .normalize(&new_file_content(&lines));
                        changes.push(TextDocumentChange::Create {
                            path: absolute,
                            text,
                        });
                        summary.added.push(path.display().to_string());
                    }
                    PatchOperation::Update {
                        path,
                        move_path,
                        hunks,
                    } => {
                        let absolute = dir.resolve_existing(&path).map_err(|e| e.to_string())?;
                        let snapshot = editor
                            .read(&absolute, cancellation)
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| format!("file not found: {}", path.display()))?;
                        snapshots.push(snapshot.id.clone());
                        let text =
                            apply_hunks(&snapshot.text, &hunks).map_err(|e| e.to_string())?;
                        match move_path {
                            Some(target) => {
                                let absolute_target =
                                    dir.resolve_for_write(&target).map_err(|e| e.to_string())?;
                                changes.push(TextDocumentChange::Move {
                                    snapshot: snapshot.id,
                                    target: absolute_target,
                                    text,
                                });
                                summary.moved.push((
                                    path.display().to_string(),
                                    target.display().to_string(),
                                ));
                            }
                            None => {
                                changes.push(TextDocumentChange::Update {
                                    snapshot: snapshot.id,
                                    text,
                                });
                                summary.updated.push(path.display().to_string());
                            }
                        }
                    }
                    PatchOperation::Delete { path } => {
                        let absolute = dir.resolve_existing(&path).map_err(|e| e.to_string())?;
                        let snapshot = editor
                            .read(&absolute, cancellation)
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| format!("file not found: {}", path.display()))?;
                        snapshots.push(snapshot.id.clone());
                        changes.push(TextDocumentChange::Delete {
                            snapshot: snapshot.id,
                        });
                        summary.deleted.push(path.display().to_string());
                    }
                }
            }
            Ok((changes, summary))
        })();
        let outcome = match prepared {
            Ok((changes, summary)) => match editor.apply(changes, cancellation) {
                Ok(()) => returned_summary(summary),
                Err(TextDocumentError::OutcomeUnknown(message)) => {
                    ToolExecutionOutcome::OutcomeUncertain(ToolUncertainOutcome::new(message))
                }
                Err(error) => returned_error(error.to_string()),
            },
            Err(message) => returned_error(message),
        };
        editor.release(snapshots);
        outcome
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
        "Apply a validated dir patch. Use *** Begin Patch and *** End Patch, with *** Update File:, *** Add File:, or *** Delete File: operations. Update hunks start with @@ or @@ followed by a context line; their lines start with a space (context), - (remove), or + (add). An update may use *** Move to: to move to an absent destination. *** End of File anchors a hunk at EOF; a hunk containing only additions appends to the file. Paths are relative to the selected directory; missing parent directories are created. Prefer this tool for general multi-hunk or multi-file code changes; use edit for one exact local replacement.",
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

fn returned_summary(summary: crate::patch_commit::PatchSummary) -> ToolExecutionOutcome {
    returned_json(json!({ "tool": "apply_patch", "result": {
        "updated_files": summary.updated, "added_files": summary.added, "deleted_files": summary.deleted,
        "moved_files": summary.moved.into_iter().map(|(from, to)| json!({ "from": from, "to": to })).collect::<Vec<_>>(),
    }}))
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

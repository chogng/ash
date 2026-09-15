use super::LocalShellToolService;
use super::ShellCommandRequest;
use super::read_only_sandbox;
use crate::dir_grants::DirGrants;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ProcessInvocationKind;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use core_api::CoreError;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Permission as DirPermission;
use ash_file_system::FileSystem;
use ash_file_system::FileWriteCondition;
use ash_file_system::LocalFileSystem;
use ash_file_watcher::FileWatcherEvent;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use ash_shell_command::CommandExecutionAuthority;
use ash_shell_command::CommandSessionCursor;
use ash_shell_command::CommandSessionId;
use ash_shell_command::CommandSessionOwner;
use ash_shell_command::CommandSessionStart;
use ash_shell_command::CommandSessionStatus;
use ash_shell_command::CommandTerminalSize;
use ash_shell_command::RipgrepExecutable;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use super::AgentGrepService;

const READ_DESCRIPTION: &str = r#"Reads a file from an authorized directory and returns its content with line numbers.

Usage notes:
- Returns at most 2000 lines starting from `offset` (1-based). The last line
  of a truncated read says how many lines remain; call again with a larger
  offset to continue.
- Lines longer than 2000 characters are truncated with a marker.
- Binary files, including images, are rejected; use a dedicated viewer for images.
- You must read a file before editing or overwriting it.
- Prefer reading whole files (omit offset/limit) unless the file is too large."#;
const WRITE_DESCRIPTION: &str = r#"Creates or overwrites a file with the given content.

Usage notes:
- Overwriting an existing file you have not read in this conversation fails;
  read it first.
- Prefer apply_patch for modifying existing files, or edit for one small exact
  replacement; use write_file for new files or full rewrites you have read.
- Parent directories are created automatically.
- Never proactively create documentation files unless explicitly requested."#;
const EDIT_DESCRIPTION: &str = r#"Performs an exact string replacement in a file.

Usage notes:
- You must read the file first; the edit fails otherwise.
- Use edit for one small, exact replacement, or as a fallback when a narrow
  apply_patch context cannot match. Prefer apply_patch for coordinated changes
  across multiple locations or files.
- old_string must match the file content exactly, including whitespace and
  indentation, and must identify a unique location. If it matches more than
  one location, extend it with surrounding lines until unique, or set
  replace_all to true to change every occurrence.
- Do not include line-number prefixes from read_file output in old_string.
- For moves or renames use shell with git mv; for full rewrites use write_file."#;
const GREP_DESCRIPTION: &str = r#"Searches file contents with a regular expression.

- Full regex support, e.g. "fn\\s+resolve" or "TODO|FIXME".
- Results are file:line:content, capped at 100 matches; narrow with `glob`
  or `path` if truncated.
- Literal braces or dots must be escaped: use "foo\\.bar" to match "foo.bar".
- Always use this tool instead of invoking grep or rg through shell."#;
const GLOB_DESCRIPTION: &str = r#"Finds files by glob pattern, sorted by most recently modified.

- Supports patterns like "**/*.rs" or "src/**/*.test.ts".
- Returns at most 100 paths; narrow the pattern if truncated.
- Use grep to search file contents; use glob to find files by name."#;
const SHELL_SESSION_DESCRIPTION: &str = r#"Starts or controls one long-running command session.

- start creates the command once and may return while it is still running.
- timeout_ms bounds command lifetime (default 30 seconds, maximum 12 hours); choose it
  explicitly for a long build or monitor. wait_ms only bounds this call's observation.
- read uses independent stdout/stderr cursors and never terminates on wait expiry.
- wait observes completion, suppressing intermediate output and model polling. wait_ms defaults
  to 12 hours for wait; expiry only ends the wait. Use read when progress is needed.
- For CI, start an authorized monitoring command once, then wait on that same session.
- write sends input to the same process; close_input sends EOF.
- interrupt requests a foreground interrupt; terminate kills the process tree.
- A session belongs to the current Session, Thread, and Environment."#;

fn schema(value: &str) -> Value {
    serde_json::from_str(value).expect("static tool schema is valid")
}

fn definition(name: &str, description: &str, parameters: &str) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).expect("static tool name is valid"),
        description: description.into(),
        parameters: schema(parameters),
        strict: true,
    }
}

const READ_SCHEMA: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to the file to read."},"offset":{"type":["integer","null"],"description":"1-based line number to start from. Defaults to 1."},"limit":{"type":["integer","null"],"description":"Maximum lines to return. Defaults to 2000."}},"required":["path","offset","limit"],"additionalProperties":false}"#;
const WRITE_SCHEMA: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"Absolute path of the file to write."},"content":{"type":"string","description":"Full content to write. The previous content is replaced entirely."}},"required":["path","content"],"additionalProperties":false}"#;
const EDIT_SCHEMA: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"Absolute path of the file to modify."},"old_string":{"type":"string","description":"Exact text to replace. Must be unique in the file unless replace_all is true."},"new_string":{"type":"string","description":"Replacement text. Must differ from old_string."},"replace_all":{"type":["boolean","null"],"description":"Replace every occurrence. Defaults to false."}},"required":["path","old_string","new_string","replace_all"],"additionalProperties":false}"#;
const GREP_SCHEMA: &str = r#"{"type":"object","properties":{"pattern":{"type":"string","description":"Regular expression to search for."},"path":{"type":["string","null"],"description":"File or directory to search. Defaults to the selected directory."},"glob":{"type":["string","null"],"description":"Restrict to files matching this glob, e.g. \"*.rs\"."},"case_insensitive":{"type":["boolean","null"],"description":"Case-insensitive search. Defaults to false."}},"required":["pattern","path","glob","case_insensitive"],"additionalProperties":false}"#;
const GLOB_SCHEMA: &str = r#"{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern to match file paths against."},"path":{"type":["string","null"],"description":"Directory to search in. Defaults to the selected directory."}},"required":["pattern","path"],"additionalProperties":false}"#;
const SHELL_SESSION_SCHEMA: &str = r#"{"type":"object","properties":{"action":{"type":"string","enum":["start","read","wait","write","close_input","interrupt","resize","terminate"]},"session_id":{"type":["string","null"]},"program":{"type":["string","null"]},"arguments":{"type":["array","null"],"items":{"type":"string"}},"working_directory":{"type":["string","null"]},"input":{"type":["string","null"]},"stdout_cursor":{"type":["integer","null"],"minimum":0},"stderr_cursor":{"type":["integer","null"],"minimum":0},"timeout_ms":{"type":["integer","null"],"minimum":1,"maximum":43200000},"wait_ms":{"type":["integer","null"],"minimum":0,"maximum":43200000},"terminal_rows":{"type":["integer","null"],"minimum":1,"maximum":1000},"terminal_cols":{"type":["integer","null"],"minimum":1,"maximum":1000}},"required":["action","session_id","program","arguments","working_directory","input","stdout_cursor","stderr_cursor","timeout_ms","wait_ms","terminal_rows","terminal_cols"],"additionalProperties":false}"#;
const MAX_READ_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_WRITE_FILE_BYTES: usize = 10 * 1024 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

/// The fixed local coding-tool suite and its path-scoped execution state.
pub(crate) struct LocalToolSuite<B> {
    shell: LocalShellToolService<B>,
    ripgrep: RipgrepExecutable,
    agent_grep: Arc<AgentGrepService>,
    authorization: Authorization,
    grant: ash_file_access::Grant,
    dir_grants: Arc<DirGrants>,
    read_paths: Mutex<BTreeSet<(String, PathBuf)>>,
    read_fingerprints: Mutex<std::collections::BTreeMap<(String, PathBuf), String>>,
    definitions: Vec<ToolDefinition>,
}

pub(super) struct ResolvedFilePath {
    pub(super) root: Dir,
    pub(super) authorization: Authorization,
    pub(super) relative: PathBuf,
    pub(super) absolute: PathBuf,
}

impl<B: ash_sandboxing::SandboxBackend> LocalToolSuite<B> {
    pub(super) fn new(
        shell: LocalShellToolService<B>,
        ripgrep: RipgrepExecutable,
        agent_grep: Arc<AgentGrepService>,
        dir_grants: Arc<DirGrants>,
        grant: ash_file_access::Grant,
    ) -> Self {
        let authorization = shell.authorization.clone();
        let definitions = vec![
            shell.definition.clone(),
            definition("read_file", READ_DESCRIPTION, READ_SCHEMA),
            definition("write_file", WRITE_DESCRIPTION, WRITE_SCHEMA),
            definition("edit", EDIT_DESCRIPTION, EDIT_SCHEMA),
            definition("grep", GREP_DESCRIPTION, GREP_SCHEMA),
            definition("glob", GLOB_DESCRIPTION, GLOB_SCHEMA),
            definition(
                "shell-session",
                SHELL_SESSION_DESCRIPTION,
                SHELL_SESSION_SCHEMA,
            ),
        ];
        Self {
            shell,
            ripgrep,
            agent_grep,
            authorization,
            grant,
            dir_grants,
            read_paths: Mutex::new(BTreeSet::new()),
            read_fingerprints: Mutex::new(std::collections::BTreeMap::new()),
            definitions,
        }
    }

    fn resolve(
        &self,
        value: &str,
        existing: bool,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
        permission: DirPermission,
    ) -> Result<ResolvedFilePath, String> {
        self.authorization
            .ensure_active()
            .map_err(|error| error.to_string())?;
        let path = PathBuf::from(value);
        let thread_scope = thread_id
            .map(|thread_id| {
                self.dir_grants
                    .thread_scope(thread_id, permission)
                    .map_err(|error| error.to_string())
            })
            .transpose()?
            .flatten();
        let default = self.grant.authorize(permission).ok();
        let primary = thread_scope
            .as_ref()
            .map(|scope| scope.primary().clone())
            .or_else(|| default.clone());
        let mut authorizations = thread_scope
            .as_ref()
            .map(|scope| scope.authorizations().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if let Some(default) = default {
            if !authorizations
                .iter()
                .any(|value| value.dir() == default.dir())
            {
                authorizations.push(default);
            }
        }
        if let Some(session_id) = session_id {
            if let Some(snapshot) = self
                .dir_grants
                .snapshot_for(session_id, permission)
                .map_err(|error| error.to_string())?
            {
                authorizations.extend(
                    snapshot
                        .authorizations()
                        .iter()
                        .filter(|authorization| authorization.ensure_active().is_ok())
                        .cloned(),
                );
            }
        }
        let (authorization, relative) = if path.is_absolute() {
            authorizations
                .into_iter()
                .filter_map(|authorization| {
                    path.strip_prefix(authorization.dir().canonical_path())
                        .or_else(|_| path.strip_prefix(authorization.dir().requested_path()))
                        .ok()
                        .map(|relative| (authorization, relative.to_path_buf()))
                })
                .max_by_key(|(authorization, _)| {
                    authorization.dir().canonical_path().components().count()
                })
                .ok_or_else(|| format!("path is outside the authorized directories: {value}"))?
        } else {
            (
                primary.ok_or_else(|| format!("directory permission required: {permission}"))?,
                path,
            )
        };
        let root = authorization.dir().clone();
        let absolute = if relative.as_os_str().is_empty() {
            Ok(root.canonical_path().to_path_buf())
        } else if existing {
            root.resolve_existing(&relative)
        } else {
            root.resolve_for_write(&relative)
        }
        .map_err(|_| format!("path is outside the authorized directories: {value}"))?;
        match permission {
            DirPermission::ReadFiles | DirPermission::InspectRepository => {
                super::ensure_local_file_access(&root, &absolute, false)
                    .map_err(|error| error.to_string())?;
            }
            DirPermission::WriteFiles | DirPermission::MutateRepository => {
                super::ensure_local_file_access(&root, &absolute, true)
                    .map_err(|error| error.to_string())?;
            }
            _ => {}
        }
        Ok(ResolvedFilePath {
            root: authorization.dir().clone(),
            authorization,
            relative,
            absolute,
        })
    }

    fn review(
        &self,
        call: &ToolCall,
        write: bool,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ActionReviewRequest, CoreError> {
        let path = call
            .arguments
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                self.authorization
                    .dir()
                    .canonical_path()
                    .to_str()
                    .unwrap_or(".")
            });
        let resolved = self
            .resolve(
                path,
                false,
                session_id,
                thread_id,
                if write {
                    DirPermission::WriteFiles
                } else if call.name.as_str() == "read_file" {
                    DirPermission::ReadFiles
                } else {
                    DirPermission::InspectRepository
                },
            )
            .map_err(CoreError::Policy)?;
        let source_id = call.name.as_str();
        let canonical = serde_json::to_vec(
            &json!({"tool": source_id, "path": resolved.absolute, "arguments": call.arguments}),
        )
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        let capabilities = CapabilitySet::new([
            Capability::new(
                CapabilityKind::FileRead,
                resolved.root.canonical_path().display().to_string(),
            ),
            if write {
                Capability::new(
                    CapabilityKind::FileWrite,
                    resolved.absolute.display().to_string(),
                )
            } else {
                Capability::new(
                    CapabilityKind::ProcessSpawn,
                    self.ripgrep.path().display().to_string(),
                )
            },
        ]);
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                if write {
                    ActionKind::FileSystemMutation
                } else {
                    ActionKind::LocalProcess(ProcessInvocationKind::Direct)
                },
                format!("{} {}", source_id, resolved.absolute.display()),
                capabilities,
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, source_id),
            if write {
                SandboxCompatibility::NotApplicable {
                    reason: "file mutation approval is host-mediated".into(),
                }
            } else {
                SandboxCompatibility::Supported(read_only_sandbox())
            },
            self.shell.action_policy_revision.clone(),
        ))
    }

    fn read_file(
        &self,
        call: &ToolCall,
        scope: &str,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let path = string_arg(&call.arguments, "path")?;
        let resolved = self
            .resolve(
                &path,
                false,
                session_id,
                thread_id,
                DirPermission::ReadFiles,
            )
            .map_err(CoreError::Execution)?;
        let metadata = fs::metadata(&resolved.absolute)
            .map_err(|_| CoreError::Execution(format!("file not found: {path}")))?;
        if metadata.is_dir() {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} is a directory. Use glob to list its files"
            )));
        }
        if metadata.len() > MAX_READ_FILE_BYTES {
            return Ok(ToolExecutionOutput::Failure(format!(
                "file too large to read: {path} exceeds 10485760 bytes"
            )));
        }
        let bytes = LocalFileSystem::from_authorization(resolved.authorization.clone())
            .read_file(&resolved.relative, MAX_READ_FILE_BYTES as usize)
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        let text = match String::from_utf8(bytes) {
            Ok(text) if !text.as_bytes().contains(&0) => text,
            _ => {
                return Ok(ToolExecutionOutput::Failure(format!(
                    "{path} is a binary file and cannot be displayed as text"
                )));
            }
        };
        self.read_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert((scope.into(), resolved.absolute.clone()));
        self.read_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                (scope.into(), resolved.absolute.clone()),
                format!("{:x}", Sha256::digest(text.as_bytes())),
            );
        if text.is_empty() {
            return Ok(ToolExecutionOutput::Success("(file is empty)".into()));
        }
        let lines = text.lines().collect::<Vec<_>>();
        let offset = nullable_u64(&call.arguments, "offset")?.unwrap_or(1);
        let limit = nullable_u64(&call.arguments, "limit")?.unwrap_or(2000);
        if offset == 0 || limit == 0 {
            return Err(CoreError::Execution(
                "offset and limit must be greater than zero".into(),
            ));
        }
        let start = (offset - 1) as usize;
        let end = start.saturating_add(limit as usize).min(lines.len());
        let mut output = lines[start.min(lines.len())..end]
            .iter()
            .enumerate()
            .map(|(index, line)| format!("{:>6}\t{}", start + index + 1, truncate_line(line)))
            .collect::<Vec<_>>();
        if end < lines.len() {
            output.push(format!(
                "[... {} more lines, continue with offset={}]",
                lines.len() - end,
                end + 1
            ));
        }
        Ok(ToolExecutionOutput::Success(output.join("\n")))
    }

    fn write_file(
        &self,
        call: &ToolCall,
        scope: &str,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let path = string_arg(&call.arguments, "path")?;
        let content = string_arg(&call.arguments, "content")?;
        let resolved = self
            .resolve(
                &path,
                false,
                session_id,
                thread_id,
                DirPermission::WriteFiles,
            )
            .map_err(CoreError::Execution)?;
        if resolved.absolute.is_dir() {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} is a directory"
            )));
        }
        if resolved.absolute.exists()
            && !self
                .read_paths
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&(scope.into(), resolved.absolute.clone()))
        {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} exists but has not been read in this conversation. Read it first, or choose a new path"
            )));
        }
        if let Some(parent) = resolved.relative.parent() {
            LocalFileSystem::from_authorization(resolved.authorization.clone())
                .create_directory(parent)
                .map_err(|error| CoreError::Execution(error.to_string()))?;
        }
        let expected_revision = self
            .read_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(scope.into(), resolved.absolute.clone()))
            .cloned();
        if resolved.absolute.exists() && expected_revision.is_none() {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} must be read again after reconnecting before it can be overwritten"
            )));
        }
        let file_system = LocalFileSystem::from_authorization(resolved.authorization.clone());
        let write = match expected_revision {
            Some(revision) => file_system.write_file_with_condition(
                &resolved.relative,
                content.as_bytes(),
                MAX_WRITE_FILE_BYTES,
                &FileWriteCondition::ExpectedRevision(revision),
            ),
            None => {
                file_system.write_file(&resolved.relative, content.as_bytes(), MAX_WRITE_FILE_BYTES)
            }
        };
        write.map_err(|error| CoreError::Execution(error.to_string()))?;
        self.read_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert((scope.into(), resolved.absolute.clone()));
        self.read_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                (scope.into(), resolved.absolute.clone()),
                format!("{:x}", Sha256::digest(content.as_bytes())),
            );
        self.agent_grep.apply_watcher_event(
            &resolved.root,
            &FileWatcherEvent::PathsChanged {
                paths: vec![resolved.absolute],
            },
        );
        Ok(ToolExecutionOutput::Success(format!("wrote {path}")))
    }

    fn edit(
        &self,
        call: &ToolCall,
        scope: &str,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let path = string_arg(&call.arguments, "path")?;
        let old = string_arg(&call.arguments, "old_string")?;
        let new = string_arg(&call.arguments, "new_string")?;
        let replace_all = nullable_bool(&call.arguments, "replace_all")?.unwrap_or(false);
        if old == new {
            return Ok(ToolExecutionOutput::Failure(
                "new_string must differ from old_string".into(),
            ));
        }
        let resolved = self
            .resolve(
                &path,
                false,
                session_id,
                thread_id,
                DirPermission::WriteFiles,
            )
            .map_err(CoreError::Execution)?;
        if !self
            .read_paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&(scope.into(), resolved.absolute.clone()))
        {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} has not been read in this conversation. Read it first"
            )));
        }
        let read = self
            .resolve(&path, true, session_id, thread_id, DirPermission::ReadFiles)
            .map_err(CoreError::Execution)?;
        let bytes = LocalFileSystem::from_authorization(read.authorization)
            .read_file(&read.relative, MAX_READ_FILE_BYTES as usize)
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        let text =
            String::from_utf8(bytes).map_err(|error| CoreError::Execution(error.to_string()))?;
        if let Some(expected) = self
            .read_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(scope.into(), resolved.absolute.clone()))
            && expected != &format!("{:x}", Sha256::digest(text.as_bytes()))
        {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} changed on disk after your last read. Read it again before editing"
            )));
        }
        let count = text.match_indices(&old).count();
        if count == 0 {
            return Ok(ToolExecutionOutput::Failure(format!(
                "old_string not found in {path}. Re-read the file: the content may differ from what you expect (check whitespace and indentation)"
            )));
        }
        if count > 1 && !replace_all {
            return Ok(ToolExecutionOutput::Failure(format!(
                "old_string matches {count} locations in {path}. Extend it with more surrounding context to make it unique, or set replace_all to true"
            )));
        }
        let replacement_line = text[..text.find(&old).expect("count is non-zero")]
            .lines()
            .count()
            .max(1);
        let replaced = if replace_all {
            text.replace(&old, &new)
        } else {
            text.replacen(&old, &new, 1)
        };
        let Some(expected_revision) = self
            .read_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(scope.into(), resolved.absolute.clone()))
            .cloned()
        else {
            return Ok(ToolExecutionOutput::Failure(format!(
                "{path} must be read again after reconnecting before it can be edited"
            )));
        };
        LocalFileSystem::from_authorization(resolved.authorization.clone())
            .write_file_with_condition(
                &resolved.relative,
                replaced.as_bytes(),
                MAX_WRITE_FILE_BYTES,
                &FileWriteCondition::ExpectedRevision(expected_revision),
            )
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        self.read_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                (scope.into(), resolved.absolute.clone()),
                format!("{:x}", Sha256::digest(replaced.as_bytes())),
            );
        self.agent_grep.apply_watcher_event(
            &resolved.root,
            &FileWatcherEvent::PathsChanged {
                paths: vec![resolved.absolute],
            },
        );
        let lines = replaced.lines().collect::<Vec<_>>();
        let excerpt_start = replacement_line.saturating_sub(5);
        let excerpt_end = excerpt_start.saturating_add(9).min(lines.len());
        let excerpt = lines[excerpt_start..excerpt_end]
            .iter()
            .enumerate()
            .map(|(index, line)| format!("{:>6}\t{}", excerpt_start + index + 1, line))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ToolExecutionOutput::Success(excerpt))
    }

    fn grep(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let pattern = string_arg(&call.arguments, "pattern")?;
        let path = nullable_string(&call.arguments, "path")?.unwrap_or_else(|| {
            self.authorization
                .dir()
                .canonical_path()
                .display()
                .to_string()
        });
        let resolved = self
            .resolve(
                &path,
                false,
                session_id,
                thread_id,
                DirPermission::InspectRepository,
            )
            .map_err(CoreError::Execution)?;
        let glob = nullable_string(&call.arguments, "glob")?;
        let insensitive = nullable_bool(&call.arguments, "case_insensitive")?.unwrap_or(false);
        self.agent_grep
            .execute(pattern, &resolved, glob, insensitive, cancellation)
    }

    fn glob(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let pattern = string_arg(&call.arguments, "pattern")?;
        let path = nullable_string(&call.arguments, "path")?.unwrap_or_else(|| {
            self.authorization
                .dir()
                .canonical_path()
                .display()
                .to_string()
        });
        let resolved = self
            .resolve(
                &path,
                false,
                session_id,
                thread_id,
                DirPermission::InspectRepository,
            )
            .map_err(CoreError::Execution)?;
        let mut command = Command::new(self.ripgrep.path());
        command.args(["--no-config", "--files", "--glob", &pattern]);
        for denied in super::LOCAL_DENIED_GLOBS {
            command.args(["--glob", &format!("!{denied}")]);
        }
        command.arg(resolved.absolute);
        let output = match run_search(command, cancellation) {
            Ok(output) => output,
            Err(SearchError::Cancelled(error)) => return Err(error),
            Err(SearchError::Failed(message)) => return Ok(ToolExecutionOutput::Failure(message)),
        };
        if !output.status.success() {
            let reason = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if reason.is_empty() {
                return Ok(ToolExecutionOutput::Success(format!(
                    "no files match {pattern}"
                )));
            }
            return Ok(ToolExecutionOutput::Failure(format!(
                "invalid glob pattern: {reason}"
            )));
        }
        let mut paths = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| {
            std::cmp::Reverse(
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok(),
            )
        });
        let total = paths.len();
        paths.truncate(100);
        let mut text = paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if total > 100 {
            text.push_str(&format!("\n[{total} matches, showing first 100]"));
        }
        if text.is_empty() {
            text = format!("no files match {pattern}");
        }
        Ok(ToolExecutionOutput::Success(text))
    }

    fn shell_session(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        session_id: &SessionId,
        thread_id: &ThreadId,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let action = string_arg(&call.arguments, "action")?;
        let owner = command_session_owner(session_id, thread_id);
        match action.as_str() {
            "start" => {
                let program = required_nullable_string(&call.arguments, "program")?;
                let arguments = required_nullable_strings(&call.arguments, "arguments")?;
                let working_directory =
                    required_nullable_string(&call.arguments, "working_directory")?;
                let wait = duration_arg(&call.arguments, "wait_ms")?;
                let execution_timeout_ms =
                    nullable_u64(&call.arguments, "timeout_ms")?.unwrap_or(30_000);
                if !(1..=43_200_000).contains(&execution_timeout_ms) {
                    return Err(CoreError::InvalidInput(
                        "timeout_ms must be between 1 and 43200000".into(),
                    ));
                }
                let resolved = self
                    .resolve(
                        &working_directory,
                        true,
                        Some(session_id),
                        Some(thread_id),
                        DirPermission::ExecuteCommands,
                    )
                    .map_err(CoreError::Execution)?;
                let command_directory = if resolved.relative.as_os_str().is_empty() {
                    PathBuf::from(".")
                } else {
                    resolved.relative.clone()
                };
                let request = ShellCommandRequest::new(program, arguments, command_directory)
                    .map_err(|error| CoreError::Execution(error.to_string()))?
                    .with_dir_root(resolved.root.canonical_path());
                let scope = super::local_sandbox_scope(&resolved.root)?;
                let authority = super::local_command_authority(
                    authorization,
                    self.shell.shell_policy,
                    Some(&scope),
                )?;
                let started = self
                    .shell
                    .shell
                    .start_authorized_session_with_network(
                        request,
                        authority,
                        cancellation,
                        matches!(authority, CommandExecutionAuthority::Sandboxed(_))
                            .then_some(&scope),
                        network_policy,
                        owner,
                        ash_shell_command::CommandSessionOptions {
                            execution_timeout: Duration::from_millis(execution_timeout_ms),
                            wait_budget: wait,
                            terminal: terminal_size(&call.arguments)?,
                        },
                    )
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                match started {
                    CommandSessionStart::Completed(outcome) => {
                        Ok(ToolExecutionOutput::Success(session_outcome_json(outcome)?))
                    }
                    CommandSessionStart::Running(update) => {
                        Ok(ToolExecutionOutput::Success(session_update_json(&update)?))
                    }
                }
            }
            "read" => {
                let id = command_session_id(&call.arguments)?;
                let update = self
                    .shell
                    .shell
                    .read_session(
                        &owner,
                        &id,
                        CommandSessionCursor {
                            stdout: nullable_u64(&call.arguments, "stdout_cursor")?.unwrap_or(0),
                            stderr: nullable_u64(&call.arguments, "stderr_cursor")?.unwrap_or(0),
                        },
                        duration_arg(&call.arguments, "wait_ms")?,
                    )
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                Ok(ToolExecutionOutput::Success(session_update_json(&update)?))
            }
            "wait" => {
                let id = command_session_id(&call.arguments)?;
                let wait_ms = nullable_u64(&call.arguments, "wait_ms")?.unwrap_or(43_200_000);
                if wait_ms > 43_200_000 {
                    return Err(CoreError::InvalidInput(
                        "wait_ms must not exceed 43200000".into(),
                    ));
                }
                let update = pollster::block_on(self.shell.shell.wait_session(
                    &owner,
                    &id,
                    CommandSessionCursor {
                        stdout: nullable_u64(&call.arguments, "stdout_cursor")?.unwrap_or(0),
                        stderr: nullable_u64(&call.arguments, "stderr_cursor")?.unwrap_or(0),
                    },
                    Duration::from_millis(wait_ms),
                    cancellation,
                ))
                .map_err(|error| match error {
                    ash_shell_command::ExecutionError::CancelledBeforeStart(reason) => {
                        CoreError::Cancelled(reason)
                    }
                    error => CoreError::Execution(super::execution_error(error)),
                })?;
                Ok(ToolExecutionOutput::Success(session_update_json(&update)?))
            }
            "write" => {
                let id = command_session_id(&call.arguments)?;
                let input = required_nullable_string(&call.arguments, "input")?;
                self.shell
                    .shell
                    .write_session(&owner, &id, input.into_bytes())
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                Ok(ToolExecutionOutput::Success("input accepted".into()))
            }
            "close_input" => {
                let id = command_session_id(&call.arguments)?;
                self.shell
                    .shell
                    .close_session_input(&owner, &id)
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                Ok(ToolExecutionOutput::Success("input closed".into()))
            }
            "interrupt" => {
                let id = command_session_id(&call.arguments)?;
                self.shell
                    .shell
                    .interrupt_session(&owner, &id)
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                Ok(ToolExecutionOutput::Success("interrupt requested".into()))
            }
            "resize" => {
                let id = command_session_id(&call.arguments)?;
                let size = terminal_size(&call.arguments)?.ok_or_else(|| {
                    CoreError::Execution("resize requires terminal_rows and terminal_cols".into())
                })?;
                self.shell
                    .shell
                    .resize_session(&owner, &id, size)
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                Ok(ToolExecutionOutput::Success("terminal resized".into()))
            }
            "terminate" => {
                let id = command_session_id(&call.arguments)?;
                self.shell
                    .shell
                    .terminate_session(&owner, &id)
                    .map_err(|error| CoreError::Execution(super::execution_error(error)))?;
                Ok(ToolExecutionOutput::Success("termination requested".into()))
            }
            _ => Err(CoreError::Execution(format!(
                "unsupported shell-session action: {action}"
            ))),
        }
    }

    fn review_shell_session(
        &self,
        call: &ToolCall,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ActionReviewRequest, CoreError> {
        let action = string_arg(&call.arguments, "action")?;
        if action == "start" {
            let program = required_nullable_string(&call.arguments, "program")?;
            let arguments = required_nullable_strings(&call.arguments, "arguments")?;
            let working_directory = required_nullable_string(&call.arguments, "working_directory")?;
            let resolved = self
                .resolve(
                    &working_directory,
                    true,
                    session_id,
                    thread_id,
                    DirPermission::ExecuteCommands,
                )
                .map_err(CoreError::Policy)?;
            let request = ShellCommandRequest::new(program, arguments, &resolved.relative)
                .map_err(|error| CoreError::Policy(error.to_string()))?;
            return self.shell.prepare_session_at(
                request,
                &resolved.authorization,
                resolved.relative,
            );
        }
        let canonical = serde_json::to_vec(&json!({
            "tool": "shell-session",
            "action": action,
            "sessionId": call.arguments.get("session_id"),
            "ownerSession": session_id,
            "ownerThread": thread_id,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::LocalProcess(ProcessInvocationKind::Direct),
                format!("{action} an existing command session"),
                CapabilitySet::default(),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "shell-session"),
            SandboxCompatibility::NotApplicable {
                reason: "the operation is restricted to an existing owner-bound process".into(),
            },
            self.shell.action_policy_revision.clone(),
        ))
    }
}

impl<B: ash_sandboxing::SandboxBackend> ToolService for LocalToolSuite<B> {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if call.name.as_str() == "shell-command" {
            return self.shell.prepare(call);
        }
        if call.name.as_str() == "shell-session" {
            return self.review_shell_session(call, None, None);
        }
        match call.name.as_str() {
            "read_file" | "grep" | "glob" => self.review(call, false, None, None),
            "write_file" | "edit" => self.review(call, true, None, None),
            _ => Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            ))),
        }
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        if call.name.as_str() == "shell-command" {
            let identity = facts.execution_identity().ok_or_else(|| {
                CoreError::Policy("local tools require durable caller identity".into())
            })?;
            let request = ShellCommandRequest::from_arguments(
                &ash_tools::ToolPayload::FunctionArguments(call.arguments.clone()),
            )
            .map_err(|error| CoreError::Policy(error.to_string()))?;
            let resolved = self
                .resolve(
                    &request.working_directory().display().to_string(),
                    true,
                    Some(identity.session_id()),
                    Some(identity.thread_id()),
                    DirPermission::ExecuteCommands,
                )
                .map_err(CoreError::Policy)?;
            return self
                .shell
                .prepare_at(call, &resolved.authorization, resolved.relative);
        }
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Policy("local tools require durable caller identity".into())
        })?;
        if call.name.as_str() == "shell-session" {
            return self.review_shell_session(
                call,
                Some(identity.session_id()),
                Some(identity.thread_id()),
            );
        }
        match call.name.as_str() {
            "read_file" | "grep" | "glob" => self.review(
                call,
                false,
                Some(identity.session_id()),
                Some(identity.thread_id()),
            ),
            "write_file" | "edit" => self.review(
                call,
                true,
                Some(identity.session_id()),
                Some(identity.thread_id()),
            ),
            _ => Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            ))),
        }
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_scoped(call, authorization, cancellation, "direct", None, None)
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
            &mut NoopToolOutputSink,
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
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("local tools require durable caller identity".into())
        })?;
        let scope = identity.thread_id().to_string();
        let session_id = identity.session_id();
        for path in facts.read_paths() {
            if let Ok(resolved) = self.resolve(
                &path.display().to_string(),
                true,
                Some(session_id),
                Some(identity.thread_id()),
                DirPermission::InspectRepository,
            ) {
                self.read_paths
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert((scope.clone(), resolved.absolute));
            }
        }
        let output = self.execute_scoped(
            call,
            authorization,
            cancellation,
            &scope,
            Some(session_id),
            Some(identity.thread_id()),
        )?;
        if let ToolExecutionOutput::Success(text) = &output {
            sink.emit(ToolOutputStream::Stdout, text.clone())?;
        }
        Ok(output)
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let output =
            self.execute_scoped(call, authorization, cancellation, "direct", None, None)?;
        if let ToolExecutionOutput::Success(text) = &output {
            sink.emit(ToolOutputStream::Stdout, text.clone())?;
        }
        Ok(output)
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
        if !matches!(call.name.as_str(), "shell-command" | "shell-session") {
            return self.execute_streaming_with_facts(
                call,
                authorization,
                cancellation,
                facts,
                sink,
            );
        }
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("local tools require durable caller identity".into())
        })?;
        let starts_process = call.name.as_str() == "shell-command"
            || (call.name.as_str() == "shell-session"
                && call.arguments.get("action").and_then(Value::as_str) == Some("start"));
        let network = if starts_process
            && self.shell.shell_policy.network() == ash_sandboxing::NetworkAccess::Managed
        {
            Some(crate::network_policy::for_execution(
                self.prepare_with_facts(call, facts)?,
                format!("{}:{}", identity.turn_id(), call.id),
                interactions,
            ))
        } else {
            None
        };
        let output = self.execute_scoped_with_network(
            call,
            authorization,
            cancellation,
            &identity.thread_id().to_string(),
            Some(identity.session_id()),
            Some(identity.thread_id()),
            network.as_ref(),
        )?;
        if let ToolExecutionOutput::Success(text) = &output {
            sink.emit(ToolOutputStream::Stdout, text.clone())?;
        }
        Ok(output)
    }
}

impl<B: ash_sandboxing::SandboxBackend> LocalToolSuite<B> {
    fn execute_scoped(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        scope: &str,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_scoped_with_network(
            call,
            authorization,
            cancellation,
            scope,
            session_id,
            thread_id,
            None,
        )
    }

    fn execute_scoped_with_network(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        scope: &str,
        session_id: Option<&SessionId>,
        thread_id: Option<&ThreadId>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if call.name.as_str() == "shell-command" {
            let request = ShellCommandRequest::from_arguments(
                &ash_tools::ToolPayload::FunctionArguments(call.arguments.clone()),
            )
            .map_err(|error| CoreError::Execution(error.to_string()))?;
            let resolved = self
                .resolve(
                    &request.working_directory().display().to_string(),
                    true,
                    session_id,
                    thread_id,
                    DirPermission::ExecuteCommands,
                )
                .map_err(CoreError::Execution)?;
            return self.shell.execute_at(
                call,
                authorization,
                cancellation,
                &resolved.authorization,
                resolved.relative,
                network_policy,
            );
        }
        if call.name.as_str() == "shell-session" {
            let session_id = session_id.ok_or_else(|| {
                CoreError::Execution("shell-session requires a durable Session owner".into())
            })?;
            let thread_id = thread_id.ok_or_else(|| {
                CoreError::Execution("shell-session requires a durable Thread owner".into())
            })?;
            return self.shell_session(
                call,
                authorization,
                cancellation,
                session_id,
                thread_id,
                network_policy,
            );
        }
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        match call.name.as_str() {
            "read_file" => self.read_file(call, scope, session_id, thread_id),
            "write_file" => self.write_file(call, scope, session_id, thread_id),
            "edit" => self.edit(call, scope, session_id, thread_id),
            "grep" => self.grep(call, cancellation, session_id, thread_id),
            "glob" => self.glob(call, cancellation, session_id, thread_id),
            _ => Ok(ToolExecutionOutput::Failure(format!(
                "tool is not available: {}",
                call.name
            ))),
        }
    }
}

struct NoopToolOutputSink;

impl ToolOutputSink for NoopToolOutputSink {
    fn emit(&mut self, _: ToolOutputStream, _: String) -> Result<(), CoreError> {
        Ok(())
    }
}

enum SearchError {
    Cancelled(CoreError),
    Failed(String),
}

#[cfg(test)]
#[path = "suite_tests.rs"]
mod tests;

fn run_search(
    mut command: Command,
    cancellation: &CancellationToken,
) -> Result<Output, SearchError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| SearchError::Failed(format!("could not execute search: {error}")))?;
    let started = Instant::now();
    loop {
        cancellation.check().map_err(|signal| {
            SearchError::Cancelled(CoreError::Cancelled(signal.reason().to_string()))
        })?;
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| SearchError::Failed(error.to_string()));
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SearchError::Failed(format!(
                    "could not wait for search: {error}"
                )));
            }
        }
        if started.elapsed() >= SEARCH_TIMEOUT {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|error| SearchError::Failed(error.to_string()))?;
            let partial = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return Err(SearchError::Failed(format!(
                "search timed out after 30000 ms. Partial output:\n{}",
                partial
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn command_session_owner(session_id: &SessionId, thread_id: &ThreadId) -> CommandSessionOwner {
    CommandSessionOwner::new(session_id.to_string(), thread_id.to_string(), "local")
}

fn command_session_id(arguments: &Value) -> Result<CommandSessionId, CoreError> {
    CommandSessionId::new(required_nullable_string(arguments, "session_id")?)
        .map_err(CoreError::Execution)
}

fn duration_arg(arguments: &Value, name: &str) -> Result<Duration, CoreError> {
    let millis = nullable_u64(arguments, name)?.unwrap_or(0);
    if millis > 30_000 {
        return Err(CoreError::Execution(format!(
            "{name} must not exceed 30000"
        )));
    }
    Ok(Duration::from_millis(millis))
}

fn terminal_size(arguments: &Value) -> Result<Option<CommandTerminalSize>, CoreError> {
    let rows = nullable_u64(arguments, "terminal_rows")?;
    let cols = nullable_u64(arguments, "terminal_cols")?;
    match (rows, cols) {
        (None, None) => Ok(None),
        (Some(rows), Some(cols)) => Ok(Some(CommandTerminalSize {
            rows: u16::try_from(rows)
                .map_err(|_| CoreError::Execution("terminal_rows is too large".into()))?,
            cols: u16::try_from(cols)
                .map_err(|_| CoreError::Execution("terminal_cols is too large".into()))?,
        })),
        _ => Err(CoreError::Execution(
            "terminal_rows and terminal_cols must be supplied together".into(),
        )),
    }
}

fn required_nullable_string(arguments: &Value, name: &str) -> Result<String, CoreError> {
    nullable_string(arguments, name)?
        .ok_or_else(|| CoreError::Execution(format!("{name} is required for this action")))
}

fn required_nullable_strings(arguments: &Value, name: &str) -> Result<Vec<String>, CoreError> {
    let value = arguments
        .get(name)
        .ok_or_else(|| CoreError::Execution(format!("missing {name}")))?;
    let values = value
        .as_array()
        .ok_or_else(|| CoreError::Execution(format!("{name} must be an array for this action")))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| CoreError::Execution(format!("{name} entries must be strings")))
        })
        .collect()
}

fn session_update_json(
    update: &ash_shell_command::CommandSessionUpdate,
) -> Result<String, CoreError> {
    let (status, exit) = match &update.status {
        CommandSessionStatus::Running => ("running", None),
        CommandSessionStatus::Exited(exit) => ("exited", Some(*exit)),
        CommandSessionStatus::SandboxDenied => ("sandbox_denied", None),
        CommandSessionStatus::Cancelled => ("cancelled", None),
        CommandSessionStatus::TimedOut => ("timed_out", None),
        CommandSessionStatus::Terminated => ("terminated", None),
        CommandSessionStatus::Failed(_) => ("failed", None),
    };
    serde_json::to_string_pretty(&json!({
        "session_id": update.session_id.as_str(),
        "status": status,
        "exit_status": exit,
        "error": match &update.status {
            CommandSessionStatus::Failed(message) => Some(message.as_str()),
            _ => None,
        },
        "stdout": {
            "text": update.stdout.text,
            "next_cursor": update.stdout.next_cursor,
            "gap": update.stdout.gap,
        },
        "stderr": {
            "text": update.stderr.text,
            "next_cursor": update.stderr.next_cursor,
            "gap": update.stderr.gap,
        },
    }))
    .map_err(|error| CoreError::Execution(error.to_string()))
}

fn session_outcome_json(
    outcome: ash_shell_command::CommandExecutionOutcome,
) -> Result<String, CoreError> {
    let value = match outcome {
        ash_shell_command::CommandExecutionOutcome::Completed(output) => json!({
            "status": "exited",
            "exit_code": output.exit_code,
            "stdout": output.stdout,
            "stderr": output.stderr,
            "stdout_truncated": output.stdout_truncated,
            "stderr_truncated": output.stderr_truncated,
        }),
        ash_shell_command::CommandExecutionOutcome::SandboxDenied(denial) => json!({
            "status": "sandbox_denied",
            "reason": denial.reason(),
            "output": denial.output(),
            "replay_safety": denial.replay_safety(),
        }),
    };
    serde_json::to_string_pretty(&value).map_err(|error| CoreError::Execution(error.to_string()))
}

fn string_arg(arguments: &Value, name: &str) -> Result<String, CoreError> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CoreError::Execution(format!("{name} must be a string")))
}

fn nullable_string(arguments: &Value, name: &str) -> Result<Option<String>, CoreError> {
    match arguments.get(name) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| CoreError::Execution(format!("{name} must be a string or null"))),
    }
}

fn nullable_u64(arguments: &Value, name: &str) -> Result<Option<u64>, CoreError> {
    match arguments.get(name) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| CoreError::Execution(format!("{name} must be an integer or null"))),
    }
}

fn nullable_bool(arguments: &Value, name: &str) -> Result<Option<bool>, CoreError> {
    match arguments.get(name) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| CoreError::Execution(format!("{name} must be a boolean or null"))),
    }
}

fn truncate_line(line: &str) -> String {
    if line.chars().count() <= 2000 {
        line.to_owned()
    } else {
        format!(
            "{} [... line truncated ...]",
            line.chars().take(2000).collect::<String>()
        )
    }
}

pub(super) fn limit_matches(output: &str, line_limit: usize) -> String {
    let lines = output.lines().collect::<Vec<_>>();
    let total = lines.len();
    let mut result = lines
        .into_iter()
        .take(100)
        .map(|line| {
            if line.chars().count() > line_limit {
                format!(
                    "{} [... line truncated ...]",
                    line.chars().take(line_limit).collect::<String>()
                )
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if total > 100 {
        result.push_str(&format!("\n[{total} matches, showing first 100]"));
    }
    result
}

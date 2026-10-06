use std::collections::BTreeSet;
use std::path::PathBuf;

use crate::GitClient;
use crate::GitRepository;
use crate::GitResult;

/// Whether a patch should be checked only or applied to the working tree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPatchExecution {
    Check,
    Apply,
}

/// Direction in which a patch should be interpreted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPatchDirection {
    Forward,
    Reverse,
}

/// Structured request for `git apply`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPatchRequest {
    patch: String,
    execution: GitPatchExecution,
    direction: GitPatchDirection,
}

impl GitPatchRequest {
    pub fn new(patch: String, execution: GitPatchExecution, direction: GitPatchDirection) -> Self {
        Self {
            patch,
            execution,
            direction,
        }
    }

    pub fn patch(&self) -> &str {
        &self.patch
    }

    pub fn execution(&self) -> GitPatchExecution {
        self.execution
    }

    pub fn direction(&self) -> GitPatchDirection {
        self.direction
    }
}

/// High-level interpretation of one completed `git apply` process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPatchDisposition {
    Applicable,
    Applied,
    AppliedWithConflicts,
    Rejected,
}

/// Patch result with bounded diagnostics and path classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPatchResult {
    disposition: GitPatchDisposition,
    referenced_paths: Vec<PathBuf>,
    applied_paths: Vec<PathBuf>,
    skipped_paths: Vec<PathBuf>,
    conflicted_paths: Vec<PathBuf>,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl GitPatchResult {
    pub fn disposition(&self) -> GitPatchDisposition {
        self.disposition
    }

    pub fn referenced_paths(&self) -> &[PathBuf] {
        &self.referenced_paths
    }

    pub fn applied_paths(&self) -> &[PathBuf] {
        &self.applied_paths
    }

    pub fn skipped_paths(&self) -> &[PathBuf] {
        &self.skipped_paths
    }

    pub fn conflicted_paths(&self) -> &[PathBuf] {
        &self.conflicted_paths
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub fn stdout(&self) -> &str {
        &self.stdout
    }

    pub fn stderr(&self) -> &str {
        &self.stderr
    }
}

impl GitClient {
    /// Checks or applies a unified diff without enabling Git's unsafe-path mode.
    pub async fn apply_patch(
        &self,
        repository: &GitRepository,
        request: &GitPatchRequest,
    ) -> GitResult<GitPatchResult> {
        let referenced_paths = extract_patch_paths(request.patch());
        let mut args = vec!["apply", "--recount"];
        match request.execution {
            GitPatchExecution::Check => args.push("--check"),
            GitPatchExecution::Apply => args.push("--3way"),
        }
        if request.direction == GitPatchDirection::Reverse {
            args.push("-R");
        }
        args.push("-");

        let output = self
            .run_mutation_with_stdin(
                repository.worktree_root(),
                args,
                request.patch.as_bytes().to_vec(),
            )
            .await?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let diagnostics = parse_apply_diagnostics(&stdout, &stderr);
        let disposition = if output.status.success() {
            match request.execution {
                GitPatchExecution::Check => GitPatchDisposition::Applicable,
                GitPatchExecution::Apply => GitPatchDisposition::Applied,
            }
        } else if request.execution == GitPatchExecution::Apply
            && diagnostics.applied_with_conflicts
        {
            GitPatchDisposition::AppliedWithConflicts
        } else {
            GitPatchDisposition::Rejected
        };
        let applied_paths = match (output.status.success(), request.execution) {
            (true, GitPatchExecution::Apply) => referenced_paths
                .iter()
                .filter(|path| !diagnostics.conflicted.contains(*path))
                .cloned()
                .collect(),
            (false, _) => diagnostics.applied.iter().cloned().collect(),
            (true, GitPatchExecution::Check) => Vec::new(),
        };
        Ok(GitPatchResult {
            disposition,
            referenced_paths,
            applied_paths,
            skipped_paths: diagnostics.skipped.into_iter().collect(),
            conflicted_paths: diagnostics.conflicted.into_iter().collect(),
            exit_code: output.status.code(),
            stdout,
            stderr,
        })
    }
}

/// Returns sorted, deduplicated paths from `diff --git` headers.
pub fn extract_patch_paths(patch: &str) -> Vec<PathBuf> {
    let mut paths = BTreeSet::new();
    for line in patch.lines() {
        let Some(rest) = line.trim().strip_prefix("diff --git ") else {
            continue;
        };
        let Some((before, after)) = parse_diff_git_paths(rest) else {
            continue;
        };
        if let Some(path) = normalize_patch_path(&before, "a/") {
            paths.insert(PathBuf::from(path));
        }
        if let Some(path) = normalize_patch_path(&after, "b/") {
            paths.insert(PathBuf::from(path));
        }
    }
    paths.into_iter().collect()
}

#[derive(Default)]
struct ApplyDiagnostics {
    applied: BTreeSet<PathBuf>,
    skipped: BTreeSet<PathBuf>,
    conflicted: BTreeSet<PathBuf>,
    applied_with_conflicts: bool,
}

fn parse_apply_diagnostics(stdout: &str, stderr: &str) -> ApplyDiagnostics {
    let mut diagnostics = ApplyDiagnostics::default();
    for line in stdout.lines().chain(stderr.lines()).map(str::trim) {
        if let Some(path) = line
            .strip_prefix("Applied patch to '")
            .and_then(|value| value.strip_suffix("' cleanly."))
            .or_else(|| {
                line.strip_prefix("Applied patch ")
                    .and_then(|value| value.strip_suffix(" cleanly."))
            })
        {
            diagnostics.applied.insert(PathBuf::from(unquote(path)));
            continue;
        }
        if let Some(path) = line
            .strip_prefix("Applied patch to '")
            .and_then(|value| value.strip_suffix("' with conflicts."))
            .or_else(|| {
                line.strip_prefix("Applied patch ")
                    .and_then(|value| value.strip_suffix(" with conflicts."))
            })
        {
            diagnostics.conflicted.insert(PathBuf::from(unquote(path)));
            diagnostics.applied_with_conflicts = true;
            continue;
        }
        if let Some(path) = line
            .strip_prefix("Skipped patch '")
            .and_then(|value| value.strip_suffix("'."))
        {
            diagnostics.skipped.insert(PathBuf::from(unquote(path)));
            continue;
        }
        if let Some(rest) = line.strip_prefix("error: patch failed: ")
            && let Some(path) = rest.rsplit_once(':').map(|(path, _)| path)
        {
            diagnostics.conflicted.insert(PathBuf::from(unquote(path)));
            continue;
        }
        if let Some(rest) = line.strip_prefix("error: ")
            && let Some(path) = rest.strip_suffix(": patch does not apply")
        {
            diagnostics.conflicted.insert(PathBuf::from(unquote(path)));
            continue;
        }
        if let Some(rest) = line.strip_prefix("error: ")
            && let Some((path, message)) = rest.split_once(": ")
            && [
                "does not match index",
                "does not exist in index",
                "already exists in working directory",
            ]
            .iter()
            .any(|prefix| message.starts_with(prefix))
        {
            diagnostics.conflicted.insert(PathBuf::from(unquote(path)));
        }
    }
    diagnostics
}

fn parse_diff_git_paths(line: &str) -> Option<(String, String)> {
    let mut chars = line.chars().peekable();
    let before = read_patch_token(&mut chars)?;
    let after = read_patch_token(&mut chars)?;
    Some((before, after))
}

fn read_patch_token(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<String> {
    while chars
        .peek()
        .is_some_and(|character| character.is_whitespace())
    {
        chars.next();
    }
    let quoted = matches!(chars.peek(), Some('"'));
    if quoted {
        chars.next();
    }
    let mut token = String::new();
    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                break;
            }
            if character == '\\' {
                read_escape(chars, &mut token);
            } else {
                token.push(character);
            }
        } else if character.is_whitespace() {
            break;
        } else {
            token.push(character);
        }
    }
    (!token.is_empty()).then_some(token)
}

fn read_escape(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, output: &mut String) {
    let Some(first) = chars.next() else {
        output.push('\\');
        return;
    };
    match first {
        'n' => output.push('\n'),
        'r' => output.push('\r'),
        't' => output.push('\t'),
        '\\' => output.push('\\'),
        '"' => output.push('"'),
        '0'..='7' => {
            let mut value = first.to_digit(8).unwrap_or(0);
            for _ in 0..2 {
                let Some(next) = chars.peek().copied() else {
                    break;
                };
                let Some(digit) = next.to_digit(8) else {
                    break;
                };
                chars.next();
                value = value * 8 + digit;
            }
            if let Some(character) = char::from_u32(value) {
                output.push(character);
            }
        }
        other => output.push(other),
    }
}

fn normalize_patch_path(path: &str, prefix: &str) -> Option<String> {
    let path = path.trim();
    if path == "/dev/null" {
        return None;
    }
    let path = path.strip_prefix(prefix).unwrap_or(path);
    (!path.is_empty()).then(|| path.to_string())
}

fn unquote(path: &str) -> String {
    path.trim_matches(['\'', '"']).to_string()
}

#[cfg(test)]
#[path = "patch_tests.rs"]
mod tests;

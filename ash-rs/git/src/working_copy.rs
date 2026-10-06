use std::path::PathBuf;

use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::fsmonitor::detect_fsmonitor_override;
use crate::path::path_from_git_bytes;

/// Git's status for one side of a working-tree entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitChangeStatus {
    Unmodified,
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Untracked,
    Ignored,
}

/// Upstream tracking state attached to a local branch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitUpstream {
    name: String,
    ahead: usize,
    behind: usize,
}

impl GitUpstream {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn ahead(&self) -> usize {
        self.ahead
    }

    pub fn behind(&self) -> usize {
        self.behind
    }
}

/// Current HEAD state, including unborn and detached repositories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitHead {
    Branch {
        name: String,
        object_id: String,
        upstream: Option<GitUpstream>,
    },
    Detached {
        object_id: String,
    },
    Unborn {
        name: String,
    },
}

/// Submodule-specific flags carried by porcelain-v2 status records.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GitSubmoduleState {
    is_submodule: bool,
    commit_changed: bool,
    tracked_changes: bool,
    untracked_changes: bool,
}

impl GitSubmoduleState {
    pub fn is_submodule(self) -> bool {
        self.is_submodule
    }

    pub fn commit_changed(self) -> bool {
        self.commit_changed
    }

    pub fn tracked_changes(self) -> bool {
        self.tracked_changes
    }

    pub fn untracked_changes(self) -> bool {
        self.untracked_changes
    }
}

/// One path reported by Git porcelain v2.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRepositoryChange {
    path: PathBuf,
    original_path: Option<PathBuf>,
    index_status: GitChangeStatus,
    worktree_status: GitChangeStatus,
    submodule: GitSubmoduleState,
}

impl GitRepositoryChange {
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn original_path(&self) -> Option<&std::path::Path> {
        self.original_path.as_deref()
    }

    pub fn index_status(&self) -> GitChangeStatus {
        self.index_status
    }

    pub fn worktree_status(&self) -> GitChangeStatus {
        self.worktree_status
    }

    pub fn submodule(&self) -> GitSubmoduleState {
        self.submodule
    }

    pub fn is_conflicted(&self) -> bool {
        self.index_status == GitChangeStatus::Unmerged
            || self.worktree_status == GitChangeStatus::Unmerged
    }
}

/// Authoritative result of one bounded `git status --porcelain=v2` query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRepositorySnapshot {
    head: GitHead,
    changes: Vec<GitRepositoryChange>,
}

impl GitRepositorySnapshot {
    pub fn head(&self) -> &GitHead {
        &self.head
    }

    pub fn changes(&self) -> &[GitRepositoryChange] {
        &self.changes
    }

    pub fn is_clean(&self) -> bool {
        self.changes.is_empty()
    }
}

impl GitClient {
    /// Files outside the worktree that can change ignore classification, including config includes.
    /// Git resolves config paths so its HOME, XDG and core.excludesFile rules remain authoritative.
    pub async fn ignore_watch_paths(&self, repository: &GitRepository) -> GitResult<Vec<PathBuf>> {
        use std::ffi::OsString;
        let root = repository.worktree_root();
        let mut paths = vec![
            repository.git_dir().join("index"),
            repository.git_dir().join("config.worktree"),
            repository.common_dir().join("config"),
            repository.common_dir().join("info/exclude"),
        ];
        for variable in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] {
            let output = self
                .run_query(root, ["var", variable])
                .await?
                .require_success()?;
            for value in output
                .stdout
                .split(|byte| *byte == b'\n')
                .filter(|value| !value.is_empty())
            {
                paths.push(path_from_git_bytes(value, &output.command)?);
            }
        }
        let output = self
            .run_query(root, ["config", "--null", "--show-origin", "--list"])
            .await?
            .require_success()?;
        let bytes = output.stdout.strip_suffix(&[0]).ok_or_else(|| {
            GitError::invalid_output(&output.command, "config origins were not NUL-terminated")
        })?;
        let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
        if records.len() % 2 != 0 {
            return Err(GitError::invalid_output(
                &output.command,
                "config origin has no value",
            ));
        }
        for record in records.chunks_exact(2) {
            if let Some(path) = record[0].strip_prefix(b"file:") {
                let path = path_from_git_bytes(path, &output.command)?;
                paths.push(if path.is_absolute() {
                    path
                } else {
                    root.join(path)
                });
            }
        }
        let default = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(|path| PathBuf::from(path).join("git/ignore").into_os_string())
            .unwrap_or_else(|| OsString::from("~/.config/git/ignore"));
        let output = self
            .run_query(
                root,
                [
                    OsString::from("config"),
                    OsString::from("--null"),
                    OsString::from("--path"),
                    OsString::from("--default"),
                    default,
                    OsString::from("--get"),
                    OsString::from("core.excludesFile"),
                ],
            )
            .await?
            .require_success()?;
        let bytes = output.stdout.strip_suffix(&[0]).ok_or_else(|| {
            GitError::invalid_output(&output.command, "ignore path was not NUL-terminated")
        })?;
        if !bytes.is_empty() {
            let path = path_from_git_bytes(bytes, &output.command)?;
            paths.push(if path.is_absolute() {
                path
            } else {
                root.join(path)
            });
        }
        for path in paths.clone() {
            if let Ok(target) = dunce::canonicalize(path) {
                paths.push(target);
            }
        }
        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    /// Queries ignore rules for repository-relative paths without listing ignored directory trees.
    /// Tracked files are excluded by Git, and negated matches are not ignored decorations.
    pub async fn check_ignore(
        &self,
        repository: &GitRepository,
        paths: &[PathBuf],
    ) -> GitResult<Vec<PathBuf>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = Vec::new();
        for path in paths {
            if path.as_os_str().is_empty()
                || path.as_os_str().as_encoded_bytes().contains(&0)
                || path.is_absolute()
                || path
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
            {
                return Err(crate::GitError::InvalidConfiguration {
                    field: "ignore path",
                    requirement: "must be a non-empty repository-relative path",
                });
            }
            input.extend_from_slice(path.as_os_str().as_encoded_bytes());
            input.push(0);
        }
        let output = self
            .run_query_with_stdin(
                repository.worktree_root(),
                ["check-ignore", "--verbose", "-z", "--stdin"],
                input,
            )
            .await?;
        if !output.status.success() && output.status.code() != Some(1) {
            return output.require_success().map(|_| Vec::new());
        }
        let mut fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.pop() != Some(&[][..]) {
            return Err(crate::GitError::invalid_output(
                &output.command,
                "ignore output was not NUL-terminated",
            ));
        }
        if fields.len() % 4 != 0 {
            return Err(crate::GitError::invalid_output(
                &output.command,
                "ignore record did not contain source, line, pattern, and path",
            ));
        }
        fields
            .chunks_exact(4)
            .filter(|record| !record[2].is_empty() && record[2][0] != b'!')
            .map(|record| path_from_git_bytes(record[3], &output.command))
            .collect()
    }

    /// Captures HEAD and path state without taking optional Git locks.
    pub async fn snapshot(&self, repository: &GitRepository) -> GitResult<GitRepositorySnapshot> {
        let fsmonitor = detect_fsmonitor_override(self, repository).await;
        let output = self
            .run_query_with_fsmonitor(
                repository.worktree_root(),
                [
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                    "--untracked-files=all",
                ],
                fsmonitor,
            )
            .await?;
        parse_status(&output.stdout, &output.command)
    }
}

fn parse_status(bytes: &[u8], command: &str) -> GitResult<GitRepositorySnapshot> {
    let mut oid = None;
    let mut branch_name = None;
    let mut upstream_name = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut changes = Vec::new();
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());

    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix(b"# branch.oid ") {
            oid = Some(utf8(value, command, "branch object id")?.to_string());
            continue;
        }
        if let Some(value) = record.strip_prefix(b"# branch.head ") {
            branch_name = Some(utf8(value, command, "branch name")?.to_string());
            continue;
        }
        if let Some(value) = record.strip_prefix(b"# branch.upstream ") {
            upstream_name = Some(utf8(value, command, "upstream name")?.to_string());
            continue;
        }
        if let Some(value) = record.strip_prefix(b"# branch.ab ") {
            let value = utf8(value, command, "ahead/behind state")?;
            let mut fields = value.split_whitespace();
            ahead = parse_distance(fields.next(), '+', command)?;
            behind = parse_distance(fields.next(), '-', command)?;
            if fields.next().is_some() {
                return Err(GitError::invalid_output(
                    command,
                    "branch ahead/behind state had extra fields",
                ));
            }
            continue;
        }
        if record.starts_with(b"# ") {
            continue;
        }

        let change = match record.first().copied() {
            Some(b'1') => parse_ordinary(record, command)?,
            Some(b'2') => {
                let original = records.next().ok_or_else(|| {
                    GitError::invalid_output(command, "rename record omitted the original path")
                })?;
                parse_renamed(record, original, command)?
            }
            Some(b'u') => parse_unmerged(record, command)?,
            Some(b'?') => parse_simple(record, GitChangeStatus::Untracked, command)?,
            Some(b'!') => parse_simple(record, GitChangeStatus::Ignored, command)?,
            _ => {
                return Err(GitError::invalid_output(
                    command,
                    "unknown porcelain-v2 record type",
                ));
            }
        };
        changes.push(change);
    }

    let oid = oid.ok_or_else(|| GitError::invalid_output(command, "missing branch.oid header"))?;
    let branch_name = branch_name
        .ok_or_else(|| GitError::invalid_output(command, "missing branch.head header"))?;
    let head = if oid == "(initial)" {
        GitHead::Unborn { name: branch_name }
    } else if branch_name == "(detached)" {
        GitHead::Detached { object_id: oid }
    } else {
        let upstream = upstream_name.map(|name| GitUpstream {
            name,
            ahead,
            behind,
        });
        GitHead::Branch {
            name: branch_name,
            object_id: oid,
            upstream,
        }
    };
    Ok(GitRepositorySnapshot { head, changes })
}

fn parse_ordinary(record: &[u8], command: &str) -> GitResult<GitRepositoryChange> {
    let fields = split_fields(record, 9);
    require_field_count(&fields, 9, command, "ordinary status")?;
    build_change(fields[1], fields[2], fields[8], None, command)
}

fn parse_renamed(
    record: &[u8],
    original_path: &[u8],
    command: &str,
) -> GitResult<GitRepositoryChange> {
    let fields = split_fields(record, 10);
    require_field_count(&fields, 10, command, "rename status")?;
    build_change(
        fields[1],
        fields[2],
        fields[9],
        Some(original_path),
        command,
    )
}

fn parse_unmerged(record: &[u8], command: &str) -> GitResult<GitRepositoryChange> {
    let fields = split_fields(record, 11);
    require_field_count(&fields, 11, command, "unmerged status")?;
    build_change(fields[1], fields[2], fields[10], None, command)
}

fn parse_simple(
    record: &[u8],
    status: GitChangeStatus,
    command: &str,
) -> GitResult<GitRepositoryChange> {
    let path = record
        .strip_prefix(if status == GitChangeStatus::Untracked {
            b"? "
        } else {
            b"! "
        })
        .ok_or_else(|| GitError::invalid_output(command, "simple status record was malformed"))?;
    Ok(GitRepositoryChange {
        path: path_from_git_bytes(path, command)?,
        original_path: None,
        index_status: GitChangeStatus::Unmodified,
        worktree_status: status,
        submodule: GitSubmoduleState::default(),
    })
}

fn build_change(
    xy: &[u8],
    submodule: &[u8],
    path: &[u8],
    original_path: Option<&[u8]>,
    command: &str,
) -> GitResult<GitRepositoryChange> {
    if xy.len() != 2 {
        return Err(GitError::invalid_output(
            command,
            "status XY field did not contain two bytes",
        ));
    }
    Ok(GitRepositoryChange {
        path: path_from_git_bytes(path, command)?,
        original_path: original_path
            .map(|path| path_from_git_bytes(path, command))
            .transpose()?,
        index_status: parse_change_status(xy[0], command)?,
        worktree_status: parse_change_status(xy[1], command)?,
        submodule: parse_submodule_state(submodule, command)?,
    })
}

fn parse_change_status(value: u8, command: &str) -> GitResult<GitChangeStatus> {
    match value {
        b'.' => Ok(GitChangeStatus::Unmodified),
        b'M' => Ok(GitChangeStatus::Modified),
        b'A' => Ok(GitChangeStatus::Added),
        b'D' => Ok(GitChangeStatus::Deleted),
        b'R' => Ok(GitChangeStatus::Renamed),
        b'C' => Ok(GitChangeStatus::Copied),
        b'T' => Ok(GitChangeStatus::TypeChanged),
        b'U' => Ok(GitChangeStatus::Unmerged),
        _ => Err(GitError::invalid_output(
            command,
            format!("unknown status byte {value:?}"),
        )),
    }
}

fn parse_submodule_state(value: &[u8], command: &str) -> GitResult<GitSubmoduleState> {
    if value == b"N..." {
        return Ok(GitSubmoduleState::default());
    }
    if value.len() != 4 || value[0] != b'S' {
        return Err(GitError::invalid_output(
            command,
            "submodule state was malformed",
        ));
    }
    Ok(GitSubmoduleState {
        is_submodule: true,
        commit_changed: value[1] == b'C',
        tracked_changes: value[2] == b'M',
        untracked_changes: value[3] == b'U',
    })
}

fn split_fields(record: &[u8], limit: usize) -> Vec<&[u8]> {
    record
        .splitn(limit, |byte| *byte == b' ')
        .collect::<Vec<_>>()
}

fn require_field_count(
    fields: &[&[u8]],
    expected: usize,
    command: &str,
    label: &str,
) -> GitResult<()> {
    if fields.len() == expected {
        Ok(())
    } else {
        Err(GitError::invalid_output(
            command,
            format!("{label} had {} fields instead of {expected}", fields.len()),
        ))
    }
}

fn utf8<'a>(value: &'a [u8], command: &str, label: &str) -> GitResult<&'a str> {
    std::str::from_utf8(value)
        .map_err(|_| GitError::invalid_output(command, format!("{label} was not UTF-8")))
}

fn parse_distance(value: Option<&str>, prefix: char, command: &str) -> GitResult<usize> {
    let value = value
        .and_then(|value| value.strip_prefix(prefix))
        .ok_or_else(|| GitError::invalid_output(command, "branch distance was malformed"))?;
    value
        .parse()
        .map_err(|_| GitError::invalid_output(command, "branch distance was not an integer"))
}

#[cfg(test)]
#[path = "working_copy_tests.rs"]
mod tests;

mod content;
mod index_edit;
mod mutation;
mod patch;
mod text_diff;

pub use content::GitChangeFile;
pub use content::GitChangeFileComparison;
pub use content::GitConflictChoice;
pub use content::GitConflictFile;
pub use content::GitFileRevision;
pub use index_edit::GitIndexDiff;
pub use index_edit::GitIndexEdit;
pub use index_edit::GitIndexSelection;
pub use mutation::GitCommitRequest;
pub use mutation::GitCommitResult;
pub use mutation::GitPathspecSet;
pub use patch::GitPatchDirection;
pub use patch::GitPatchDisposition;
pub use patch::GitPatchExecution;
pub use patch::GitPatchRequest;
pub use patch::GitPatchResult;
pub use patch::extract_patch_paths;
pub use text_diff::GitDiffStatistics;
pub use text_diff::GitTextDiff;
pub use text_diff::GitTextDiffLimits;
pub use text_diff::GitTextDiffSnapshot;

use crate::GitTreeId;
use crate::objects::parse_tree;

impl GitClient {
    pub async fn capture_index_tree(&self, repository: &GitRepository) -> GitResult<GitTreeId> {
        let output = self
            .run_query(repository.worktree_root(), ["write-tree"])
            .await?;
        parse_tree(output.stdout, &output.command)
    }
    pub async fn install_checkout_state(
        &self,
        repository: &GitRepository,
        worktree: &GitTreeId,
        index: &GitTreeId,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["read-tree", "--reset", "-u", worktree.as_str()],
        )
        .await?
        .require_success()?;
        self.run_mutation(
            repository.worktree_root(),
            ["read-tree", "--reset", index.as_str()],
        )
        .await?
        .require_success()?;
        Ok(())
    }
}

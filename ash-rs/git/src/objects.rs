use crate::path::path_from_git_bytes;
use crate::{GitClient, GitError, GitHead, GitRepository, GitResult};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Bounded UTF-8 patch text between two immutable trees.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeTextDiff {
    text: String,
    truncated: bool,
}

impl GitTreeTextDiff {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }
}

/// Validated Git tree object identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeId(String);

impl GitTreeId {
    pub fn new(value: String) -> GitResult<Self> {
        validate_object_id(&value, "tree object ID")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Private ref namespace used to keep Thread baselines and sealed ChangeSets reachable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPrivateRef(String);

impl GitPrivateRef {
    pub fn new(value: String) -> GitResult<Self> {
        if !value.starts_with("refs/ash/")
            || value.contains("..")
            || value.chars().any(char::is_whitespace)
            || value.ends_with('/')
        {
            return Err(GitError::InvalidConfiguration {
                field: "private ref",
                requirement: "must be a well-formed refs/ash/* name",
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Change kind between two immutable Git trees.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitTreeChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
}

/// One path delta between two immutable Git trees.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeChange {
    path: PathBuf,
    previous_path: Option<PathBuf>,
    kind: GitTreeChangeKind,
    before_mode: Option<String>,
    after_mode: Option<String>,
    before_object_id: Option<String>,
    after_object_id: Option<String>,
    binary: bool,
    additions: u64,
    deletions: u64,
}

impl GitTreeChange {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn previous_path(&self) -> Option<&Path> {
        self.previous_path.as_deref()
    }

    pub fn kind(&self) -> GitTreeChangeKind {
        self.kind
    }

    pub fn before_mode(&self) -> Option<&str> {
        self.before_mode.as_deref()
    }

    pub fn after_mode(&self) -> Option<&str> {
        self.after_mode.as_deref()
    }

    pub fn before_object_id(&self) -> Option<&str> {
        self.before_object_id.as_deref()
    }

    pub fn after_object_id(&self) -> Option<&str> {
        self.after_object_id.as_deref()
    }

    pub fn binary(&self) -> bool {
        self.binary
    }

    pub fn additions(&self) -> u64 {
        self.additions
    }

    pub fn deletions(&self) -> u64 {
        self.deletions
    }
}

impl GitClient {
    /// Returns Git's canonical empty tree object for this repository's object format.
    pub async fn empty_tree(&self, repository: &GitRepository) -> GitResult<GitTreeId> {
        let output = self
            .run_mutation_with_stdin(repository.worktree_root(), ["mktree"], Vec::new())
            .await?
            .require_success()?;
        parse_tree_id(output.stdout, &output.command)
    }

    /// Creates an unreachable commit used only to host a detached linked worktree for an unborn
    /// branch. The product branch is not created or updated by this operation.
    pub async fn create_worktree_anchor(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
    ) -> GitResult<String> {
        let output = self
            .run_mutation_with_stdin(
                repository.worktree_root(),
                [
                    "-c",
                    "user.name=Ash Thread Worktree",
                    "-c",
                    "user.email=ash-thread-worktree@invalid",
                    "commit-tree",
                    tree.as_str(),
                    "-F",
                    "-",
                ],
                b"Ash Thread worktree anchor\n".to_vec(),
            )
            .await?
            .require_success()?;
        let object_id = String::from_utf8(output.stdout).map_err(|_| {
            GitError::invalid_output(&output.command, "anchor commit ID was not UTF-8")
        })?;
        let object_id = object_id.trim().to_string();
        validate_object_id(&object_id, "anchor commit ID")?;
        Ok(object_id)
    }

    /// Captures the current working-directory contents in Git's object database without touching
    /// the repository's real index. Ignored untracked files remain excluded by Git.
    pub async fn capture_worktree_tree(&self, repository: &GitRepository) -> GitResult<GitTreeId> {
        let temporary = tempfile::Builder::new()
            .prefix("ash-tree-index-")
            .tempfile_in(repository.common_dir())
            .map_err(|source| GitError::io("create temporary Git index", source))?;
        let index_path = temporary.into_temp_path();
        std::fs::remove_file(&index_path)
            .map_err(|source| GitError::io("prepare temporary Git index", source))?;
        let snapshot = self.snapshot(repository).await?;
        let read_tree_args = match snapshot.head() {
            GitHead::Unborn { .. } => vec![OsString::from("read-tree"), OsString::from("--empty")],
            GitHead::Branch { object_id, .. } | GitHead::Detached { object_id } => {
                vec![OsString::from("read-tree"), OsString::from(object_id)]
            }
        };
        self.run_mutation_with_index(repository.worktree_root(), read_tree_args, &index_path)
            .await?
            .require_success()?;
        self.run_mutation_with_index(
            repository.worktree_root(),
            ["add", "--all", "--", "."],
            &index_path,
        )
        .await?
        .require_success()?;
        let output = self
            .run_mutation_with_index(repository.worktree_root(), ["write-tree"], &index_path)
            .await?
            .require_success()?;
        parse_tree_id(output.stdout, &output.command)
    }

    /// Keeps one object reachable under Ash's private ref namespace.
    pub async fn pin_private_ref(
        &self,
        repository: &GitRepository,
        reference: &GitPrivateRef,
        tree: &GitTreeId,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", reference.as_str(), tree.as_str()],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Retains the target commit needed to recreate a checkpoint's merge destination.
    pub async fn pin_private_commit(
        &self,
        repository: &GitRepository,
        reference: &GitPrivateRef,
        object_id: &str,
    ) -> GitResult<()> {
        validate_object_id(object_id, "checkpoint target commit")?;
        self.run_mutation(
            repository.worktree_root(),
            ["cat-file", "-e", &format!("{object_id}^{{commit}}")],
        )
        .await?
        .require_success()?;
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", reference.as_str(), object_id],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Removes one private reachability ref. Missing refs are accepted by Git update-ref -d.
    pub async fn delete_private_ref(
        &self,
        repository: &GitRepository,
        reference: &GitPrivateRef,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", "-d", reference.as_str()],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Releases a retained checkpoint even after its linked working tree has been removed.
    pub async fn delete_private_ref_at_git_dir(
        &self,
        git_directory: &Path,
        reference: &GitPrivateRef,
    ) -> GitResult<()> {
        let directory = std::fs::canonicalize(git_directory)
            .map_err(|error| GitError::io("resolve checkpoint Git directory", error))?;
        self.run_mutation(
            &directory,
            [
                OsString::from("--git-dir"),
                directory.as_os_str().to_owned(),
                OsString::from("update-ref"),
                OsString::from("-d"),
                OsString::from(reference.as_str()),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Replaces a linked checkout's index and files with one immutable tree object.
    pub async fn install_worktree_tree(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["read-tree", "--reset", "-u", tree.as_str()],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Replaces tracked and non-ignored untracked paths in a Ash-managed checkout.
    ///
    /// The caller must prove that the checkout is disposable; ignored files are preserved.
    pub async fn replace_managed_worktree_tree(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
    ) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["clean", "-fd"])
            .await?
            .require_success()?;
        self.install_worktree_tree(repository, tree).await
    }

    /// Computes rename-aware metadata and line statistics between two immutable trees.
    pub async fn diff_trees(
        &self,
        repository: &GitRepository,
        before: &GitTreeId,
        after: &GitTreeId,
    ) -> GitResult<Vec<GitTreeChange>> {
        let raw = self
            .run_query(
                repository.worktree_root(),
                [
                    "diff-tree",
                    "--raw",
                    "-z",
                    "-r",
                    "-M",
                    "--no-commit-id",
                    before.as_str(),
                    after.as_str(),
                ],
            )
            .await?;
        let statistics = self
            .run_query(
                repository.worktree_root(),
                [
                    "diff-tree",
                    "--numstat",
                    "-z",
                    "-r",
                    "-M",
                    "--no-commit-id",
                    before.as_str(),
                    after.as_str(),
                ],
            )
            .await?;
        let statistics = parse_numstat(&statistics.stdout, &statistics.command)?;
        parse_raw_changes(&raw.stdout, &raw.command, &statistics)
    }

    /// Reads one blob object by ID. Callers select IDs from immutable tree metadata.
    pub async fn read_blob(
        &self,
        repository: &GitRepository,
        object_id: &str,
        max_bytes: usize,
    ) -> GitResult<(Vec<u8>, bool)> {
        validate_object_id(object_id, "blob object ID")?;
        if max_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "blob byte limit",
                requirement: "must be non-zero",
            });
        }
        let output = self
            .run_query(repository.worktree_root(), ["cat-file", "blob", object_id])
            .await?;
        let truncated = output.stdout.len() > max_bytes;
        let mut bytes = output.stdout;
        bytes.truncate(max_bytes);
        Ok((bytes, truncated))
    }

    /// Produces a bounded patch for commit-message generation without reading a live checkout.
    pub async fn diff_tree_text(
        &self,
        repository: &GitRepository,
        before: &GitTreeId,
        after: &GitTreeId,
        max_bytes: usize,
    ) -> GitResult<GitTreeTextDiff> {
        if max_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "tree diff byte limit",
                requirement: "must be non-zero",
            });
        }
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "diff-tree",
                    "--patch",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-commit-id",
                    "-r",
                    "-M",
                    before.as_str(),
                    after.as_str(),
                ],
            )
            .await?;
        let truncated = output.stdout.len() > max_bytes;
        let mut bytes = output.stdout;
        bytes.truncate(max_bytes);
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Ok(GitTreeTextDiff { text, truncated })
    }
}

#[derive(Clone, Copy)]
struct TreeStatistics {
    binary: bool,
    additions: u64,
    deletions: u64,
}

fn parse_raw_changes(
    output: &[u8],
    command: &str,
    statistics: &BTreeMap<PathBuf, TreeStatistics>,
) -> GitResult<Vec<GitTreeChange>> {
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(header) = fields.next() {
        let header = std::str::from_utf8(header)
            .map_err(|_| GitError::invalid_output(command, "raw tree header was not UTF-8"))?;
        let values = header
            .strip_prefix(':')
            .ok_or_else(|| GitError::invalid_output(command, "raw tree header omitted ':'"))?
            .split_whitespace()
            .collect::<Vec<_>>();
        if values.len() != 5 {
            return Err(GitError::invalid_output(
                command,
                "raw tree header did not contain five fields",
            ));
        }
        let status = values[4]
            .as_bytes()
            .first()
            .copied()
            .ok_or_else(|| GitError::invalid_output(command, "raw tree status was empty"))?;
        let first_path = fields
            .next()
            .ok_or_else(|| GitError::invalid_output(command, "raw tree change omitted its path"))?;
        let (kind, previous_path, path) = match status {
            b'A' => (
                GitTreeChangeKind::Added,
                None,
                path_from_git_bytes(first_path, command)?,
            ),
            b'M' => (
                GitTreeChangeKind::Modified,
                None,
                path_from_git_bytes(first_path, command)?,
            ),
            b'D' => (
                GitTreeChangeKind::Deleted,
                None,
                path_from_git_bytes(first_path, command)?,
            ),
            b'T' => (
                GitTreeChangeKind::TypeChanged,
                None,
                path_from_git_bytes(first_path, command)?,
            ),
            b'R' => {
                let next_path = fields.next().ok_or_else(|| {
                    GitError::invalid_output(command, "raw rename omitted its destination")
                })?;
                (
                    GitTreeChangeKind::Renamed,
                    Some(path_from_git_bytes(first_path, command)?),
                    path_from_git_bytes(next_path, command)?,
                )
            }
            _ => {
                return Err(GitError::invalid_output(
                    command,
                    format!("unsupported raw tree status {}", status as char),
                ));
            }
        };
        let stats = statistics.get(&path).copied().unwrap_or(TreeStatistics {
            binary: false,
            additions: 0,
            deletions: 0,
        });
        changes.push(GitTreeChange {
            path,
            previous_path,
            kind,
            before_mode: object_field(values[0]),
            after_mode: object_field(values[1]),
            before_object_id: object_field(values[2]),
            after_object_id: object_field(values[3]),
            binary: stats.binary,
            additions: stats.additions,
            deletions: stats.deletions,
        });
    }
    Ok(changes)
}

fn parse_numstat(output: &[u8], command: &str) -> GitResult<BTreeMap<PathBuf, TreeStatistics>> {
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut statistics = BTreeMap::new();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.is_empty() && index == fields.len() {
            break;
        }
        let mut columns = field.splitn(3, |byte| *byte == b'\t');
        let additions = columns
            .next()
            .ok_or_else(|| GitError::invalid_output(command, "numstat record omitted additions"))?;
        let deletions = columns
            .next()
            .ok_or_else(|| GitError::invalid_output(command, "numstat record omitted deletions"))?;
        let inline_path = columns
            .next()
            .ok_or_else(|| GitError::invalid_output(command, "numstat record omitted its path"))?;
        let path = if inline_path.is_empty() {
            if index + 1 >= fields.len() {
                return Err(GitError::invalid_output(
                    command,
                    "numstat rename omitted source or destination",
                ));
            }
            index += 1;
            let destination = fields[index];
            index += 1;
            path_from_git_bytes(destination, command)?
        } else {
            path_from_git_bytes(inline_path, command)?
        };
        let binary = additions == b"-" || deletions == b"-";
        statistics.insert(
            path,
            TreeStatistics {
                binary,
                additions: parse_count(additions, command)?,
                deletions: parse_count(deletions, command)?,
            },
        );
    }
    Ok(statistics)
}

fn parse_count(value: &[u8], command: &str) -> GitResult<u64> {
    if value == b"-" {
        return Ok(0);
    }
    std::str::from_utf8(value)
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| GitError::invalid_output(command, "numstat count was invalid"))
}

fn object_field(value: &str) -> Option<String> {
    (!value.bytes().all(|byte| byte == b'0')).then(|| value.to_string())
}

fn parse_tree_id(output: Vec<u8>, command: &str) -> GitResult<GitTreeId> {
    let value = String::from_utf8(output)
        .map_err(|_| GitError::invalid_output(command, "tree object ID was not UTF-8"))?;
    GitTreeId::new(value.trim().to_string())
}

fn validate_object_id(value: &str, field: &'static str) -> GitResult<()> {
    if !(40..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::InvalidConfiguration {
            field,
            requirement: "must be a hexadecimal Git object ID",
        });
    }
    Ok(())
}

pub(crate) fn validate_checkout_path(path: &Path) -> GitResult<PathBuf> {
    if !path.is_absolute() || path.exists() {
        return Err(GitError::InvalidConfiguration {
            field: "worktree checkout path",
            requirement: "must be an absolute path that does not exist",
        });
    }
    Ok(path.to_path_buf())
}

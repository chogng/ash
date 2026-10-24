use sha2::Digest;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Read;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::GitChangeStatus;
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::path::path_from_git_bytes;

// Only derived immutable comparisons are retained. Replacement refs and shallow
// boundaries can change a commit's interpretation without changing its object ID.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryVersion {
    repository: GitRepository,
    metadata: Vec<(Option<SystemTime>, SystemTime)>,
    shallow: [u8; 32],
    configuration: [u8; 32],
}

pub(crate) fn history_version(repository: &GitRepository) -> Option<HistoryVersion> {
    if std::env::var_os("GIT_REPLACE_REF_BASE").is_some()
        || repository
            .common_dir()
            .join("refs/replace")
            .try_exists()
            .ok()?
    {
        return None;
    }
    let read_metadata = |path: &Path| -> Option<Vec<u8>> {
        match std::fs::File::open(path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
                (bytes.len() <= 1024 * 1024).then_some(bytes)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
            Err(_) => None,
        }
    };
    let packed_refs = read_metadata(&repository.common_dir().join("packed-refs"))?;
    if packed_refs
        .windows(b"refs/replace/".len())
        .any(|part| part == b"refs/replace/")
    {
        return None;
    }
    let metadata = [
        repository.git_dir().to_owned(),
        repository.common_dir().join("objects"),
    ]
    .iter()
    .map(|path| {
        let metadata = std::fs::metadata(path).ok()?;
        Some((metadata.created().ok(), metadata.modified().ok()?))
    })
    .collect::<Option<Vec<_>>>()?;
    let mut configuration = sha2::Sha256::new();
    for path in [
        repository.common_dir().join("config"),
        repository.git_dir().join("config.worktree"),
        repository.common_dir().join("info/grafts"),
    ] {
        configuration.update(sha2::Sha256::digest(read_metadata(&path)?));
    }
    Some(HistoryVersion {
        repository: repository.clone(),
        metadata,
        shallow: sha2::Sha256::digest(read_metadata(&repository.common_dir().join("shallow"))?)
            .into(),
        configuration: configuration.finalize().into(),
    })
}

#[derive(Debug, Default)]
pub(crate) struct HistoryCache {
    entries: VecDeque<HistoryComparison>,
}

#[derive(Debug)]
struct HistoryComparison {
    version: HistoryVersion,
    object_id: String,
    base: Option<String>,
    rename_argument: String,
    maximum_bytes: usize,
    parent: Option<String>,
    changes: Vec<GitCommitChange>,
    bytes: usize,
}

/// One path changed by a commit relative to its first parent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitChange {
    path: PathBuf,
    original_path: Option<PathBuf>,
    status: GitChangeStatus,
}

impl GitCommitChange {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn original_path(&self) -> Option<&Path> {
        self.original_path.as_deref()
    }

    pub fn status(&self) -> GitChangeStatus {
        self.status
    }
}

/// The before/after bytes used to open one committed path in an editor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitFile {
    original: Option<Vec<u8>>,
    modified: Option<Vec<u8>>,
}

impl GitCommitFile {
    pub fn original(&self) -> Option<&[u8]> {
        self.original.as_deref()
    }

    pub fn modified(&self) -> Option<&[u8]> {
        self.modified.as_deref()
    }
}

/// Whether history compares two trees or changes since their common ancestor.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum GitComparisonMode {
    Direct,
    MergeBase,
}

/// Commit metadata and first-parent change totals, read only when details are requested.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GitCommitDetails {
    pub author_name: String,
    pub author_email: String,
    pub timestamp_seconds: i64,
    pub message: String,
    pub statistics: GitCommitStatistics,
}

/// Binary paths contribute to the file count, but have no added or deleted line count.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GitCommitStatistics {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
}

impl GitClient {
    /// Uses the same first-parent comparison as history expansion, including root and merge commits.
    pub async fn commit_details(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<GitCommitDetails> {
        validate_object_id(object_id)?;
        let version = history_version(repository);
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "show",
                    "--first-parent",
                    "--diff-merges=first-parent",
                    "--no-notes",
                    "--no-show-signature",
                    "--no-decorate",
                    "--root",
                    "--raw",
                    "--numstat",
                    &self.rename_argument(),
                    "-z",
                    "--format=format:%H%x00%P%x00%an%x00%ae%x00%ct%x00%B%x00",
                    object_id,
                    "--",
                ],
            )
            .await?;
        let mut fields = output.stdout.splitn(7, |byte| *byte == 0);
        let mut text = || -> GitResult<String> {
            let value = fields.next().ok_or_else(|| {
                GitError::invalid_output(&output.command, "commit details omitted metadata")
            })?;
            std::str::from_utf8(value).map(str::to_owned).map_err(|_| {
                GitError::invalid_output(&output.command, "commit details were not UTF-8")
            })
        };
        if text()? != object_id {
            return Err(GitError::invalid_output(
                &output.command,
                "commit details did not begin with the requested object",
            ));
        }
        let parent = text()?.split_ascii_whitespace().next().map(str::to_owned);
        if let Some(parent) = &parent {
            validate_object_id(parent)?;
        }
        let author_name = text()?;
        let author_email = text()?;
        let timestamp_seconds = text()?.parse().map_err(|_| {
            GitError::invalid_output(&output.command, "commit timestamp was invalid")
        })?;
        let message = text()?.trim_end_matches('\n').to_owned();
        let diff = fields.next().ok_or_else(|| {
            GitError::invalid_output(&output.command, "commit details omitted statistics")
        })?;
        let (changes, statistics) =
            parse_commit_details_diff(diff.strip_prefix(b"\n").unwrap_or(diff), &output.command)?;
        // Details already compute the first-parent diff for line counts. Retain its
        // paths in the existing versioned cache so expansion needs no second process.
        self.cache_history_changes(repository, version, object_id, None, parent, &changes);
        Ok(GitCommitDetails {
            author_name,
            author_email,
            timestamp_seconds,
            message,
            statistics,
        })
    }

    /// Lists files changed by a commit relative to its first parent.
    ///
    /// Root commits are compared with the empty tree. Merge commits intentionally use their first
    /// parent, matching the history-item expansion shown by common Git workbench UIs.
    pub async fn commit_changes(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<(Option<String>, Vec<GitCommitChange>)> {
        validate_object_id(object_id)?;
        if let Some(cached) = self.cached_history_changes(repository, object_id, None) {
            return Ok(cached);
        }
        let version = history_version(repository);
        // Read the first parent and paths together. Separate rev-list and diff
        // processes add a cold-start penalty to every newly expanded commit.
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "show",
                    "--first-parent",
                    "--diff-merges=first-parent",
                    "--no-notes",
                    "--no-show-signature",
                    "--no-decorate",
                    "--root",
                    "--name-status",
                    &self.rename_argument(),
                    "-z",
                    "--format=format:%H%x00%P%x00",
                    object_id,
                    "--",
                ],
            )
            .await?;
        let mut fields = output.stdout.splitn(3, |byte| *byte == 0);
        if fields.next() != Some(object_id.as_bytes()) {
            return Err(GitError::invalid_output(
                &output.command,
                "commit changes did not begin with the requested object",
            ));
        }
        let parents = fields
            .next()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or_else(|| {
                GitError::invalid_output(&output.command, "commit changes omitted parents")
            })?;
        let parent_object_id = parents.split_ascii_whitespace().next().map(str::to_owned);
        if let Some(parent) = &parent_object_id {
            validate_object_id(parent).map_err(|_| {
                GitError::invalid_output(&output.command, "commit parent was invalid")
            })?;
        }
        let paths = fields.next().ok_or_else(|| {
            GitError::invalid_output(&output.command, "commit changes omitted paths")
        })?;
        let changes =
            parse_commit_changes(paths.strip_prefix(b"\n").unwrap_or(paths), &output.command)?;
        self.cache_history_changes(
            repository,
            version,
            object_id,
            None,
            parent_object_id.clone(),
            &changes,
        );
        Ok((parent_object_id, changes))
    }

    /// Compares immutable commits; the base may be a ref selected by the user.
    pub async fn compare_changes(
        &self,
        repository: &GitRepository,
        object_id: &str,
        base_reference: &str,
        mode: GitComparisonMode,
    ) -> GitResult<(String, Vec<GitCommitChange>)> {
        validate_object_id(object_id)?;
        // A full OID returned with the expanded history item has already been
        // resolved. Ref names still resolve on every request so branch moves win.
        if mode == GitComparisonMode::Direct && validate_object_id(base_reference).is_ok() {
            if let Some((Some(base), changes)) =
                self.cached_history_changes(repository, object_id, Some(base_reference))
            {
                return Ok((base, changes));
            }
        }
        let base = self.resolve_commit(repository, base_reference).await?;
        let base = match mode {
            GitComparisonMode::Direct => base,
            GitComparisonMode::MergeBase => {
                let output = self
                    .run_query(repository.worktree_root(), ["merge-base", &base, object_id])
                    .await?;
                let base = String::from_utf8_lossy(&output.stdout).trim().to_string();
                validate_object_id(&base)?;
                base
            }
        };
        if let Some((Some(base), changes)) =
            self.cached_history_changes(repository, object_id, Some(&base))
        {
            return Ok((base, changes));
        }
        let version = history_version(repository);
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "diff",
                    "--name-status",
                    &self.rename_argument(),
                    "-z",
                    &base,
                    object_id,
                    "--",
                ],
            )
            .await?;
        let changes = parse_commit_changes(&output.stdout, &output.command)?;
        self.cache_history_changes(
            repository,
            version,
            object_id,
            Some(&base),
            Some(base.clone()),
            &changes,
        );
        Ok((base, changes))
    }

    fn cached_history_changes(
        &self,
        repository: &GitRepository,
        object_id: &str,
        base: Option<&str>,
    ) -> Option<(Option<String>, Vec<GitCommitChange>)> {
        let version = history_version(repository)?;
        let mut cache = self
            .history_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = cache.entries.iter().position(|entry| {
            entry.version == version
                && entry.object_id == object_id
                && (entry.base.as_deref() == base
                    || (base.is_some() && entry.parent.as_deref() == base))
                && entry.rename_argument == self.rename_argument()
                && entry.maximum_bytes == self.limits().max_output_bytes()
        })?;
        let entry = cache.entries.remove(index)?;
        let result = (entry.parent.clone(), entry.changes.clone());
        cache.entries.push_back(entry);
        Some(result)
    }

    fn cache_history_changes(
        &self,
        repository: &GitRepository,
        version: Option<HistoryVersion>,
        object_id: &str,
        base: Option<&str>,
        parent: Option<String>,
        changes: &[GitCommitChange],
    ) {
        const MAXIMUM_BYTES: usize = 2 * 1024 * 1024;
        let Some(version) =
            version.filter(|version| history_version(repository).as_ref() == Some(version))
        else {
            return;
        };
        let bytes = changes
            .iter()
            .map(|change| {
                std::mem::size_of::<GitCommitChange>()
                    + change.path.as_os_str().len()
                    + change
                        .original_path
                        .as_ref()
                        .map_or(0, |path| path.as_os_str().len())
            })
            .sum::<usize>();
        if bytes > MAXIMUM_BYTES {
            return;
        }
        let mut cache = self
            .history_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Page details arrive before any item is expanded; keep a normal page
        // available while retaining the same total byte budget.
        while cache.entries.len() >= 128
            || cache.entries.iter().map(|entry| entry.bytes).sum::<usize>() + bytes > MAXIMUM_BYTES
        {
            cache.entries.pop_front();
        }
        cache.entries.push_back(HistoryComparison {
            version,
            object_id: object_id.into(),
            base: base.map(str::to_owned),
            rename_argument: self.rename_argument(),
            maximum_bytes: self.limits().max_output_bytes(),
            parent,
            changes: changes.to_vec(),
            bytes,
        });
    }

    pub async fn commit_message(
        &self,
        repository: &GitRepository,
        object_id: &str,
    ) -> GitResult<String> {
        validate_object_id(object_id)?;
        let output = self
            .run_query(
                repository.worktree_root(),
                ["show", "--no-patch", "--format=%B", object_id, "--"],
            )
            .await?;
        String::from_utf8(output.stdout)
            .map(|message| message.trim_end_matches('\n').to_owned())
            .map_err(|_| GitError::invalid_output(output.command, "commit message was not UTF-8"))
    }

    /// Reads the before/after bytes for one changed path at a commit and its first parent.
    pub async fn commit_file(
        &self,
        repository: &GitRepository,
        object_id: &str,
        parent_object_id: Option<&str>,
        path: &Path,
        original_path: Option<&Path>,
        maximum_bytes: usize,
    ) -> GitResult<GitCommitFile> {
        validate_object_id(object_id)?;
        if let Some(parent) = parent_object_id {
            validate_object_id(parent)?;
        }
        validate_relative_path(path)?;
        if let Some(original_path) = original_path {
            validate_relative_path(original_path)?;
        }
        if maximum_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_bytes",
                requirement: "must be non-zero",
            });
        }
        let original = match parent_object_id {
            Some(parent) => {
                self.read_file_at_object(
                    repository,
                    original_path.unwrap_or(path),
                    parent,
                    maximum_bytes,
                )
                .await?
            }
            None => None,
        };
        let modified = self
            .read_file_at_object(repository, path, object_id, maximum_bytes)
            .await?;
        Ok(GitCommitFile { original, modified })
    }

    async fn read_file_at_object(
        &self,
        repository: &GitRepository,
        path: &Path,
        object_id: &str,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        if self.uses_system_executable()
            && !path
                .as_os_str()
                .as_encoded_bytes()
                .iter()
                .any(|byte| matches!(byte, 0 | b'\n'))
        {
            if let Some(version) = history_version(repository) {
                match self
                    .read_history_batch(repository, path, object_id, version, maximum_bytes)
                    .await
                {
                    Err(GitError::InvalidOutput { .. } | GitError::IndexChanged) => {}
                    result => return result,
                }
            }
        }
        let mut object = OsString::from(object_id);
        object.push(":");
        object.push(path);
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("show"),
                    OsString::from("--no-textconv"),
                    object,
                ],
            )
            .await?;
        if !output.status.success() {
            return if missing_object(&output.stderr) {
                Ok(None)
            } else {
                Err(GitError::CommandFailed {
                    command: output.command,
                    exit_code: output.status.code(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            };
        }
        if output.stdout.len() > maximum_bytes {
            return Err(GitError::OutputLimitExceeded {
                command: output.command,
                stream: "stdout",
                limit_bytes: maximum_bytes,
            });
        }
        Ok(Some(output.stdout))
    }
}

/// Git emits raw records before numstat records, with NUL-delimited paths in both.
fn parse_commit_details_diff(
    mut bytes: &[u8],
    command: &str,
) -> GitResult<(Vec<GitCommitChange>, GitCommitStatistics)> {
    let mut names = Vec::new();
    while bytes.starts_with(b":") {
        let end = bytes.iter().position(|byte| *byte == 0).ok_or_else(|| {
            GitError::invalid_output(command, "raw commit change omitted its header terminator")
        })?;
        let header = &bytes[..end];
        let status = header.rsplit(|byte| *byte == b' ').next().ok_or_else(|| {
            GitError::invalid_output(command, "raw commit change omitted its status")
        })?;
        names.extend_from_slice(status);
        names.push(0);
        let paths = if matches!(status.first(), Some(b'R' | b'C')) {
            2
        } else {
            1
        };
        bytes = &bytes[end + 1..];
        for _ in 0..paths {
            let end = bytes.iter().position(|byte| *byte == 0).ok_or_else(|| {
                GitError::invalid_output(command, "raw commit change omitted its path terminator")
            })?;
            names.extend_from_slice(&bytes[..=end]);
            bytes = &bytes[end + 1..];
        }
    }
    Ok((
        parse_commit_changes(&names, command)?,
        crate::objects::commit_statistics(bytes, command)?,
    ))
}

fn parse_commit_changes(bytes: &[u8], command: &str) -> GitResult<Vec<GitCommitChange>> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(status_field) = fields.next() {
        let status_text = std::str::from_utf8(status_field)
            .map_err(|_| GitError::invalid_output(command, "commit change status was not UTF-8"))?;
        let status_code =
            status_text.as_bytes().first().copied().ok_or_else(|| {
                GitError::invalid_output(command, "commit change status was empty")
            })?;
        let status = parse_status(status_code, command)?;
        let first_path = fields
            .next()
            .ok_or_else(|| GitError::invalid_output(command, "commit change omitted its path"))?;
        let (path, original_path) = if matches!(status_code, b'R' | b'C') {
            let path = fields.next().ok_or_else(|| {
                GitError::invalid_output(
                    command,
                    "renamed commit change omitted its destination path",
                )
            })?;
            (
                path_from_git_bytes(path, command)?,
                Some(path_from_git_bytes(first_path, command)?),
            )
        } else {
            (path_from_git_bytes(first_path, command)?, None)
        };
        changes.push(GitCommitChange {
            path,
            original_path,
            status,
        });
    }
    Ok(changes)
}

fn parse_status(code: u8, command: &str) -> GitResult<GitChangeStatus> {
    match code {
        b'M' => Ok(GitChangeStatus::Modified),
        b'A' => Ok(GitChangeStatus::Added),
        b'D' => Ok(GitChangeStatus::Deleted),
        b'R' => Ok(GitChangeStatus::Renamed),
        b'C' => Ok(GitChangeStatus::Copied),
        b'T' => Ok(GitChangeStatus::TypeChanged),
        b'U' => Ok(GitChangeStatus::Unmerged),
        _ => Err(GitError::invalid_output(
            command,
            format!("unknown commit change status {}", char::from(code)),
        )),
    }
}

fn validate_object_id(object_id: &str) -> GitResult<()> {
    if !(40..=64).contains(&object_id.len())
        || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GitError::runtime(
            "validate Git object id",
            "object id must be a 40-64 character hexadecimal hash",
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> GitResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(GitError::runtime(
            "validate Git commit path",
            "path must be a non-empty normalized repository-relative path",
        ));
    }
    Ok(())
}

fn missing_object(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    stderr.contains("does not exist in")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("Path '")
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

mod graph;

pub use graph::GitGraph;
pub use graph::GitGraphCursor;
pub use graph::GitReference;
pub use graph::GitReferenceKind;
pub use summary::GitCommitSummary;
mod summary;

/// Authorship of one line in the working tree, including uncommitted content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBlameLine {
    pub object_id: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
}

/// One file history record with separate author and commit clocks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitFileHistoryItem {
    pub path: PathBuf,
    pub object_id: String,
    pub author_name: String,
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
}

/// A bounded portion of one file traversal, with an opaque continuation for its snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitFileHistoryPage {
    pub items: Vec<GitFileHistoryItem>,
    pub next_cursor: Option<GitFileHistoryCursor>,
}

/// Continues the same log traversal and carries rename state across page boundaries.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitFileHistoryCursor {
    root: PathBuf,
    requested_path: PathBuf,
    head: String,
    skip: usize,
    historical_path: PathBuf,
}

impl GitClient {
    pub async fn blame_line(
        &self,
        repository: &GitRepository,
        path: &Path,
        line: usize,
        ignore_whitespace: bool,
        contents: Option<&str>,
    ) -> GitResult<GitBlameLine> {
        crate::GitPathspecSet::new(vec![path.to_path_buf()])?;
        if line == 0
            || line > 10_000_000
            || contents.is_some_and(|text| text.len() > 2 * 1024 * 1024)
        {
            return Err(crate::error::invalid_command(
                "invalid blame range or contents",
            ));
        }
        let mut args = vec![
            OsString::from("blame"),
            OsString::from("--line-porcelain"),
            OsString::from(format!("-L{line},{line}")),
        ];
        if ignore_whitespace {
            args.push(OsString::from("-w"));
        }
        if contents.is_some() {
            args.extend([OsString::from("--contents"), OsString::from("-")]);
        }
        args.extend([OsString::from("--"), path.as_os_str().to_owned()]);
        let output = match contents {
            Some(text) => {
                self.run_query_with_stdin(
                    repository.worktree_root(),
                    args,
                    text.as_bytes().to_vec(),
                )
                .await?
            }
            None => self.run_query(repository.worktree_root(), args).await?,
        }
        .require_success()?;
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| GitError::invalid_output(&output.command, "blame output is not UTF-8"))?;
        let mut lines = text.lines();
        let object_id = lines
            .next()
            .and_then(|line| line.split_whitespace().next())
            .filter(|id| {
                matches!(id.len(), 40 | 64) && id.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .ok_or_else(|| GitError::invalid_output(&output.command, "invalid blame object"))?
            .to_owned();
        let mut fields = std::collections::HashMap::new();
        for line in lines.take_while(|line| !line.starts_with('\t')) {
            if let Some((key, value)) = line.split_once(' ') {
                fields.insert(key, value);
            }
        }
        let required = |key| {
            fields
                .get(key)
                .copied()
                .ok_or_else(|| GitError::invalid_output(&output.command, "missing blame metadata"))
        };
        Ok(GitBlameLine {
            object_id,
            author_name: required("author")?.to_owned(),
            author_email: required("author-mail")?.trim_matches(['<', '>']).to_owned(),
            author_time: required("author-time")?
                .parse()
                .map_err(|_| GitError::invalid_output(&output.command, "invalid blame time"))?,
            subject: required("summary")?.to_owned(),
        })
    }

    /// Reads a bounded page in native follow order, retaining the initial HEAD and rename state.
    /// Starting without a cursor observes the current repository history.
    pub async fn file_history(
        &self,
        repository: &GitRepository,
        path: &Path,
        limit: NonZeroUsize,
        cursor: Option<GitFileHistoryCursor>,
    ) -> GitResult<GitFileHistoryPage> {
        crate::GitPathspecSet::new(vec![path.to_path_buf()])?;
        let mut cursor = if let Some(cursor) = cursor {
            if cursor.root != repository.worktree_root() || cursor.requested_path != path {
                return Err(GitError::InvalidConfiguration {
                    field: "file_history_cursor",
                    requirement: "must belong to the same worktree and file",
                });
            }
            validate_object_id(&cursor.head)?;
            crate::GitPathspecSet::new(vec![cursor.historical_path.clone()])?;
            cursor
        } else {
            let head = self
                .run_query_unchecked(
                    repository.worktree_root(),
                    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
                )
                .await?;
            if head.status.code() == Some(1) {
                return Ok(GitFileHistoryPage {
                    items: Vec::new(),
                    next_cursor: None,
                });
            }
            let head = head.require_success()?;
            let head = String::from_utf8_lossy(&head.stdout).trim().to_owned();
            validate_object_id(&head)?;
            GitFileHistoryCursor {
                root: repository.worktree_root().to_path_buf(),
                requested_path: path.to_path_buf(),
                head,
                skip: 0,
                historical_path: path.to_path_buf(),
            }
        };
        let count = limit
            .get()
            .checked_add(1)
            .ok_or(GitError::InvalidConfiguration {
                field: "file_history_limit",
                requirement: "must leave room for one lookahead record",
            })?;
        let traversal_count =
            cursor
                .skip
                .checked_add(count)
                .ok_or(GitError::InvalidConfiguration {
                    field: "file_history_cursor",
                    requirement: "must leave room for the requested page",
                })?;
        // Git's --skip loses --follow rename state, and restarting at a matching
        // commit loses pending merge parents. Stream the same anchored traversal,
        // discard its consumed prefix, and stop after one page plus lookahead.
        let mut stream = self
            .start_query_stream(
                repository.worktree_root(),
                [
                    OsString::from("log"),
                    OsString::from("--follow"),
                    OsString::from(format!("--max-count={traversal_count}")),
                    OsString::from("--format=%H%x00%an%x00%at%x00%ct%x00%s"),
                    OsString::from("-z"),
                    OsString::from(&cursor.head),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?;
        for _ in 0..cursor.skip {
            if !stream.discard_fields(5).await? {
                stream.finish().await?;
                return Err(GitError::InvalidConfiguration {
                    field: "file_history_cursor",
                    requirement: "must refer to an existing traversal position",
                });
            }
        }
        let command = stream.command().to_owned();
        let mut stream = Some(stream);
        let mut bytes = Vec::new();
        for _ in 0..count {
            let Some(first) = stream
                .as_mut()
                .expect("active file history stream")
                .next_field()
                .await?
            else {
                stream
                    .take()
                    .expect("completed file history stream")
                    .finish()
                    .await?;
                break;
            };
            bytes.extend_from_slice(&first);
            bytes.push(0);
            for _ in 0..4 {
                let field = stream
                    .as_mut()
                    .expect("active file history stream")
                    .next_field()
                    .await?
                    .ok_or_else(|| {
                        GitError::invalid_output(&command, "incomplete file history record")
                    })?;
                bytes.extend_from_slice(&field);
                bytes.push(0);
            }
        }
        drop(stream);
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| GitError::invalid_output(&command, "history output is not UTF-8"))?;
        if text.is_empty() {
            return Ok(GitFileHistoryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }
        let fields = text
            .strip_suffix('\0')
            .ok_or_else(|| GitError::invalid_output(&command, "unterminated file history"))?
            .split('\0')
            .collect::<Vec<_>>();
        if fields.len() % 5 != 0 {
            return Err(GitError::invalid_output(
                &command,
                "incomplete file history",
            ));
        }
        let mut items = fields
            .chunks_exact(5)
            .map(|record| {
                let time = |value: &str| {
                    value
                        .parse::<i64>()
                        .map_err(|_| GitError::invalid_output(&command, "invalid history time"))
                };
                Ok(GitFileHistoryItem {
                    path: path.to_path_buf(),
                    object_id: record[0].to_owned(),
                    author_name: record[1].to_owned(),
                    author_time: time(record[2])?,
                    commit_time: time(record[3])?,
                    subject: record[4].to_owned(),
                })
            })
            .collect::<GitResult<Vec<_>>>()?;
        let has_more = items.len() > limit.get();
        items.truncate(limit.get());
        let mut current_path = cursor.historical_path.clone();
        for item in &mut items {
            let (_, changes) = self.commit_changes(repository, &item.object_id).await?;
            item.path = current_path.clone();
            if let Some(change) = changes.iter().find(|change| change.path() == current_path) {
                if change.status() == GitChangeStatus::Renamed {
                    if let Some(original) = change.original_path() {
                        current_path = original.to_path_buf();
                    }
                }
            }
        }
        // Keep the original HEAD traversal instead of restarting at the next matching
        // commit: a merge can still have another parent branch pending at that point.
        cursor.skip =
            cursor
                .skip
                .checked_add(items.len())
                .ok_or(GitError::InvalidConfiguration {
                    field: "file_history_cursor",
                    requirement: "must not overflow the traversal offset",
                })?;
        cursor.historical_path = current_path;
        Ok(GitFileHistoryPage {
            items,
            next_cursor: has_more.then_some(cursor),
        })
    }
}

//! Process and protocol boundary for Ash's pinned tgrep runtime.

mod process;

use ash_async_utils::CancellationToken;
use ash_install_context::ExecutableCandidates;
use ash_install_context::InstallContext;
use ash_install_context::ManagedExecutable;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeSet;
use std::fmt;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

pub const VERSION: &str = "1.0.12-ash.1";
const TIMEOUT: Duration = Duration::from_secs(30);
const INDEX_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug)]
pub enum Error {
    Failed(String),
    Cancelled(String),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(message) | Self::Cancelled(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Failed(error.to_string())
    }
}
fn failed(message: impl Into<String>) -> Error {
    Error::Failed(message.into())
}
fn check(cancellation: &CancellationToken, deadline: Instant) -> Result<(), Error> {
    cancellation
        .check()
        .map_err(|signal| Error::Cancelled(signal.reason().to_string()))?;
    if Instant::now() >= deadline {
        return Err(failed("tgrep request timed out"));
    }
    Ok(())
}

/// A validated, absolute identity of the bundled search executable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Executable(PathBuf);
impl Executable {
    pub fn resolve(installation: &InstallContext) -> Result<Self, Error> {
        match installation.executable_candidates(ManagedExecutable::Tgrep) {
            ExecutableCandidates::ExplicitOverride(value) => Self::from_path(value.path()),
            ExecutableCandidates::SearchPaths(paths) => paths
                .into_iter()
                .find(|p| p.is_file())
                .ok_or_else(|| failed("packaged tgrep is missing; prepare the Ash package"))
                .and_then(Self::from_path),
        }
    }
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = std::fs::canonicalize(path)?;
        if !path.is_file() {
            return Err(failed("tgrep executable is not a regular file"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&path)?.permissions().mode() & 0o111 == 0 {
                return Err(failed("tgrep executable is not executable"));
            }
        }
        Ok(Self(path))
    }
    /// Search-engine identity used to share storage and serving across linked worktrees.
    pub fn directory_identity(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, Error> {
        let mut command = std::process::Command::new(&self.0);
        command.arg("identity").arg(root);
        let lines = process::capture(command, cancellation, Instant::now() + TIMEOUT, 1)?;
        let value: Value = serde_json::from_str(
            lines
                .first()
                .ok_or_else(|| failed("missing search identity"))?,
        )?;
        let directory = value["directory"]
            .as_str()
            .ok_or_else(|| failed("invalid search identity"))?;
        dunce::canonicalize(directory).map_err(Into::into)
    }
}

pub struct Query<'a> {
    pub pattern: &'a str,
    pub scope: &'a Path,
    pub case_insensitive: bool,
    pub include: &'a [&'a str],
    pub max_results: usize,
    pub current: bool,
    pub exclude: &'a [&'a str],
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct Match {
    #[serde(rename = "file")]
    pub path: PathBuf,
    #[serde(rename = "line")]
    pub line_number: usize,
    pub content: String,
}
pub struct SearchResult {
    pub matches: Vec<Match>,
    pub limit_hit: bool,
    pub indexed: bool,
    pub index_stats: Option<IndexStats>,
}

/// Candidate statistics from one worktree query, including acknowledged Ash edits.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct IndexStats {
    pub query_plan: String,
    pub raw_candidates: usize,
    pub candidates: usize,
    pub total_files: usize,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Status {
    #[serde(rename = "num_files")]
    pub indexed_file_count: usize,
    pub indexing: bool,
    pub hidden_complete: bool,
    pub watcher_active: bool,
}

/// A worktree registration in an owned shared search service.
/// Pending Ash writes are acknowledged by the engine before the next indexed search.
pub struct Session {
    executable: Executable,
    root: PathBuf,
    process: std::sync::Arc<process::Server>,
    worktree_id: u64,
    changed: Mutex<BTreeSet<PathBuf>>,
}
impl Session {
    pub fn open(
        executable: Executable,
        root: &Path,
        index: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        let root = dunce::canonicalize(root)?;
        let process = process::Server::shared(&executable, &root, index, cancellation)?;
        let registration = process.rpc(
            "attach",
            json!({"root":root}),
            cancellation,
            Instant::now() + INDEX_TIMEOUT,
        )?;
        let worktree_id = registration["worktree_id"]
            .as_u64()
            .ok_or_else(|| failed("missing worktree registration"))?;
        Ok(Self {
            executable,
            root,
            process,
            worktree_id,
            changed: Mutex::new(BTreeSet::new()),
        })
    }
    pub fn status(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        serde_json::from_value(self.rpc(
            "status",
            json!({}),
            cancellation,
            Instant::now() + TIMEOUT,
        )?)
        .map_err(Into::into)
    }
    pub fn rebuild(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        // Serialize the edit set across reload so writes racing publication remain dirty afterwards.
        let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
        self.rpc("reload", json!({}), cancellation, Instant::now() + TIMEOUT)?;
        changed.clear();
        self.status(cancellation)
    }
    pub fn paths_changed(&self, paths: &[PathBuf]) {
        let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
        for path in paths {
            // Windows filesystem notifications and directory services may spell the same
            // absolute path with or without the extended prefix, including deleted files.
            let path = dunce::simplified(path);
            if let Ok(relative) = path.strip_prefix(&self.root) {
                if relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_)))
                {
                    changed.insert(relative.to_path_buf());
                }
            }
        }
    }
    pub fn search(
        &self,
        query: &Query<'_>,
        cancellation: &CancellationToken,
    ) -> Result<SearchResult, Error> {
        let deadline = Instant::now() + TIMEOUT;
        let limit = query.max_results;
        if limit == 0 || limit > 5000 {
            return Err(failed("invalid result limit"));
        }
        check(cancellation, deadline)?;
        if query.pattern.is_empty() || query.pattern.len() > 65536 {
            return Err(failed("search pattern must contain 1 to 65536 bytes"));
        }
        regex::Regex::new(query.pattern).map_err(|e| failed(e.to_string()))?;
        validate_relative(query.scope)?;
        let scope = self.root.join(query.scope);
        let canonical = dunce::canonicalize(&scope)?;
        if !canonical.starts_with(&self.root) {
            return Err(failed("search scope escapes its workspace"));
        }
        // Current searches and explicit files may include ignored files.
        if query.current || scope.is_file() {
            let mut result = self.scan(query, &[scope], cancellation, deadline)?;
            result.matches.truncate(limit);
            return Ok(result);
        }
        let mut changed = self.changed.lock().unwrap();
        if !changed.is_empty() {
            self.rpc(
                "refresh",
                json!({"paths":changed.iter().collect::<Vec<_>>()}),
                cancellation,
                deadline,
            )?;
            changed.clear();
        }
        drop(changed);
        let mut globs: Vec<String> = query.include.iter().map(|s| (*s).to_owned()).collect();
        globs.extend(query.exclude.iter().map(|g| format!("!{g}")));
        let result = self.rpc("search", json!({
            "pattern":query.pattern,"case_insensitive":query.case_insensitive,
            "scope":portable(query.scope)?,"glob":globs,"files_only":false,
            "max_count":limit+1,"max_results":limit+1,"detail":false,"positions":false,"stats":true
        }), cancellation, deadline)?;
        let index_stats = serde_json::from_value(result["index_stats"].clone())?;
        let mut matches = Vec::new();
        for value in rows(&result)? {
            if value.get("type").and_then(Value::as_str) != Some("match") {
                continue;
            }
            let found: Match = serde_json::from_value(value.clone())?;
            self.validate_result_path(&found.path, query.scope)?;
            if found.line_number == 0 {
                return Err(failed("invalid tgrep match"));
            }
            matches.push(found);
        }
        let limit_hit = matches.len() > limit;
        matches.truncate(limit);
        Ok(SearchResult {
            matches,
            limit_hit,
            indexed: true,
            index_stats: Some(index_stats),
        })
    }
    fn rpc(
        &self,
        method: &str,
        mut params: Value,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        params["worktree_id"] = json!(self.worktree_id);
        self.process.rpc(method, params, cancellation, deadline)
    }

    fn admitted(&self, relative: &Path, scope: &Path) -> bool {
        let absolute = self.root.join(relative);
        if !absolute.exists() {
            return false;
        }
        if !dunce::canonicalize(&absolute).is_ok_and(|p| p.starts_with(&self.root)) {
            return false;
        }
        let target = absolute.clone();
        // Ignore admission starts at the index root, including ignored scope ancestors.
        // Visibility starts at the explicit scope, allowing a hidden directory as root while
        // excluding hidden descendants (including the Windows hidden attribute).
        let admitted = ignore::WalkBuilder::new(&self.root)
            .require_git(false)
            .hidden(false)
            .filter_entry(move |entry| target.starts_with(entry.path()))
            .build()
            .filter_map(Result::ok)
            .any(|entry| {
                entry.path() == absolute
                    && entry.file_type().is_some_and(|t| t.is_file() || t.is_dir())
            });
        if !admitted {
            return false;
        }
        let target = absolute.clone();
        ignore::WalkBuilder::new(self.root.join(scope))
            .require_git(false)
            .filter_entry(move |entry| target.starts_with(entry.path()))
            .build()
            .filter_map(Result::ok)
            .any(|entry| {
                entry.path() == absolute
                    && entry.file_type().is_some_and(|t| t.is_file() || t.is_dir())
            })
    }
    fn validate_result_path(&self, path: &Path, scope: &Path) -> Result<(), Error> {
        validate_relative(path)?;
        if path.as_os_str().is_empty() || !path.starts_with(scope) {
            return Err(failed("tgrep returned an out-of-scope path"));
        }
        if let Ok(current) = dunce::canonicalize(self.root.join(path)) {
            if !current.starts_with(&self.root) {
                return Err(failed("tgrep result escapes its workspace"));
            }
        }
        Ok(())
    }
    fn scan(
        &self,
        query: &Query<'_>,
        paths: &[PathBuf],
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<SearchResult, Error> {
        let scope = self.root.join(query.scope);
        let filter_corpus = !query.current && scope.is_dir();
        if filter_corpus && !self.admitted(query.scope, query.scope) {
            return Ok(SearchResult {
                matches: Vec::new(),
                limit_hit: false,
                indexed: false,
                index_stats: None,
            });
        }
        let mut overrides = ignore::overrides::OverrideBuilder::new(&scope);
        for glob in query.include {
            overrides
                .add(&glob.replace('\\', "/"))
                .map_err(|e| failed(e.to_string()))?;
        }
        for glob in query.exclude {
            overrides
                .add(&format!("!{}", glob.replace('\\', "/")))
                .map_err(|e| failed(e.to_string()))?;
        }
        let overrides = overrides.build().map_err(|e| failed(e.to_string()))?;
        let mut command = std::process::Command::new(&self.executable.0);
        command.current_dir(&self.root).args([
            "--no-index",
            "--no-require-git",
            "--json",
            "--sort",
            "path",
            "--multiline",
        ]);
        command
            .arg("--max-count")
            .arg((query.max_results + 1).to_string());
        command.arg("--index-path").arg(self.process.index());
        if query.case_insensitive {
            command.arg("--ignore-case");
        }
        if !filter_corpus {
            for glob in query.include {
                command.arg("--glob").arg(glob);
            }
            for glob in query.exclude {
                command.arg("--glob").arg(format!("!{glob}"));
            }
        }
        command.arg("--").arg(query.pattern).args(paths);
        // Positive CLI globs override ignore rules. Apply index globs after the ordinary
        // directory walk, before the global row budget, including explicitly named dirty files.
        let records = process::scan(command, usize::MAX, cancellation, deadline, &|record| {
            if !filter_corpus {
                return Ok(true);
            }
            let path = record["data"]["path"]["text"]
                .as_str()
                .ok_or_else(|| failed("tgrep returned a non-text path"))?;
            let absolute = self.root.join(path);
            let relative = absolute
                .strip_prefix(&scope)
                .map_err(|_| failed("tgrep returned an out-of-scope path"))?;
            // Index glob filtering also prunes excluded ancestor directories, even when
            // dirty files were passed individually rather than reached through a walk.
            if relative
                .ancestors()
                .skip(1)
                .filter(|p| !p.as_os_str().is_empty())
                .any(|parent| overrides.matched(scope.join(parent), true).is_ignore())
            {
                return Ok(false);
            }
            Ok(!overrides.matched(absolute, false).is_ignore())
        })?;
        let mut blocks: Vec<(PathBuf, usize, u64, usize)> = Vec::new();
        for record in records {
            if record.get("type").and_then(Value::as_str) != Some("match") {
                continue;
            }
            let data = &record["data"];
            let path = data["path"]["text"]
                .as_str()
                .ok_or_else(|| failed("tgrep returned a non-text path"))?;
            let path = Path::new(path);
            let path = if path.is_absolute() {
                path.strip_prefix(&self.root)
                    .map_err(|_| failed("tgrep returned an out-of-scope path"))?
            } else {
                path.strip_prefix(".").unwrap_or(path)
            };
            self.validate_result_path(path, query.scope)?;
            let line = data["line_number"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| failed("invalid tgrep line number"))?
                as usize;
            let offset = data["absolute_offset"]
                .as_u64()
                .ok_or_else(|| failed("invalid tgrep byte offset"))?;
            if let Some((previous_path, first_line, _, length)) = blocks.last_mut()
                && previous_path == path
                && line == *first_line + *length
            {
                *length += 1;
            } else {
                blocks.push((path.to_path_buf(), line, offset, 1));
            }
        }
        let mut matches = Vec::new();
        let expression = regex::RegexBuilder::new(query.pattern)
            .case_insensitive(query.case_insensitive)
            .multi_line(true)
            .crlf(true)
            .build()
            .map_err(|e| failed(e.to_string()))?;
        for (path, first_line, offset, line_count) in blocks {
            check(cancellation, deadline)?;
            // JSON emits each covered line and normalizes its terminator. Read the
            // engine-selected interval to restore exact CRLF and Unicode offsets.
            let mut file = std::fs::File::open(self.root.join(&path))?;
            file.seek(SeekFrom::Start(offset))?;
            let mut reader = std::io::BufReader::new(file);
            let mut content = String::new();
            for _ in 0..line_count {
                std::io::BufRead::read_line(&mut reader, &mut content)?;
            }
            let starts: Vec<usize> = std::iter::once(0)
                .chain(content.match_indices('\n').map(|(index, _)| index + 1))
                .collect();
            for found in expression.find_iter(&content) {
                let first = starts.partition_point(|start| *start <= found.start()) - 1;
                let last =
                    starts.partition_point(|start| *start < found.end().max(found.start() + 1)) - 1;
                let end = starts.get(last + 1).copied().unwrap_or(content.len());
                let preview = content[starts[first]..end].trim_end_matches(['\r', '\n']);
                let end = if found.end() > starts[first] + preview.len() {
                    end
                } else {
                    starts[first] + preview.len()
                };
                let found = Match {
                    path: path.clone(),
                    line_number: first_line + first,
                    content: content[starts[first]..end].to_owned(),
                };
                if matches.last() != Some(&found) {
                    matches.push(found);
                }
                if matches.len() > query.max_results {
                    break;
                }
            }
            if matches.len() > query.max_results {
                break;
            }
        }
        order(&mut matches);
        // Retain one extra row so the caller can report the global result limit.
        let limit_hit = matches.len() > query.max_results;
        Ok(SearchResult {
            matches,
            limit_hit,
            indexed: false,
            index_stats: None,
        })
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let cancellation = ash_async_utils::CancellationSource::new();
        let _ = self.rpc(
            "detach",
            json!({}),
            &cancellation.token(),
            Instant::now() + Duration::from_secs(1),
        );
    }
}

fn validate_relative(path: &Path) -> Result<(), Error> {
    if !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(failed("search path must be workspace-relative"));
    }
    Ok(())
}
fn portable(path: &Path) -> Result<String, Error> {
    path.to_str()
        .map(|p| {
            if cfg!(windows) {
                p.replace('\\', "/")
            } else {
                p.into()
            }
        })
        .ok_or_else(|| failed("tgrep requires UTF-8 paths"))
}

fn rows(result: &Value) -> Result<&Vec<Value>, Error> {
    result["matches"]
        .as_array()
        .ok_or_else(|| failed("invalid tgrep search response"))
}
fn order(matches: &mut Vec<Match>) {
    matches.sort_by(|a, b| (&a.path, a.line_number).cmp(&(&b.path, b.line_number)));
    matches.dedup_by(|a, b| a.path == b.path && a.line_number == b.line_number);
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

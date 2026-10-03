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
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

pub const VERSION: &str = "1.0.11";
const TIMEOUT: Duration = Duration::from_secs(30);

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

/// Statistics from the initial indexed file-selection query, before the Ash edit overlay.
/// Content batches repeat that query with exact paths and must not be added to these counts.
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

/// One workspace's owned server. Edited paths are read directly until an explicit rebuild.
/// tgrep owns filesystem watching; this small path set provides read-after-write for Ash edits.
pub struct Session {
    executable: Executable,
    root: PathBuf,
    process: process::Server,
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
        let process = process::Server::start(&executable, &root, index, cancellation)?;
        Ok(Self {
            executable,
            root,
            process,
            changed: Mutex::new(BTreeSet::new()),
        })
    }
    pub fn status(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        serde_json::from_value(self.process.rpc(
            "status",
            Value::Null,
            cancellation,
            Instant::now() + TIMEOUT,
        )?)
        .map_err(Into::into)
    }
    pub fn rebuild(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        // Serialize the edit set across reload so writes racing publication remain dirty afterwards.
        let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
        self.process.rpc(
            "reload",
            Value::Null,
            cancellation,
            Instant::now() + TIMEOUT,
        )?;
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
        let status = self.status(cancellation)?;
        // Current searches and explicit files may include ignored files. Directory queries
        // requesting the index retain corpus admission even while initialization needs a scan.
        if query.current || scope.is_file() || !status.hidden_complete {
            let mut result = self.scan(query, &[scope], cancellation, deadline)?;
            result.matches.truncate(limit);
            return Ok(result);
        }
        let changed = self
            .changed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut globs: Vec<String> = query.include.iter().map(|s| (*s).to_owned()).collect();
        globs.extend(query.exclude.iter().map(|g| format!("!{g}")));
        let params = json!({"pattern":query.pattern,"case_insensitive":query.case_insensitive,
            "scope":portable(query.scope)?,"glob":globs,"files_only":true,"max_count":1,"detail":false,"positions":false,"stats":true});
        // One row per matching file bounds broad queries before asking for content. The server
        // has only a per-file max_count; the adapter enforces the caller's global limit.
        let files = self
            .process
            .rpc("search", params.clone(), cancellation, deadline)?;
        let index_stats = serde_json::from_value(files["index_stats"].clone())?;
        let mut paths = BTreeSet::new();
        for value in rows(&files)? {
            if value.get("type").and_then(Value::as_str) != Some("match") {
                continue;
            }
            let path = response_path(value)?;
            self.validate_result_path(&path, query.scope)?;
            if !changed.contains(&path) {
                paths.insert(path);
            }
        }
        let mut matches = Vec::new();
        // The edit overlay is delegated to the same executable. Admission traverses each
        // file's ancestors so ignored parent directories remain excluded.
        let dirty: Vec<_> = changed
            .iter()
            .filter(|p| p.starts_with(query.scope))
            .filter(|p| self.root.join(p).is_file() && self.admitted(p, query.scope))
            .map(|p| self.root.join(p))
            .collect();
        if !dirty.is_empty() {
            matches.extend(self.scan(query, &dirty, cancellation, deadline)?.matches);
        }
        let paths: Vec<_> = paths.into_iter().collect();
        for chunk in paths.chunks(8) {
            check(cancellation, deadline)?;
            if matches.len() > limit {
                order(&mut matches);
                if matches[limit].path < chunk[0] {
                    break;
                }
            }
            let mut request = params.clone();
            request["files_only"] = json!(false);
            request["stats"] = json!(false);
            request["max_count"] = json!(limit + 1);
            request["glob"] = json!(
                chunk
                    .iter()
                    .map(|p| p
                        .strip_prefix(query.scope)
                        .map_err(|_| failed("tgrep returned an out-of-scope path"))
                        .and_then(exact_glob))
                    .collect::<Result<Vec<_>, _>>()?
            );
            let result = self
                .process
                .rpc("search", request, cancellation, deadline)?;
            for value in rows(&result)? {
                if value.get("type").and_then(Value::as_str) != Some("match") {
                    continue;
                }
                let found: Match = serde_json::from_value(value.clone())?;
                self.validate_result_path(&found.path, query.scope)?;
                if !chunk.contains(&found.path) || found.line_number == 0 {
                    return Err(failed("invalid tgrep match"));
                }
                matches.push(found);
            }
            order(&mut matches);
            matches.truncate(limit + 1);
        }
        order(&mut matches);
        let limit_hit = matches.len() > limit;
        matches.truncate(limit);
        Ok(SearchResult {
            matches,
            limit_hit,
            indexed: true,
            index_stats: Some(index_stats),
        })
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
        let records = process::scan(
            command,
            query.max_results + 1,
            cancellation,
            deadline,
            &|record| {
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
            },
        )?;
        let mut matches = Vec::new();
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
            let text = data["lines"]["text"]
                .as_str()
                .ok_or_else(|| failed("tgrep returned non-text content"))?;
            matches.push(Match {
                path: path.to_path_buf(),
                line_number: data["line_number"]
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| failed("invalid tgrep line number"))?
                    as usize,
                content: text.strip_suffix('\n').unwrap_or(text).to_owned(),
            });
        }
        order(&mut matches);
        // Retain an extra row when merging changed files with indexed matches.
        let limit_hit = matches.len() > query.max_results;
        Ok(SearchResult {
            matches,
            limit_hit,
            indexed: false,
            index_stats: None,
        })
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
fn response_path(value: &Value) -> Result<PathBuf, Error> {
    value["file"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| failed("tgrep returned a missing path"))
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
fn exact_glob(path: &Path) -> Result<String, Error> {
    let mut glob = String::from("/");
    for c in portable(path)?.chars() {
        match c {
            '[' => glob.push_str("[[]"),
            ']' => glob.push_str("[]]"),
            '*' => glob.push_str("[*]"),
            '?' => glob.push_str("[?]"),
            '{' => glob.push_str("[{]"),
            '}' => glob.push_str("[}]"),
            '\\' => {
                return Err(failed(
                    "backslashes in filenames are unsupported by tgrep glob filters",
                ));
            }
            _ => glob.push(c),
        }
    }
    Ok(glob)
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

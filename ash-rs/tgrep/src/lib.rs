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

pub const VERSION: &str = "1.0.8";
const TIMEOUT: Duration = Duration::from_secs(30);
const LIMIT: usize = 100;

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
    pub include: Option<&'a str>,
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
        let root = std::fs::canonicalize(root)?;
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
        check(cancellation, deadline)?;
        if query.pattern.is_empty() || query.pattern.len() > 8192 {
            return Err(failed("search pattern must contain 1 to 8192 bytes"));
        }
        regex::Regex::new(query.pattern).map_err(|e| failed(e.to_string()))?;
        validate_relative(query.scope)?;
        let scope = self.root.join(query.scope);
        let canonical = std::fs::canonicalize(&scope)?;
        if !canonical.starts_with(&self.root) {
            return Err(failed("search scope escapes its workspace"));
        }
        let status = self.status(cancellation)?;
        // Single files and explicit glob overrides use tgrep's scanning semantics, including
        // ignored files deliberately included by the caller. Index readiness is never freshness.
        if scope.is_file()
            || !status.hidden_complete
            || query.include.is_some_and(|g| !g.starts_with('!'))
        {
            let mut result = self.scan(query, &[scope], cancellation, deadline)?;
            result.matches.truncate(LIMIT);
            return Ok(result);
        }
        let changed = self
            .changed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut globs: Vec<String> = query.include.into_iter().map(str::to_owned).collect();
        globs.extend(query.exclude.iter().map(|g| format!("!{g}")));
        // In 1.0.8 the external case-insensitive flag folds the trigram prefilter as ASCII,
        // losing Unicode equivalents such as K/K. Inline flags use the regex's Unicode-aware
        // extraction instead, preserving indexed queries and explicit (?-i) overrides.
        let pattern = if query.case_insensitive {
            format!("(?i){}", query.pattern)
        } else {
            query.pattern.to_owned()
        };
        let params = json!({"pattern":pattern,"case_insensitive":false,
            "scope":portable(query.scope)?,"glob":globs,"files_only":true,"detail":false,"positions":false});
        // One row per matching file bounds broad queries before asking for content. The server
        // has only a per-file max_count; it does not implement Ash's global 100-line limit.
        let files = self
            .process
            .rpc("search", params.clone(), cancellation, deadline)?;
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
            .filter(|p| self.admitted(p))
            .map(|p| self.root.join(p))
            .collect();
        if !dirty.is_empty() {
            matches.extend(self.scan(query, &dirty, cancellation, deadline)?.matches);
        }
        let paths: Vec<_> = paths.into_iter().collect();
        for chunk in paths.chunks(8) {
            check(cancellation, deadline)?;
            if matches.len() > LIMIT {
                order(&mut matches);
                if matches[LIMIT].path < chunk[0] {
                    break;
                }
            }
            let mut request = params.clone();
            request["files_only"] = json!(false);
            request["max_count"] = json!(LIMIT + 1);
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
            matches.truncate(LIMIT + 1);
        }
        order(&mut matches);
        let limit_hit = matches.len() > LIMIT;
        matches.truncate(LIMIT);
        Ok(SearchResult {
            matches,
            limit_hit,
            indexed: true,
        })
    }
    fn admitted(&self, relative: &Path) -> bool {
        if relative
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            return false;
        }
        let absolute = self.root.join(relative);
        if !absolute.is_file() {
            return false;
        }
        if !std::fs::canonicalize(&absolute).is_ok_and(|p| p.starts_with(&self.root)) {
            return false;
        }
        let target = absolute.clone();
        ignore::WalkBuilder::new(&self.root)
            .require_git(false)
            .filter_entry(move |entry| target.starts_with(entry.path()))
            .build()
            .filter_map(Result::ok)
            .any(|entry| entry.path() == absolute && entry.file_type().is_some_and(|t| t.is_file()))
    }
    fn validate_result_path(&self, path: &Path, scope: &Path) -> Result<(), Error> {
        validate_relative(path)?;
        if path.as_os_str().is_empty() || !path.starts_with(scope) {
            return Err(failed("tgrep returned an out-of-scope path"));
        }
        if let Ok(current) = std::fs::canonicalize(self.root.join(path)) {
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
        let mut command = std::process::Command::new(&self.executable.0);
        command.current_dir(&self.root).args([
            "--no-index",
            "--no-require-git",
            "--json",
            "--sort",
            "path",
            "--max-count",
            "101",
        ]);
        command.arg("--index-path").arg(self.process.index());
        if query.case_insensitive {
            command.arg("--ignore-case");
        }
        if let Some(glob) = query.include {
            command.arg("--glob").arg(glob);
        }
        for glob in query.exclude {
            command.arg("--glob").arg(format!("!{glob}"));
        }
        command.arg("--").arg(query.pattern).args(paths);
        let records = process::scan(command, cancellation, deadline)?;
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
        // Keep the 101st row for the caller merging changed files and indexed matches.
        let limit_hit = matches.len() > LIMIT;
        Ok(SearchResult {
            matches,
            limit_hit,
            indexed: false,
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

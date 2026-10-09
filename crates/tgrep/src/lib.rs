//! Process and protocol boundary for Ash's pinned tgrep runtime.

mod process;

use ash_async_utils::CancellationToken;
use ash_install_context::ExecutableCandidates;
use ash_install_context::InstallContext;
use ash_install_context::ManagedExecutable;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fmt;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

pub const VERSION: &str = "1.1.0-ash.b614b8c.4";
const TIMEOUT: Duration = Duration::from_secs(30);
const INDEX_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug)]
pub enum Error {
    Failed(String),
    /// A view was invalidated; reconcile before retrying within the same deadline.
    NotReady(String),
    Cancelled(String),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(message) | Self::NotReady(message) | Self::Cancelled(message) => {
                f.write_str(message)
            }
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
        Ok(self.identity(root, cancellation)?.directory)
    }
    fn identity(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> Result<DirectoryIdentity, Error> {
        let mut command = std::process::Command::new(&self.0);
        command.arg("identity").arg(root);
        let lines = process::capture(command, cancellation, Instant::now() + TIMEOUT, 1)?;
        serde_json::from_str(
            lines
                .first()
                .ok_or_else(|| failed("missing search identity"))?,
        )
        .map_err(Into::into)
    }
}

#[derive(Deserialize)]
struct DirectoryIdentity {
    directory: PathBuf,
    revision: Option<String>,
}
fn profile() -> Value {
    json!({"content":"raw-git-blob-auto-v1","coverage":"tracked-regular-files-v1","max_blob_bytes":67108864})
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
#[derive(Clone, Debug)]
pub struct Status {
    pub indexed_file_count: usize,
    pub indexing: bool,
    pub ready: bool,
    pub watcher_active: bool,
    pub files_ready: bool,
    pub file_count: usize,
}

/// A worktree registration in an owned shared search service.
/// Pending Ash writes are acknowledged by the engine before the next indexed search.
pub struct Session {
    executable: Executable,
    root: PathBuf,
    process: std::sync::Arc<process::Server>,
    registration: Registration,
    changed: Mutex<PendingChanges>,
    // The longer startup budget ends once this session observes published content.
    initial_content_ready: AtomicBool,
}

#[derive(Default)]
struct PendingChanges {
    revision: u64,
    content_ack: u64,
    files_ack: u64,
    paths: BTreeMap<PathBuf, u64>,
    path_bytes: usize,
    full_revision: u64,
}

enum Changes {
    None,
    Paths(Vec<PathBuf>),
    Full,
}

impl PendingChanges {
    const PATH_LIMIT: usize = 1024;
    // JSON escaping can expand one path byte sixfold. Leave ample room in the 1 MiB RPC.
    const BYTE_LIMIT: usize = 64 * 1024;

    fn record(&mut self, path: PathBuf, revision: u64) {
        if self.full_revision == revision {
            return;
        }
        if !self.paths.contains_key(&path) {
            self.path_bytes += path.as_os_str().as_encoded_bytes().len();
        }
        self.paths.insert(path, revision);
        if self.paths.len() > Self::PATH_LIMIT || self.path_bytes > Self::BYTE_LIMIT {
            // The full revision preserves discarded hints until both consumers acknowledge it.
            self.full_revision = revision;
            self.paths.clear();
            self.path_bytes = 0;
        }
    }

    fn since(&self, acknowledgement: u64) -> Changes {
        if self.full_revision > acknowledgement {
            return Changes::Full;
        }
        let paths: Vec<_> = self
            .paths
            .iter()
            .filter(|(_, revision)| **revision > acknowledgement)
            .map(|(path, _)| path.clone())
            .collect();
        if paths.is_empty() {
            Changes::None
        } else {
            Changes::Paths(paths)
        }
    }
    fn prune(&mut self) {
        let acknowledged = self.content_ack.min(self.files_ack);
        self.paths.retain(|_, revision| *revision > acknowledged);
        self.path_bytes = self
            .paths
            .keys()
            .map(|path| path.as_os_str().as_encoded_bytes().len())
            .sum();
        if self.full_revision <= acknowledged {
            self.full_revision = 0;
        }
    }
}

/// Bounded ranked paths returned by the engine without transferring its candidate catalog.
#[derive(Debug, Deserialize)]
pub struct FileSearchResult {
    pub matches: Vec<FileMatch>,
    pub total_match_count: usize,
    pub scanned_file_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct FileMatch {
    pub score: u32,
    pub path: PathBuf,
    pub indices: Vec<u32>,
}
enum Registration {
    Directory,
    Released,
    Shared {
        // Preserve the engine's canonical spelling, including Windows extended paths, on the wire.
        root: PathBuf,
        view: String,
        lease: String,
        generation: Value,
    },
}

struct PendingAttachment {
    process: std::sync::Arc<process::Server>,
    params: Option<Value>,
    lifetime: Option<Box<dyn Send>>,
}
impl Drop for PendingAttachment {
    fn drop(&mut self) {
        if let Some(params) = self.params.take() {
            let process = std::sync::Arc::clone(&self.process);
            let lifetime = self.lifetime.take();
            // Attach runs on the daemon's lifecycle worker even after its connection closes.
            // Replay the same token on that worker, then release it, keeping the owned daemon alive.
            std::thread::spawn(move || {
                let _lifetime = lifetime;
                let cancellation = ash_async_utils::CancellationSource::new();
                let deadline = Instant::now() + INDEX_TIMEOUT;
                let released = process.rpc("attach", params.clone(), &cancellation.token(), deadline)
                    .and_then(|result| process.rpc("detach", json!({"root":result["root"],"view":result["view"],"lease":params["lease"]}), &cancellation.token(), deadline));
                if released.is_err() {
                    // Unconfirmed cleanup must end the owned daemon's root reads before the
                    // caller's directory and storage can be released.
                    while process.stop().is_err() {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
            });
        }
    }
}

impl Session {
    pub fn open(
        executable: Executable,
        root: &Path,
        index: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        Self::open_with_lifetime(executable, root, index, cancellation, ())
    }

    /// Retains caller-owned resources until an interrupted registration finishes cleanup.
    /// Successful registration returns their ownership to the caller's containing session.
    pub fn open_with_lifetime(
        executable: Executable,
        root: &Path,
        index: &Path,
        cancellation: &CancellationToken,
        lifetime: impl Send + 'static,
    ) -> Result<Self, Error> {
        let root = dunce::canonicalize(root)?;
        let process = process::Server::shared(&executable, &root, index, cancellation)?;
        let deadline = Instant::now() + TIMEOUT;
        let registration = if process.is_shared() {
            let identity = executable.identity(&root, cancellation)?;
            static NEXT_LEASE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let number = NEXT_LEASE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| failed(e.to_string()))?
                .as_nanos();
            // Allocate the token before sending; it identifies this registration across retries.
            let lease = format!("{}-{time}-{number}", std::process::id());
            let params = json!({"root":root,"revision":identity.revision.ok_or_else(|| failed("worktree has no starting revision"))?,"profile":profile(),"lease":lease,"mode":"paths"});
            let mut pending = PendingAttachment {
                process: std::sync::Arc::clone(&process),
                params: Some(params.clone()),
                lifetime: Some(Box::new(lifetime)),
            };
            let result = process.rpc("attach", params, cancellation, deadline)?;
            let wire_root: PathBuf = serde_json::from_value(result["root"].clone())?;
            if dunce::simplified(&wire_root) != root
                || result["lease"] != lease
                || result["generation"]["profile"] != profile()
            {
                return Err(failed("invalid worktree registration"));
            }
            let view = result["view"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| failed("missing worktree view"))?
                .to_owned();
            pending.params = None;
            Registration::Shared {
                root: wire_root,
                view,
                lease,
                generation: result["generation"].clone(),
            }
        } else {
            Registration::Directory
        };
        let session = Self {
            executable,
            root,
            process,
            registration,
            changed: Mutex::new(PendingChanges::default()),
            initial_content_ready: AtomicBool::new(false),
        };
        Ok(session)
    }
    fn wait_ready(&self, cancellation: &CancellationToken, deadline: Instant) -> Result<(), Error> {
        loop {
            check(cancellation, deadline)?;
            if self.status(cancellation)?.ready {
                return Ok(());
            }
            // Ask the lifecycle worker to prepare content so permanent build failures are
            // returned to this caller instead of waiting on background retries until timeout.
            self.refresh(&[], cancellation, deadline)?;
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    /// Release after in-flight callers finish. A failed detach retains the lease for cleanup retries.
    pub fn close(&mut self, cancellation: &CancellationToken) -> Result<(), Error> {
        check(cancellation, Instant::now() + INDEX_TIMEOUT)?;
        if self.process.is_stopped()? {
            self.registration = Registration::Released;
            return Ok(());
        }
        if let Registration::Shared {
            root, view, lease, ..
        } = &self.registration
        {
            let result = self.process.rpc(
                "detach",
                json!({"root":root,"view":view,"lease":lease}),
                cancellation,
                Instant::now() + INDEX_TIMEOUT,
            );
            if !self.process.is_stopped()? {
                result?;
            }
        }
        self.registration = Registration::Released;
        Ok(())
    }
    pub fn status(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        let value = self.rpc("status", json!({}), cancellation, Instant::now() + TIMEOUT)?;
        let (indexing, ready, watcher_active) = match self.registration {
            Registration::Shared { .. } => (
                value["reconcile_running"]
                    .as_bool()
                    .ok_or_else(|| failed("invalid reconciliation status"))?,
                value["ready"]
                    .as_bool()
                    .ok_or_else(|| failed("invalid readiness status"))?,
                value["watch_mode"]
                    .as_str()
                    .ok_or_else(|| failed("invalid watcher status"))?
                    == "native",
            ),
            Registration::Released => return Err(failed("search registration was released")),
            Registration::Directory => (
                value["indexing"]
                    .as_bool()
                    .ok_or_else(|| failed("invalid indexing status"))?,
                value["hidden_complete"]
                    .as_bool()
                    .ok_or_else(|| failed("invalid coverage status"))?
                    && value["indexing"] == false,
                value["watcher_active"]
                    .as_bool()
                    .ok_or_else(|| failed("invalid watcher status"))?,
            ),
        };
        let status = Status {
            indexed_file_count: value["num_files"]
                .as_u64()
                .ok_or_else(|| failed("invalid file count"))?
                as usize,
            indexing,
            ready,
            watcher_active,
            files_ready: value["files_ready"]
                .as_bool()
                .ok_or_else(|| failed("invalid file readiness"))?,
            file_count: value["file_count"]
                .as_u64()
                .ok_or_else(|| failed("invalid file membership count"))?
                as usize,
        };
        if status.ready {
            self.initial_content_ready.store(true, Ordering::Relaxed);
        }
        Ok(status)
    }
    pub fn rebuild(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        let revision = self
            .changed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revision;
        self.refresh(&[], cancellation, Instant::now() + INDEX_TIMEOUT)?;
        {
            let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
            changed.content_ack = changed.content_ack.max(revision);
            changed.prune();
        }
        self.refresh_files(&[], cancellation, Instant::now() + TIMEOUT)?;
        {
            let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
            changed.files_ack = changed.files_ack.max(revision);
            changed.prune();
        }
        self.status(cancellation)
    }
    fn refresh(
        &self,
        changed: &[PathBuf],
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        match &self.registration {
            Registration::Shared {
                root, view, lease, ..
            } => {
                let paths = changed
                    .iter()
                    .map(|path| portable(path))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut method = "refresh";
                loop {
                    check(cancellation, deadline)?;
                    let result = self.process.rpc(method, json!({"root":root,"view":view,"lease":lease,"changed":paths,"full":paths.is_empty()}), cancellation, deadline);
                    match result {
                        Ok(value) => {
                            self.validate_view(&value)?;
                            if value["processed_epoch"].as_u64().is_none() {
                                return Err(failed("missing worktree refresh epoch"));
                            }
                            if value["ready"] == true {
                                break;
                            }
                        }
                        Err(Error::NotReady(_)) => method = "refresh/reconcile",
                        Err(error) => return Err(error),
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
            Registration::Released => return Err(failed("search registration was released")),
            Registration::Directory => {
                self.process
                    .rpc("reload", json!({}), cancellation, deadline)?;
            }
        }
        Ok(())
    }
    pub fn paths_changed(&self, paths: &[PathBuf]) {
        let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
        changed.revision = changed
            .revision
            .checked_add(1)
            .expect("path change revision exhausted");
        let revision = changed.revision;
        for path in paths {
            // Windows filesystem notifications and directory services may spell the same
            // absolute path with or without the extended prefix, including deleted files.
            let path = dunce::simplified(path);
            if let Ok(relative) = path.strip_prefix(&self.root) {
                if relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_)))
                {
                    changed.record(relative.to_path_buf(), revision);
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
        // Filename attachment does not wait for content. Indexed content callers retain the
        // existing initialization budget before starting their bounded query deadline.
        let deadline = if self.initial_content_ready.load(Ordering::Relaxed) {
            self.wait_ready(cancellation, deadline)?;
            deadline
        } else {
            self.wait_ready(cancellation, Instant::now() + INDEX_TIMEOUT)?;
            Instant::now() + TIMEOUT
        };
        let (revision, changes) = {
            let changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
            (changed.revision, changed.since(changed.content_ack))
        };
        match changes {
            Changes::None => {}
            Changes::Paths(paths) => self.refresh(&paths, cancellation, deadline)?,
            Changes::Full => self.refresh(&[], cancellation, deadline)?,
        }
        {
            // Writes arriving during I/O remain pending, even if this refresh happened to see them.
            let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
            changed.content_ack = changed.content_ack.max(revision);
            changed.prune();
        }
        let mut globs: Vec<String> = query.include.iter().map(|s| (*s).to_owned()).collect();
        globs.extend(query.exclude.iter().map(|g| format!("!{g}")));
        let params = json!({
            "pattern":query.pattern,"case_insensitive":query.case_insensitive,
            "scope":portable(query.scope)?,"glob":globs,"files_only":false,
            "max_count":limit+1,"max_results":limit+1,"detail":false,"positions":false,"stats":true
        });
        let result = loop {
            check(cancellation, deadline)?;
            if !self.status(cancellation)?.ready {
                self.refresh(&[], cancellation, deadline)?;
            }
            match self.rpc("search", params.clone(), cancellation, deadline) {
                Ok(value) => break value,
                Err(Error::NotReady(_)) => {
                    self.refresh(&[], cancellation, deadline)?;
                }
                Err(error) => return Err(error),
            }
        };
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

    fn refresh_files(
        &self,
        paths: &[PathBuf],
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        loop {
            check(cancellation, deadline)?;
            let params = match &self.registration {
                Registration::Shared {
                    root, view, lease, ..
                } => {
                    json!({"root":root,"view":view,"lease":lease,"changed":paths})
                }
                Registration::Directory => json!({"changed":paths}),
                Registration::Released => return Err(failed("search registration was released")),
            };
            match self
                .process
                .rpc("files/refresh", params, cancellation, deadline)
            {
                Ok(value) => {
                    if self.process.is_shared() {
                        self.validate_view(&value)?;
                    }
                    if value["files_ready"] != true || value["processed_epoch"].as_u64().is_none() {
                        return Err(failed("invalid filename refresh acknowledgement"));
                    }
                    return Ok(());
                }
                Err(Error::NotReady(_)) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => return Err(error),
            }
        }
    }

    fn synchronize_files(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        let (revision, changes) = {
            let changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
            (changed.revision, changed.since(changed.files_ack))
        };
        match changes {
            Changes::None => {}
            Changes::Paths(paths) => self.refresh_files(&paths, cancellation, deadline)?,
            Changes::Full => self.refresh_files(&[], cancellation, deadline)?,
        }
        {
            let mut changed = self.changed.lock().unwrap_or_else(|e| e.into_inner());
            changed.files_ack = changed.files_ack.max(revision);
            changed.prune();
        }
        Ok(())
    }

    /// Scores the engine-owned catalog, retaining only the requested best paths on the wire.
    pub fn file_fuzzy(
        &self,
        query: &str,
        max_results: usize,
        cancellation: &CancellationToken,
    ) -> Result<FileSearchResult, Error> {
        if query.len() > 1024 || query.contains('\0') || !(1..=5000).contains(&max_results) {
            return Err(failed("invalid fuzzy file query or limit"));
        }
        let deadline = Instant::now() + TIMEOUT;
        self.synchronize_files(cancellation, deadline)?;
        let value = loop {
            check(cancellation, deadline)?;
            match self.rpc(
                "files/fuzzy",
                json!({"query":query,"max_results":max_results}),
                cancellation,
                deadline,
            ) {
                Ok(value) => break value,
                Err(Error::NotReady(_)) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => return Err(error),
            }
        };
        let found: FileSearchResult = serde_json::from_value(value)?;
        if found.matches.len() > max_results
            || found.matches.len() > found.total_match_count
            || found.total_match_count > found.scanned_file_count
        {
            return Err(failed("invalid fuzzy file result counts"));
        }
        for matched in &found.matches {
            validate_relative(&matched.path)?;
            let path = matched
                .path
                .to_str()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| failed("invalid fuzzy file path"))?;
            if matched.indices.windows(2).any(|pair| pair[0] >= pair[1])
                || matched
                    .indices
                    .last()
                    .is_some_and(|index| *index as usize >= path.chars().count())
            {
                return Err(failed("invalid fuzzy file highlights"));
            }
        }
        Ok(found)
    }

    fn rpc(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        match &self.registration {
            Registration::Released => Err(failed("search registration was released")),
            Registration::Directory => self.process.rpc(method, params, cancellation, deadline),
            Registration::Shared { root, view, .. } => {
                let value = self.process.rpc(
                    method,
                    json!({"root":root,"view":view,"query":params}),
                    cancellation,
                    deadline,
                )?;
                self.validate_view(&value)?;
                let readiness = if matches!(method, "files/page" | "files/fuzzy") {
                    "files_ready"
                } else {
                    "ready"
                };
                if method != "status"
                    && (value[readiness] != true || value["epoch"].as_u64().is_none())
                {
                    return Err(failed("worktree query is not ready"));
                }
                Ok(value)
            }
        }
    }
    fn validate_view(&self, value: &Value) -> Result<(), Error> {
        if let Registration::Shared {
            root,
            view,
            generation,
            ..
        } = &self.registration
            && (value["root"] != json!(root)
                || value["view"] != *view
                || value["generation"] != *generation)
        {
            return Err(failed("worktree response identity changed"));
        }
        Ok(())
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
        if let Registration::Shared {
            root, view, lease, ..
        } = &self.registration
        {
            let cancellation = ash_async_utils::CancellationSource::new();
            let _ = self.process.rpc(
                "detach",
                json!({"root":root,"view":view,"lease":lease}),
                &cancellation.token(),
                Instant::now() + Duration::from_secs(1),
            );
        }
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

#[cfg(test)]
mod file_catalog_test_support;

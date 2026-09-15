use crate::{
    ContentSearchCaseSensitivity, ContentSearchError, ContentSearchMatch, ContentSearchMatchRange,
    ContentSearchOwner, ContentSearchPage, ContentSearchPattern, ContentSearchQuery,
};
use ash_async_utils::CancellationSource;
use ash_file_access::{Authorization, Dir, Permission};
use ash_shell_command::RipgrepExecutable;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

const MAX_ACTIVE_SEARCHES: usize = 32;
const SEARCH_RETENTION: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_ERROR_BYTES: u64 = 64 * 1024;
const MAX_GLOB_BYTES: usize = 1024;

/// Runs bounded background content searches rooted at one dir.
///
/// The caller supplies a [`ContentSearchOwner`] for each operation. A job can only be read or cancelled
/// by the owner that started it, while the host remains free to map that identity to a connection,
/// session, or other caller boundary.
pub struct ContentSearchService {
    dir: RwLock<Dir>,
    authorization: RwLock<Option<Authorization>>,
    ripgrep: RipgrepExecutable,
    next_search_id: AtomicU64,
    jobs: Mutex<HashMap<String, ContentSearchJob>>,
}

impl ContentSearchService {
    /// Creates a search service with a host-selected dir root and frozen ripgrep executable.
    pub fn new(dir: Dir, ripgrep: RipgrepExecutable) -> Self {
        Self {
            dir: RwLock::new(dir),
            authorization: RwLock::new(None),
            ripgrep,
            next_search_id: AtomicU64::new(1),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// Creates a search service whose running jobs stop when the host revokes the dir.
    pub fn new_authorized(
        dir: Authorization,
        ripgrep: RipgrepExecutable,
    ) -> Result<Self, ContentSearchError> {
        dir.ensure_active()
            .map_err(|_| ContentSearchError::Unavailable)?;
        if dir.permission() != Permission::SearchFiles {
            return Err(ContentSearchError::InvalidInput);
        }
        Ok(Self {
            dir: RwLock::new(dir.dir().clone()),
            authorization: RwLock::new(Some(dir)),
            ripgrep,
            next_search_id: AtomicU64::new(1),
            jobs: Mutex::new(HashMap::new()),
        })
    }

    /// Selects the dir used by searches started after this call.
    ///
    /// Running jobs retain the root captured at start time.
    pub fn set_dir(&self, dir: Dir) {
        *self
            .dir
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = dir;
        *self
            .authorization
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Starts a query and returns its opaque search ID.
    pub fn start(
        &self,
        owner: ContentSearchOwner,
        query: ContentSearchQuery,
    ) -> Result<String, ContentSearchError> {
        validate_query(&query)?;
        let authorization = self
            .authorization
            .read()
            .map_err(|_| ContentSearchError::Busy)?
            .clone();
        if authorization
            .as_ref()
            .is_some_and(|dir| dir.ensure_active().is_err())
        {
            return Err(ContentSearchError::Unavailable);
        }
        let mut jobs = self.jobs.lock().map_err(|_| ContentSearchError::Busy)?;
        cleanup_jobs(&mut jobs);
        if jobs.len() >= MAX_ACTIVE_SEARCHES {
            return Err(ContentSearchError::Busy);
        }

        let search_id = format!(
            "search-{:x}",
            self.next_search_id.fetch_add(1, Ordering::Relaxed)
        );
        let cancellation = CancellationSource::new();
        let state = Arc::new(Mutex::new(ContentSearchJobState::default()));
        jobs.insert(
            search_id.clone(),
            ContentSearchJob {
                owner,
                cancellation: cancellation.clone(),
                state: state.clone(),
                created_at: Instant::now(),
            },
        );
        let dir = self
            .dir
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let ripgrep = self.ripgrep.clone();
        thread::spawn(move || run_search(dir, authorization, ripgrep, query, cancellation, state));
        Ok(search_id)
    }

    /// Reads at most `max_matches` entries after `after_match` for one owner-bound job.
    pub fn read(
        &self,
        owner: ContentSearchOwner,
        search_id: &str,
        after_match: usize,
        max_matches: usize,
    ) -> Result<ContentSearchPage, ContentSearchError> {
        if max_matches == 0 || max_matches > 200 {
            return Err(ContentSearchError::InvalidInput);
        }
        let mut jobs = self.jobs.lock().map_err(|_| ContentSearchError::Busy)?;
        cleanup_jobs(&mut jobs);
        let job = jobs.get(search_id).ok_or(ContentSearchError::NotFound)?;
        if job.owner != owner {
            return Err(ContentSearchError::NotOwner);
        }
        let state = job.state.lock().map_err(|_| ContentSearchError::Busy)?;
        if after_match > state.matches.len() {
            return Err(ContentSearchError::InvalidInput);
        }
        let end = after_match
            .saturating_add(max_matches)
            .min(state.matches.len());
        Ok(ContentSearchPage {
            matches: state.matches[after_match..end].to_vec(),
            next_match: end,
            completed: state.completed,
            limit_hit: state.limit_hit,
            error: state.error.clone(),
        })
    }

    /// Cancels and releases one owner-bound job.
    pub fn cancel(
        &self,
        owner: ContentSearchOwner,
        search_id: &str,
    ) -> Result<(), ContentSearchError> {
        let mut jobs = self.jobs.lock().map_err(|_| ContentSearchError::Busy)?;
        cleanup_jobs(&mut jobs);
        let job = jobs.get(search_id).ok_or(ContentSearchError::NotFound)?;
        if job.owner != owner {
            return Err(ContentSearchError::NotOwner);
        }
        let job = jobs
            .remove(search_id)
            .expect("search job existed immediately before removal");
        job.cancellation.cancel();
        Ok(())
    }

    /// Cancels and releases every active job, for example when its dir is retired.
    pub fn cancel_all(&self) {
        let Ok(mut jobs) = self.jobs.lock() else {
            return;
        };
        for (_, job) in jobs.drain() {
            job.cancellation.cancel();
        }
    }
}

struct ContentSearchJob {
    owner: ContentSearchOwner,
    cancellation: CancellationSource,
    state: Arc<Mutex<ContentSearchJobState>>,
    created_at: Instant,
}

impl ContentSearchJob {
    fn is_expired(&self, now: Instant) -> bool {
        let completed = self.state.lock().map_or(true, |state| state.completed);
        completed && now.duration_since(self.created_at) >= SEARCH_RETENTION
    }
}

#[derive(Default)]
struct ContentSearchJobState {
    matches: Vec<ContentSearchMatch>,
    completed: bool,
    limit_hit: bool,
    error: Option<String>,
}

fn cleanup_jobs(jobs: &mut HashMap<String, ContentSearchJob>) {
    let now = Instant::now();
    jobs.retain(|_, job| !job.is_expired(now));
}

fn validate_query(query: &ContentSearchQuery) -> Result<(), ContentSearchError> {
    if query.query.is_empty()
        || query.query.len() > 16_384
        || query.query.contains('\0')
        || query.max_results == 0
        || query.max_results > 5_000
        || query.include_patterns.len() > 64
        || query.exclude_patterns.len() > 64
    {
        return Err(ContentSearchError::InvalidInput);
    }
    query
        .include_patterns
        .iter()
        .chain(&query.exclude_patterns)
        .try_for_each(|pattern| validate_glob(pattern))
}

fn validate_glob(pattern: &str) -> Result<(), ContentSearchError> {
    let normalized = pattern.replace('\\', "/");
    if pattern.is_empty()
        || pattern.len() > MAX_GLOB_BYTES
        || pattern.contains('\0')
        || pattern.starts_with('!')
        || normalized.starts_with('/')
        || normalized.split('/').any(|component| component == "..")
        || normalized
            .get(1..3)
            .is_some_and(|prefix| prefix.starts_with(":/"))
    {
        return Err(ContentSearchError::InvalidInput);
    }
    Ok(())
}

fn run_search(
    dir: Dir,
    authorization: Option<Authorization>,
    ripgrep: RipgrepExecutable,
    query: ContentSearchQuery,
    cancellation: CancellationSource,
    state: Arc<Mutex<ContentSearchJobState>>,
) {
    let mut command = Command::new(ripgrep.path());
    command
        .current_dir(dir.canonical_path())
        .args(search_arguments(&query))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            complete_with_error(&state, "Unable to start dir search.");
            return;
        }
    };
    let stdout = child.stdout.take().expect("dir search stdout was piped");
    let stderr = child.stderr.take().expect("dir search stderr was piped");
    let parser_state = state.clone();
    let parser_cancellation = cancellation.clone();
    let max_results = query.max_results;
    let stdout_reader = thread::spawn(move || {
        parse_stdout(stdout, max_results, &parser_cancellation, &parser_state)
    });
    let stderr_reader = thread::spawn(move || read_bounded_error(stderr));
    let token = cancellation.token();
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if token.is_cancelled() {
            cancelled = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        if authorization
            .as_ref()
            .is_some_and(|dir| dir.ensure_active().is_err())
        {
            cancelled = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(POLL_INTERVAL);
    };
    let parser_result = stdout_reader
        .join()
        .unwrap_or_else(|_| Err("Directory search parser stopped unexpectedly.".into()));
    let _stderr = stderr_reader.join().unwrap_or_default();
    if let Err(message) = parser_result {
        set_error(&state, message);
    } else if !cancelled && !status.is_some_and(|status| matches!(status.code(), Some(0 | 1))) {
        set_error(&state, "Directory search failed.".into());
    }
    if let Ok(mut state) = state.lock() {
        state.completed = true;
    }
}

fn search_arguments(query: &ContentSearchQuery) -> Vec<String> {
    let mut arguments = vec![
        "--no-config".into(),
        "--json".into(),
        "--line-number".into(),
        "--color=never".into(),
        "--no-messages".into(),
        "--max-columns=1000".into(),
        "--max-columns-preview".into(),
        "--max-filesize=16M".into(),
    ];
    match query.pattern {
        ContentSearchPattern::Literal => arguments.push("--fixed-strings".into()),
        ContentSearchPattern::Regex => {}
    }
    arguments.push(
        match query.case_sensitivity {
            ContentSearchCaseSensitivity::Smart => "--smart-case",
            ContentSearchCaseSensitivity::Sensitive => "--case-sensitive",
            ContentSearchCaseSensitivity::Insensitive => "--ignore-case",
        }
        .into(),
    );
    for pattern in &query.include_patterns {
        arguments.extend(["-g".into(), pattern.clone()]);
    }
    for pattern in &query.exclude_patterns {
        arguments.extend(["-g".into(), format!("!{pattern}")]);
    }
    arguments.extend(["--".into(), query.query.clone(), ".".into()]);
    arguments
}

fn parse_stdout(
    stdout: impl Read,
    max_results: usize,
    cancellation: &CancellationSource,
    state: &Arc<Mutex<ContentSearchJobState>>,
) -> Result<(), String> {
    for line in BufReader::new(stdout).lines() {
        if cancellation.token().is_cancelled() {
            return Ok(());
        }
        let line = line.map_err(|_| "Unable to read dir search output.".to_owned())?;
        let Some(search_match) = parse_match(&line)? else {
            continue;
        };
        let mut job = state
            .lock()
            .map_err(|_| "Directory search result state is unavailable.".to_owned())?;
        if job.matches.len() == max_results {
            job.limit_hit = true;
            drop(job);
            cancellation.cancel();
            return Ok(());
        }
        job.matches.push(search_match);
    }
    Ok(())
}

fn parse_match(line: &str) -> Result<Option<ContentSearchMatch>, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| "Directory search returned invalid JSON.".to_owned())?;
    if value.get("type").and_then(Value::as_str) != Some("match") {
        return Ok(None);
    }
    let data = value
        .get("data")
        .ok_or_else(|| "Directory search match omitted its data.".to_owned())?;
    let path = data
        .pointer("/path/text")
        .and_then(Value::as_str)
        .ok_or_else(|| "Directory search returned a non-UTF-8 path.".to_owned())?
        .trim_start_matches("./")
        .replace('\\', "/");
    let line_number = data
        .get("line_number")
        .and_then(Value::as_u64)
        .and_then(|line| usize::try_from(line).ok())
        .ok_or_else(|| "Directory search match omitted its line number.".to_owned())?;
    let preview = data
        .pointer("/lines/text")
        .and_then(Value::as_str)
        .ok_or_else(|| "Directory search returned a non-UTF-8 preview.".to_owned())?
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    let ranges = data
        .get("submatches")
        .and_then(Value::as_array)
        .ok_or_else(|| "Directory search match omitted its ranges.".to_owned())?
        .iter()
        .filter_map(|range| {
            let start = usize::try_from(range.get("start")?.as_u64()?).ok()?;
            let end = usize::try_from(range.get("end")?.as_u64()?).ok()?;
            Some(ContentSearchMatchRange {
                start: byte_offset_to_utf16(&preview, start)?,
                end: byte_offset_to_utf16(&preview, end)?,
            })
        })
        .collect::<Vec<_>>();
    if ranges.is_empty() {
        return Ok(None);
    }
    Ok(Some(ContentSearchMatch {
        path: Path::new(&path).to_path_buf(),
        line_number,
        preview,
        ranges,
    }))
}

fn byte_offset_to_utf16(text: &str, offset: usize) -> Option<usize> {
    text.is_char_boundary(offset)
        .then(|| text[..offset].encode_utf16().count())
}

fn read_bounded_error(mut stderr: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = stderr
        .by_ref()
        .take(MAX_ERROR_BYTES)
        .read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn complete_with_error(state: &Arc<Mutex<ContentSearchJobState>>, message: &str) {
    if let Ok(mut state) = state.lock() {
        state.error = Some(message.into());
        state.completed = true;
    }
}

fn set_error(state: &Arc<Mutex<ContentSearchJobState>>, message: String) {
    if let Ok(mut state) = state.lock()
        && state.error.is_none()
    {
        state.error = Some(message);
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

//! Incremental fuzzy directory-file search.

mod discovery;
mod ranking;

use ash_async_utils::CancellationToken;
use ignore::WalkBuilder;
use nucleo::Config;
use nucleo::Injector;
use nucleo::Matcher;
use nucleo::Nucleo;
use nucleo::Utf32String;
use nucleo::pattern::CaseMatching;
use nucleo::pattern::Normalization;
use std::fmt;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const MATCH_TICK: Duration = Duration::from_millis(10);
const IDLE_WAIT: Duration = Duration::from_millis(100);

pub use ranking::PathMatch;

/// An incremental snapshot produced for the most recently processed query.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PathSearchSnapshot {
    /// Monotonic identity assigned when the search handle receives a query update.
    pub query_revision: u64,
    /// Query text used to produce this snapshot.
    pub query: String,
    /// Highest-scoring matches, bounded by [`PathSearchOptions`].
    pub matches: Vec<PathMatch>,
    /// Number of candidates matching the query before the result limit.
    pub total_match_count: usize,
    /// Number of ordinary UTF-8 file paths injected by the walker.
    pub scanned_file_count: usize,
    /// Whether the directory walker has finished.
    pub scan_complete: bool,
    /// Whether both walking and matching are idle for this query revision.
    pub search_complete: bool,
}

/// Result and worker settings for an incremental path-search operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathSearchOptions {
    result_limit: NonZeroUsize,
    worker_threads: NonZeroUsize,
}

impl PathSearchOptions {
    /// Sets the maximum number of matches included in each snapshot.
    pub fn with_result_limit(mut self, result_limit: NonZeroUsize) -> Self {
        self.result_limit = result_limit;
        self
    }

    /// Sets both the directory-walker and Nucleo worker counts.
    pub fn with_worker_threads(mut self, worker_threads: NonZeroUsize) -> Self {
        self.worker_threads = worker_threads;
        self
    }
}

impl Default for PathSearchOptions {
    fn default() -> Self {
        Self {
            result_limit: NonZeroUsize::new(50).expect("50 is non-zero"),
            worker_threads: NonZeroUsize::new(2).expect("2 is non-zero"),
        }
    }
}

/// Handle owning one background file walker and one incremental Nucleo matcher.
///
/// Callers keep the returned snapshot receiver, call [`Self::update_query`] as
/// the editable token changes, and drop the handle to stop both workers.
pub struct PathSearchHandle {
    inner: Arc<SearchInner>,
}

impl fmt::Debug for PathSearchHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PathSearchHandle")
            .field("root", &self.inner.root)
            .finish_non_exhaustive()
    }
}

/// Public current-disk path queries and incremental search handles.
#[derive(Debug, Default)]
pub struct Service;

impl Service {
    /// Discovers and ranks current disk paths within the caller's authorization lifetime.
    pub fn fuzzy(
        &self,
        root: PathBuf,
        query: &str,
        max_results: usize,
        cancellation: &CancellationToken,
    ) -> Result<PathSearchSnapshot, Error> {
        if query.len() > 1024 || query.contains('\0') || !(1..=5000).contains(&max_results) {
            return Err(Error::InvalidInput(
                "invalid fuzzy file query or limit".into(),
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        let check = || {
            cancellation
                .check()
                .map_err(|reason| Error::Cancelled(reason.reason().to_string()))?;
            if Instant::now() >= deadline {
                return Err(Error::Failed("file search exceeded 30 seconds".into()));
            }
            Ok(())
        };
        check()?;
        if !root
            .metadata()
            .map_err(|error| Error::Failed(error.to_string()))?
            .is_dir()
        {
            return Err(Error::Failed("path-search root must be a directory".into()));
        }
        let walker_cancellation = cancellation.clone();
        let mut builder = path_walker(&root, 1);
        // Observe cancellation on ignored entries too, before a filtered iterator can advance.
        builder.filter_entry(move |entry| {
            !walker_cancellation.is_cancelled()
                && Instant::now() < deadline
                && admitted_entry(entry)
        });
        let paths = builder.build().filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return None;
            }
            let relative = entry.path().strip_prefix(&root).ok()?;
            relative.to_str()?;
            Some(Ok(relative.to_path_buf()))
        });
        let ranked = ranking::rank(paths, query, max_results, check)?;
        Ok(PathSearchSnapshot {
            query: query.to_owned(),
            matches: ranked.matches,
            total_match_count: ranked.total_match_count,
            scanned_file_count: ranked.scanned_file_count,
            scan_complete: true,
            search_complete: true,
            ..PathSearchSnapshot::default()
        })
    }

    /// Starts a background path search rooted at an existing directory.
    pub fn start(
        &self,
        root: PathBuf,
        options: PathSearchOptions,
    ) -> std::io::Result<(PathSearchHandle, Receiver<PathSearchSnapshot>)> {
        if !root.metadata()?.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path-search root must be a directory",
            ));
        }

        let (work_tx, work_rx) = mpsc::channel();
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let notify_tx = work_tx.clone();
        let notify = Arc::new(move || {
            let _ = notify_tx.send(WorkSignal::NucleoChanged);
        });
        let nucleo = Nucleo::new(
            Config::DEFAULT.match_paths(),
            notify,
            Some(options.worker_threads.get()),
            1,
        );
        let injector = nucleo.injector();
        let inner = Arc::new(SearchInner {
            root,
            result_limit: options.result_limit.get(),
            worker_threads: options.worker_threads.get(),
            shutdown: AtomicBool::new(false),
            next_query_revision: AtomicU64::new(0),
            scanned_file_count: AtomicUsize::new(0),
            work_tx,
        });

        let matcher_inner = Arc::clone(&inner);
        thread::spawn(move || matcher_worker(matcher_inner, work_rx, snapshot_tx, nucleo));
        let walker_inner = Arc::clone(&inner);
        thread::spawn(move || walker_worker(walker_inner, injector));

        Ok((PathSearchHandle { inner }, snapshot_rx))
    }
}

impl PathSearchHandle {
    /// Replaces the active fuzzy pattern without restarting the directory walk.
    ///
    /// The returned revision is copied into every snapshot produced for this
    /// update and lets consumers reject stale results even when query text is
    /// repeated.
    pub fn update_query(&self, query: &str) -> u64 {
        let query_revision = self
            .inner
            .next_query_revision
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let _ = self.inner.work_tx.send(WorkSignal::QueryChanged {
            query_revision,
            query: query.to_owned(),
        });
        query_revision
    }
}

impl Drop for PathSearchHandle {
    fn drop(&mut self) {
        // Workers retain the shared state until they observe shutdown; dropping a picker never blocks its UI.
        self.inner.shutdown.store(true, Ordering::Relaxed);
        let _ = self.inner.work_tx.send(WorkSignal::Shutdown);
    }
}

struct SearchInner {
    root: PathBuf,
    result_limit: usize,
    worker_threads: usize,
    shutdown: AtomicBool,
    next_query_revision: AtomicU64,
    scanned_file_count: AtomicUsize,
    work_tx: Sender<WorkSignal>,
}

enum WorkSignal {
    QueryChanged { query_revision: u64, query: String },
    NucleoChanged,
    WalkComplete,
    Shutdown,
}

fn admitted_entry(entry: &ignore::DirEntry) -> bool {
    entry.depth() == 0
        || !entry.file_type().is_some_and(|kind| kind.is_dir())
        || !entry
            .file_name()
            .to_str()
            .is_some_and(|name| discovery::EXCLUDED_DIRECTORIES.contains(&name))
}

fn path_walker(root: &Path, worker_threads: usize) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .threads(worker_threads)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .filter_entry(admitted_entry);
    builder
}

fn walker_worker(inner: Arc<SearchInner>, injector: Injector<Arc<str>>) {
    let builder = path_walker(&inner.root, inner.worker_threads);
    let walker = builder.build_parallel();

    walker.run(|| {
        let inner = Arc::clone(&inner);
        let injector = injector.clone();
        Box::new(move |entry| {
            if inner.shutdown.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return ignore::WalkState::Continue;
            }
            let Ok(relative) = entry.path().strip_prefix(&inner.root) else {
                return ignore::WalkState::Continue;
            };
            let Some(relative) = relative.to_str() else {
                return ignore::WalkState::Continue;
            };
            let relative = relative.replace(std::path::MAIN_SEPARATOR, "/");
            injector.push(Arc::from(relative.as_str()), |_, columns| {
                columns[0] = Utf32String::from(relative.as_str());
            });
            inner.scanned_file_count.fetch_add(1, Ordering::Relaxed);
            ignore::WalkState::Continue
        })
    });
    let _ = inner.work_tx.send(WorkSignal::WalkComplete);
}

fn matcher_worker(
    inner: Arc<SearchInner>,
    work_rx: Receiver<WorkSignal>,
    snapshot_tx: Sender<PathSearchSnapshot>,
    mut nucleo: Nucleo<Arc<str>>,
) {
    let config = Config::DEFAULT.match_paths();
    let mut indices_matcher = Matcher::new(config);
    let mut query_revision = 0;
    let mut query = String::new();
    let mut scan_complete = false;
    let mut ticking = false;
    let mut force_snapshot = false;
    let mut completion_reported = false;

    loop {
        let wait = if ticking { MATCH_TICK } else { IDLE_WAIT };
        match work_rx.recv_timeout(wait) {
            Ok(WorkSignal::QueryChanged {
                query_revision: next_revision,
                query: next_query,
            }) => {
                let append = next_query.starts_with(&query);
                nucleo.pattern.reparse(
                    0,
                    &next_query,
                    CaseMatching::Ignore,
                    Normalization::Smart,
                    append,
                );
                query_revision = next_revision;
                query = next_query;
                ticking = true;
                force_snapshot = true;
                completion_reported = false;
            }
            Ok(WorkSignal::NucleoChanged) => ticking = true,
            Ok(WorkSignal::WalkComplete) => {
                scan_complete = true;
                ticking = true;
                force_snapshot = true;
            }
            Ok(WorkSignal::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if inner.shutdown.load(Ordering::Relaxed) {
            break;
        }
        if !ticking {
            continue;
        }

        let status = nucleo.tick(MATCH_TICK.as_millis() as u64);
        let search_complete = scan_complete && !status.running;
        if status.changed || force_snapshot || (search_complete && !completion_reported) {
            let snapshot = build_snapshot(
                &inner,
                &nucleo,
                &mut indices_matcher,
                query_revision,
                &query,
                scan_complete,
                search_complete,
            );
            if snapshot_tx.send(snapshot).is_err() {
                break;
            }
        }
        force_snapshot = false;
        completion_reported = search_complete;
        ticking = status.running;
    }
}

fn build_snapshot(
    inner: &SearchInner,
    nucleo: &Nucleo<Arc<str>>,
    indices_matcher: &mut Matcher,
    query_revision: u64,
    query: &str,
    scan_complete: bool,
    search_complete: bool,
) -> PathSearchSnapshot {
    let snapshot = nucleo.snapshot();
    let pattern = snapshot.pattern().column_pattern(0);
    let mut best = ranking::TopMatches::new(inner.result_limit);
    for matched in snapshot.matches() {
        if inner.shutdown.load(Ordering::Relaxed) {
            break;
        }
        if let Some(item) = snapshot.get_item(matched.idx) {
            best.push(matched.score, Path::new(item.data.as_ref()));
        }
    }
    let matches = best
        .into_sorted()
        .into_iter()
        .map(|(score, path)| {
            let text = Utf32String::from(path.to_str().expect("walker admits UTF-8 paths"));
            let mut indices = Vec::new();
            let _ = pattern.indices(text.slice(..), indices_matcher, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            PathMatch {
                score,
                path,
                indices,
            }
        })
        .collect();
    PathSearchSnapshot {
        query_revision,
        query: query.to_owned(),
        matches,
        total_match_count: snapshot.matched_item_count() as usize,
        scanned_file_count: inner.scanned_file_count.load(Ordering::Relaxed),
        scan_complete,
        search_complete,
    }
}

#[cfg(test)]
#[path = "file_search_tests.rs"]
mod tests;

#[cfg(test)]
mod ranking_tests;

mod glob;
pub use glob::Error;
pub use glob::GlobQuery;
pub use glob::GlobResult;

use crate::Error;
use crate::Query;
use crate::SearchResult;
use crate::ripgrep;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use ash_shell_command::RipgrepExecutable;
use cap_std::fs::OpenOptions;
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use grep_printer::JSON;
use grep_regex::RegexMatcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::BinaryDetection;
use grep_searcher::Searcher;
use grep_searcher::SearcherBuilder;
use ignore::Walk;
use ignore::WalkBuilder;
use ignore::WalkState;
use ignore::overrides::OverrideBuilder;
use std::collections::VecDeque;
use std::io;
use std::io::Cursor;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

const MAX_WORKERS: usize = 8;
const FILES_PER_BATCH: usize = 32;
const PREFIX_FILES: usize = FILES_PER_BATCH * MAX_WORKERS;
const MAX_PARALLEL_PATHS: usize = 16_384;
const MAX_PARALLEL_PATH_BYTES: usize = 8 * 1024 * 1024;
const OUTPUT_CHUNK: usize = 16 * 1024;
static EXTRA_WORKERS: AtomicUsize = AtomicUsize::new(0);

pub(super) fn search(
    executable: &RipgrepExecutable,
    dir: &Dir,
    query: &Query,
    pattern: &str,
    cancellation: &CancellationToken,
) -> Result<SearchResult, Error> {
    let workers = WorkerSlots::reserve();
    if workers.0 == 0 {
        // Under concurrent load, use the single-threaded engine instead of adding workers.
        return ripgrep::search(executable, dir, query, pattern, cancellation);
    }
    scan(dir, query, pattern, cancellation, workers.0)
}

fn scan(
    dir: &Dir,
    query: &Query,
    pattern: &str,
    cancellation: &CancellationToken,
    workers: usize,
) -> Result<SearchResult, Error> {
    let deadline = Instant::now() + ripgrep::TIMEOUT;
    let stop = AtomicBool::new(false);
    let control = Control {
        cancellation,
        deadline,
        stop: &stop,
    };
    control.check()?;
    dir.directory().ensure_current().map_err(failed)?;
    let mut overrides = OverrideBuilder::new(dir.canonical_path());
    for glob in ripgrep::globs(query) {
        overrides.add(&glob).map_err(failed)?;
    }
    let scope = dir.canonical_path().join(&query.scope);
    let mut walker = WalkBuilder::new(scope);
    walker
        .current_dir(dir.canonical_path())
        .require_git(false)
        .add_custom_ignore_filename(".rgignore")
        .max_filesize(Some(ripgrep::MAX_FILE_BYTES))
        .overrides(overrides.build().map_err(failed)?)
        .sort_by_file_name(|a, b| a.cmp(b));
    let walk = walker.build();
    walker.threads(workers);
    let matcher = RegexMatcherBuilder::new()
        .multi_line(true)
        .ban_byte(Some(0))
        .build(pattern)
        .map_err(failed)?;
    let searcher = SearcherBuilder::new()
        .line_number(true)
        .multi_line(true)
        .binary_detection(BinaryDetection::quit(0))
        .build();

    let result = thread::scope(|threads| {
        let mut stream = OrderedOutput {
            walk,
            parallel_tail: Some(walker),
            tail_paths: None,
            last_path: None,
            prefix_remaining: PREFIX_FILES,
            control,
            senders: VecDeque::new(),
            pending: VecDeque::new(),
            output: Cursor::default(),
            exhausted: false,
            error: None,
        };
        for _ in 0..workers {
            let (send, receive) = mpsc::sync_channel::<Batch>(0);
            let mut scanner = Scanner {
                dir,
                options: file_options(),
                #[cfg(windows)]
                parent: None,
                matcher: matcher.clone(),
                searcher: searcher.clone(),
                control,
            };
            thread::Builder::new()
                .name("grep-scan".into())
                .spawn_scoped(threads, move || {
                    while let Ok(batch) = receive.recv() {
                        if scanner.scan_batch(batch).is_err() {
                            break;
                        }
                    }
                })?;
            stream.senders.push_back(send);
        }
        ripgrep::parse(&mut stream, query.max_results)
    });
    control.check()?;
    let result = result?;
    dir.directory().ensure_current().map_err(failed)?;
    ripgrep::validate_paths(dir, query, &result)?;
    Ok(result)
}

struct WorkerSlots(usize);

impl WorkerSlots {
    fn reserve() -> Self {
        let max = thread::available_parallelism()
            .map_or(1, usize::from)
            .min(MAX_WORKERS);
        if max == 1 {
            return Self(0);
        }
        let used = EXTRA_WORKERS.try_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
            (used < max).then_some(max)
        });
        Self(used.map_or(0, |used| max - used))
    }
}

impl Drop for WorkerSlots {
    fn drop(&mut self) {
        EXTRA_WORKERS.fetch_sub(self.0, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy)]
struct Control<'a> {
    cancellation: &'a CancellationToken,
    deadline: Instant,
    stop: &'a AtomicBool,
}

impl Control<'_> {
    fn check(self) -> Result<(), Error> {
        self.cancellation
            .check()
            .map_err(|signal| Error::Cancelled(signal.reason().to_string()))?;
        if Instant::now() >= self.deadline {
            return Err(Error::Failed("grep request timed out".into()));
        }
        Ok(())
    }

    fn check_io(self) -> io::Result<()> {
        if self.stop.load(Ordering::Relaxed) {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        self.check().map_err(io::Error::other)
    }
}

fn failed(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

fn file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    // A file replaced by a FIFO after traversal must not trap a worker in open().
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    options
}

// This wrapper lets a worker stop while reading a large file as well as between files.
struct FileInput<'a, R> {
    control: Control<'a>,
    file: io::Take<R>,
}

impl<R: Read> Read for FileInput<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.control.check_io()?;
        self.file.read(buf)
    }
}

struct Scanner<'a> {
    dir: &'a Dir,
    options: OpenOptions,
    #[cfg(windows)]
    parent: Option<(PathBuf, cap_std::fs::Dir)>,
    matcher: RegexMatcher,
    searcher: Searcher,
    control: Control<'a>,
}

impl Scanner<'_> {
    #[cfg(windows)]
    fn open(&mut self, relative: &Path, phase: ScanPhase) -> io::Result<cap_std::fs::File> {
        let root = self.dir.directory().handle();
        if phase == ScanPhase::Streaming {
            return root.open_with(relative, &self.options);
        }
        let (Some(parent), Some(name)) = (relative.parent(), relative.file_name()) else {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        };
        if parent.as_os_str().is_empty() {
            self.parent = None;
            return root.open_with(name, &self.options);
        }
        if self.parent.as_ref().is_none_or(|(path, _)| path != parent) {
            // Windows directory handles prevent renaming their directory while open.
            // Keep only the current parent, and release it at the end of each batch.
            self.parent = Some((parent.to_owned(), root.open_dir(parent)?));
        }
        let (_, handle) = self.parent.as_ref().expect("search file parent");
        handle.open_with(name, &self.options)
    }

    fn scan(
        &mut self,
        path: &Path,
        _phase: ScanPhase,
        printer: &mut JSON<impl Write>,
    ) -> io::Result<()> {
        self.control.check_io()?;
        let relative = path
            .strip_prefix(self.dir.canonical_path())
            .map_err(io::Error::other)?;
        #[cfg(windows)]
        let file = self.open(relative, _phase)?;
        #[cfg(not(windows))]
        let file = self
            .dir
            .directory()
            .handle()
            .open_with(relative, &self.options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > ripgrep::MAX_FILE_BYTES {
            return Ok(());
        }
        let reader = FileInput {
            control: self.control,
            file: file.take(ripgrep::MAX_FILE_BYTES),
        };
        let sink = printer.sink_with_path(&self.matcher, relative);
        self.searcher.search_reader(&self.matcher, reader, sink)
    }

    fn scan_batch(&mut self, batch: Batch) -> io::Result<()> {
        let mut printer = JSON::new(ChunkOutput {
            send: batch.output,
            control: self.control,
            buffer: Vec::with_capacity(OUTPUT_CHUNK),
        });
        for path in batch.files {
            let outcome = path.and_then(|path| {
                self.scan(&path, batch.phase, &mut printer)
                    .map_err(|error| {
                        io::Error::new(error.kind(), format!("{}: {error}", path.display()))
                    })
            });
            if let Err(error) = outcome {
                self.control.check_io()?;
                printer.get_mut().flush()?;
                printer.get_mut().send(Err(error))?;
            }
        }
        #[cfg(windows)]
        {
            self.parent = None;
        }
        printer.get_mut().flush()
    }
}

fn next_file(walk: &mut Walk, control: Control<'_>) -> io::Result<Option<PathBuf>> {
    for entry in walk {
        control.check_io()?;
        let entry = entry.map_err(io::Error::other)?;
        if entry.file_type().is_some_and(|kind| kind.is_file()) {
            return Ok(Some(entry.into_path()));
        }
    }
    Ok(None)
}

// The prefix streams through the sorted walker so a dense query can stop promptly.
// For a full scan, parallelize the remaining traversal and sort its bounded file list
// in the same component order as sorted depth-first traversal. Retain the original
// iterator if traversal fails or the list outgrows its budget.
fn collect_tail(walker: WalkBuilder, after: &Path, control: Control<'_>) -> Option<Vec<PathBuf>> {
    #[derive(Default)]
    struct Paths {
        files: Vec<PathBuf>,
        bytes: usize,
        incomplete: bool,
    }
    let paths = Mutex::new(Paths::default());
    walker.build_parallel().run(|| {
        Box::new(|entry| {
            if control.check_io().is_err() {
                return WalkState::Quit;
            }
            let mut paths = match entry {
                Ok(entry) => {
                    let path = entry.path();
                    if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                        if path < after && !after.starts_with(path) {
                            return WalkState::Skip;
                        }
                        if !has_ignore_file_alias(path).unwrap_or(true) {
                            return WalkState::Continue;
                        }
                        paths.lock().expect("grep path collector").incomplete = true;
                        return WalkState::Quit;
                    }
                    if path <= after || !entry.file_type().is_some_and(|kind| kind.is_file()) {
                        return WalkState::Continue;
                    }
                    let mut paths = paths.lock().expect("grep path collector");
                    let bytes = paths.bytes + path.as_os_str().len();
                    if !paths.incomplete
                        && paths.files.len() < MAX_PARALLEL_PATHS
                        && bytes <= MAX_PARALLEL_PATH_BYTES
                    {
                        paths.bytes = bytes;
                        paths.files.push(entry.into_path());
                        return WalkState::Continue;
                    }
                    paths
                }
                Err(_) => paths.lock().expect("grep path collector"),
            };
            paths.incomplete = true;
            WalkState::Quit
        })
    });
    let mut paths = paths.into_inner().expect("grep path collector");
    if paths.incomplete || control.check_io().is_err() {
        return None;
    }
    paths.files.sort_unstable();
    Some(paths.files)
}

fn has_ignore_file_alias(directory: &Path) -> io::Result<bool> {
    // The sorted walker probes ignore files by name. The parallel walker discovers
    // them by exact spelling in the directory listing. On a case-insensitive volume
    // a differently cased entry can be visible to the first walker only.
    for entry in std::fs::read_dir(directory)? {
        let name = entry?.file_name();
        let bytes = name.as_encoded_bytes();
        if bytes.first() != Some(&b'.') {
            continue;
        }
        for expected in [".git", ".gitignore", ".ignore", ".rgignore"] {
            if bytes != expected.as_bytes() && bytes.eq_ignore_ascii_case(expected.as_bytes()) {
                match std::fs::symlink_metadata(directory.join(expected)) {
                    Ok(_) => return Ok(true),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(false)
}

struct Batch {
    files: Vec<io::Result<PathBuf>>,
    output: mpsc::SyncSender<io::Result<Vec<u8>>>,
    phase: ScanPhase,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ScanPhase {
    Streaming,
    Collected,
}

// Only one chunk per worker may wait for the collector. Workers searching later paths
// back up here until earlier paths finish, even when all of their files have matches.
struct ChunkOutput<'a> {
    send: mpsc::SyncSender<io::Result<Vec<u8>>>,
    control: Control<'a>,
    buffer: Vec<u8>,
}

impl ChunkOutput<'_> {
    fn send(&self, result: io::Result<Vec<u8>>) -> io::Result<()> {
        self.send
            .send(result)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }
}

impl Write for ChunkOutput<'_> {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        self.control.check_io()?;
        let count = input.len().min(OUTPUT_CHUNK - self.buffer.len());
        self.buffer.extend_from_slice(&input[..count]);
        if self.buffer.len() == OUTPUT_CHUNK {
            self.flush()?;
        }
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.buffer.is_empty() {
            let buffer = std::mem::replace(&mut self.buffer, Vec::with_capacity(OUTPUT_CHUNK));
            self.send(Ok(buffer))?;
        }
        Ok(())
    }
}

type PendingBatch = (mpsc::SyncSender<Batch>, mpsc::Receiver<io::Result<Vec<u8>>>);

struct OrderedOutput<'a> {
    walk: Walk,
    parallel_tail: Option<WalkBuilder>,
    tail_paths: Option<std::vec::IntoIter<PathBuf>>,
    last_path: Option<PathBuf>,
    prefix_remaining: usize,
    control: Control<'a>,
    senders: VecDeque<mpsc::SyncSender<Batch>>,
    pending: VecDeque<PendingBatch>,
    output: Cursor<Vec<u8>>,
    exhausted: bool,
    error: Option<io::Error>,
}

impl OrderedOutput<'_> {
    fn fill(&mut self) -> io::Result<()> {
        if self.prefix_remaining == 0 && self.parallel_tail.is_some() {
            if !self.pending.is_empty() {
                return Ok(());
            }
            let walker = self.parallel_tail.take().expect("parallel tail pending");
            if let Some(after) = self.last_path.take() {
                self.tail_paths = collect_tail(walker, &after, self.control).map(Vec::into_iter);
                self.control.check_io()?;
            }
        }
        while !self.exhausted
            && (self.prefix_remaining > 0 || self.parallel_tail.is_none())
            && let Some(worker) = self.senders.pop_front()
        {
            let mut files = Vec::with_capacity(FILES_PER_BATCH);
            for _ in 0..FILES_PER_BATCH {
                let next = match &mut self.tail_paths {
                    Some(paths) => Ok(paths.next()),
                    None => next_file(&mut self.walk, self.control),
                };
                match next {
                    Ok(Some(path)) => {
                        if self.prefix_remaining > 0 {
                            self.prefix_remaining -= 1;
                            if self.prefix_remaining == 0 {
                                self.last_path = Some(path.clone());
                                files.push(Ok(path));
                                break;
                            }
                        }
                        files.push(Ok(path));
                    }
                    Ok(None) => {
                        self.exhausted = true;
                        break;
                    }
                    Err(error) => files.push(Err(error)),
                }
            }
            if !files.is_empty() {
                let (send, receive) = mpsc::sync_channel(1);
                worker
                    .send(Batch {
                        files,
                        output: send,
                        phase: if self.tail_paths.is_some() {
                            ScanPhase::Collected
                        } else {
                            ScanPhase::Streaming
                        },
                    })
                    .map_err(io::Error::other)?;
                self.pending.push_back((worker, receive));
            }
        }
        Ok(())
    }
}

impl Read for OrderedOutput<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.output.position() as usize == self.output.get_ref().len() {
            self.control.check_io()?;
            self.fill()?;
            let Some((_, receive)) = self.pending.front() else {
                return self.error.take().map_or(Ok(0), Err);
            };
            match receive.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(Ok(output)) => self.output = Cursor::new(output),
                Ok(Err(error)) => {
                    // Like the subprocess, return a scan error if we reach EOF. If the
                    // collector stops at the result limit, later errors are irrelevant.
                    self.error.get_or_insert(error);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let (worker, _) = self.pending.pop_front().expect("front batch");
                    self.senders.push_back(worker);
                }
            }
        }
        self.output.read(buf)
    }
}

impl Drop for OrderedOutput<'_> {
    fn drop(&mut self) {
        self.control.stop.store(true, Ordering::Relaxed);
        // Dropping both ends unblocks workers before thread::scope joins them.
    }
}

#[cfg(test)]
#[path = "ordered_scan_tests.rs"]
mod tests;

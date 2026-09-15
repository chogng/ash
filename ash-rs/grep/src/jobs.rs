use crate::JobError;
use crate::Match;
use crate::Owner;
use crate::Page;
use crate::Query;
use crate::Search;
use ash_async_utils::CancellationSource;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Permission;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const MAX_ACTIVE_SEARCHES: usize = 32;
const SEARCH_RETENTION: Duration = Duration::from_secs(300);

/// Runs bounded background content searches rooted at one dir.
///
/// The caller supplies a [`Owner`] for each operation. A job can only be read or cancelled
/// by the owner that started it, while the host remains free to map that identity to a connection,
/// session, or other caller boundary.
pub struct Jobs {
    dir: Dir,
    authorization: Option<Authorization>,
    search: Arc<dyn Search>,
    next_search_id: AtomicU64,
    jobs: Mutex<HashMap<String, Job>>,
}

impl Jobs {
    /// Creates a search service with a host-selected directory and shared search capability.
    pub fn new(dir: Dir, search: Arc<dyn Search>) -> Self {
        Self {
            dir,
            authorization: None,
            search,
            next_search_id: AtomicU64::new(1),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// Creates a search service whose running jobs stop when the host revokes the dir.
    pub fn new_authorized(dir: Authorization, search: Arc<dyn Search>) -> Result<Self, JobError> {
        dir.ensure_active().map_err(|_| JobError::Unavailable)?;
        if dir.permission() != Permission::SearchFiles {
            return Err(JobError::InvalidInput);
        }
        Ok(Self {
            dir: dir.dir().clone(),
            authorization: Some(dir),
            search,
            next_search_id: AtomicU64::new(1),
            jobs: Mutex::new(HashMap::new()),
        })
    }

    /// Starts a query and returns its opaque search ID.
    pub fn start(&self, owner: Owner, query: Query) -> Result<String, JobError> {
        crate::service::validate(&query).map_err(|_| JobError::InvalidInput)?;
        let authorization = self.authorization.clone();
        if authorization
            .as_ref()
            .is_some_and(|dir| dir.ensure_active().is_err())
        {
            return Err(JobError::Unavailable);
        }
        let mut jobs = self.jobs.lock().map_err(|_| JobError::Busy)?;
        cleanup_jobs(&mut jobs);
        if jobs.len() >= MAX_ACTIVE_SEARCHES {
            return Err(JobError::Busy);
        }

        let search_id = format!(
            "search-{:x}",
            self.next_search_id.fetch_add(1, Ordering::Relaxed)
        );
        let cancellation = CancellationSource::new();
        let state = Arc::new(Mutex::new(JobState::default()));
        jobs.insert(
            search_id.clone(),
            Job {
                owner,
                cancellation: cancellation.clone(),
                state: state.clone(),
                created_at: Instant::now(),
            },
        );
        let dir = self.dir.clone();
        let search = Arc::clone(&self.search);
        thread::spawn(move || run_search(dir, authorization, search, query, cancellation, state));
        Ok(search_id)
    }

    /// Reads at most `max_matches` entries after `after_match` for one owner-bound job.
    pub fn read(
        &self,
        owner: Owner,
        search_id: &str,
        after_match: usize,
        max_matches: usize,
    ) -> Result<Page, JobError> {
        if self
            .authorization
            .as_ref()
            .is_some_and(|a| a.ensure_active().is_err())
        {
            return Err(JobError::Unavailable);
        }
        if max_matches == 0 || max_matches > 200 {
            return Err(JobError::InvalidInput);
        }
        let mut jobs = self.jobs.lock().map_err(|_| JobError::Busy)?;
        cleanup_jobs(&mut jobs);
        let job = jobs.get(search_id).ok_or(JobError::NotFound)?;
        if job.owner != owner {
            return Err(JobError::NotOwner);
        }
        let state = job.state.lock().map_err(|_| JobError::Busy)?;
        if after_match > state.matches.len() {
            return Err(JobError::InvalidInput);
        }
        let end = after_match
            .saturating_add(max_matches)
            .min(state.matches.len());
        Ok(Page {
            matches: state.matches[after_match..end].to_vec(),
            next_match: end,
            completed: state.completed && end == state.matches.len(),
            limit_hit: state.limit_hit,
            error: state.error.clone(),
            freshness: state.freshness,
        })
    }

    /// Cancels and releases one owner-bound job.
    pub fn cancel(&self, owner: Owner, search_id: &str) -> Result<(), JobError> {
        let mut jobs = self.jobs.lock().map_err(|_| JobError::Busy)?;
        cleanup_jobs(&mut jobs);
        let job = jobs.get(search_id).ok_or(JobError::NotFound)?;
        if job.owner != owner {
            return Err(JobError::NotOwner);
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

struct Job {
    owner: Owner,
    cancellation: CancellationSource,
    state: Arc<Mutex<JobState>>,
    created_at: Instant,
}

impl Job {
    fn is_expired(&self, now: Instant) -> bool {
        let completed = self.state.lock().map_or(true, |state| state.completed);
        completed && now.duration_since(self.created_at) >= SEARCH_RETENTION
    }
}

#[derive(Default)]
struct JobState {
    matches: Vec<Match>,
    completed: bool,
    limit_hit: bool,
    error: Option<String>,
    freshness: Option<crate::Freshness>,
}

fn cleanup_jobs(jobs: &mut HashMap<String, Job>) {
    let now = Instant::now();
    jobs.retain(|_, job| !job.is_expired(now));
}

impl Drop for Jobs {
    fn drop(&mut self) {
        self.cancel_all();
    }
}
fn run_search(
    dir: Dir,
    authorization: Option<Authorization>,
    search: Arc<dyn Search>,
    query: Query,
    cancellation: CancellationSource,
    state: Arc<Mutex<JobState>>,
) {
    let token = cancellation.token();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let _ = sender.send(search.search(&dir, &query, &token));
    });
    let result = loop {
        if authorization
            .as_ref()
            .is_some_and(|a| a.ensure_active().is_err())
        {
            cancellation.cancel();
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(result) => break result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break Err(crate::Error::Failed("grep worker stopped".into())),
        }
    };
    let _ = worker.join();
    let result = if authorization
        .as_ref()
        .is_some_and(|a| a.ensure_active().is_err())
    {
        Err(crate::Error::Cancelled(
            "directory authorization was revoked".into(),
        ))
    } else {
        result
    };
    if let Ok(mut state) = state.lock() {
        match result {
            Ok(result) => {
                state.matches = result.matches;
                state.limit_hit = result.limit_hit;
                state.freshness = Some(result.freshness);
            }
            Err(error) => state.error = Some(error.to_string()),
        }
        state.completed = true;
    }
}

use crate::GitExecutionLimits;
use crate::GitResult;
use crate::client::GitCommandOutput;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use futures::future::WeakShared;
use std::collections::HashMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tokio::sync::Semaphore;

const MAX_CONCURRENT: usize = 8;
type Probe = BoxFuture<'static, GitResult<GitCommandOutput>>;
type Pending = Arc<Mutex<HashMap<Key, Entry>>>;

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) struct Key {
    pub(crate) cwd: PathBuf,
    pub(crate) executable: PathBuf,
    pub(crate) search_path: Option<OsString>,
    pub(crate) limits: GitExecutionLimits,
}

struct Entry {
    future: WeakShared<Probe>,
    identity: Arc<()>,
}

pub(crate) struct Coordinator {
    pending: Pending,
    permits: Arc<Semaphore>,
}

pub(crate) fn coordinator() -> &'static Coordinator {
    static COORDINATOR: OnceLock<Coordinator> = OnceLock::new();
    COORDINATOR.get_or_init(|| Coordinator::new(MAX_CONCURRENT))
}

impl Coordinator {
    fn new(concurrency: usize) -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(concurrency)),
        }
    }

    pub(crate) fn query(
        &self,
        key: Key,
        probe: impl Future<Output = GitResult<GitCommandOutput>> + Send + 'static,
    ) -> Shared<Probe> {
        let mut pending = self.pending.lock().expect("Git discovery registry");
        if let Some(future) = pending.get(&key).and_then(|entry| entry.future.upgrade()) {
            return future;
        }
        let identity = Arc::new(());
        let cleanup = Cleanup {
            pending: self.pending.clone(),
            key: key.clone(),
            identity: identity.clone(),
        };
        let permits = self.permits.clone();
        let future = async move {
            // Shared owns the process future. Dropping the last caller cancels queued or running work.
            let _cleanup = cleanup;
            let _permit = permits
                .acquire()
                .await
                .expect("Git discovery semaphore remains open");
            probe.await
        }
        .boxed()
        .shared();
        pending.insert(
            key,
            Entry {
                future: future.downgrade().expect("unpolled Git discovery"),
                identity,
            },
        );
        future
    }
}

struct Cleanup {
    pending: Pending,
    key: Key,
    identity: Arc<()>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let mut pending = self.pending.lock().expect("Git discovery registry");
        // A cancelled future can finish dropping after another caller has installed its replacement.
        if pending
            .get(&self.key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.identity, &self.identity))
        {
            pending.remove(&self.key);
        }
    }
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;

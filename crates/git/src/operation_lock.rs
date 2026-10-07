use crate::GitRepository;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

static REPOSITORY_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

/// Returns the process-wide operation lock for one Git common directory.
///
/// App Server Git RPC and background ChangeSet commits use this same identity, so a repository
/// mutation never overlaps another mutation in this process while unrelated repositories proceed.
pub fn repository_operation_lock(repository: &GitRepository) -> Arc<Mutex<()>> {
    let key = dunce::simplified(repository.common_dir()).to_path_buf();
    let locks = REPOSITORY_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

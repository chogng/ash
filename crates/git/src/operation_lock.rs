use crate::GitRepository;
use fs2::FileExt;
use sha2::Digest;
use std::collections::HashMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::Weak;

static REPOSITORY_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<RepositoryOperationLock>>>> =
    OnceLock::new();

/// Coordinates repository operations between product hosts and capability processes.
pub struct RepositoryOperationLock {
    repository: PathBuf,
    local: Mutex<()>,
}

/// Holds both the local queue and OS lock until the complete operation finishes.
pub struct RepositoryOperationGuard<'a> {
    file: File,
    _local: MutexGuard<'a, ()>,
}

impl RepositoryOperationLock {
    pub fn lock(&self) -> io::Result<RepositoryOperationGuard<'_>> {
        let local = self
            .local
            .lock()
            .map_err(|_| io::Error::other("repository lock poisoned"))?;
        let file = self.open()?;
        file.lock_exclusive()?;
        Ok(RepositoryOperationGuard {
            file,
            _local: local,
        })
    }

    pub fn try_lock(&self) -> io::Result<RepositoryOperationGuard<'_>> {
        let local = self.local.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
            std::sync::TryLockError::Poisoned(_) => io::Error::other("repository lock poisoned"),
        })?;
        let file = self.open()?;
        file.try_lock_exclusive().map_err(|error| {
            // fs2 reports Windows lock contention as ERROR_LOCK_VIOLATION, whose
            // std::io kind is not WouldBlock. Callers must queue on OS contention
            // just as they do when another thread holds the local mutex.
            if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                io::Error::new(io::ErrorKind::WouldBlock, error)
            } else {
                error
            }
        })?;
        Ok(RepositoryOperationGuard {
            file,
            _local: local,
        })
    }

    fn open(&self) -> io::Result<File> {
        // Locks must also work for inspection grants without writing repository metadata.
        // All profiles of the same OS user coordinate on the canonical common directory.
        let directory = dirs::data_local_dir()
            .ok_or_else(|| io::Error::other("Git lock directory unavailable"))?
            .join("com.ash")
            .join("git-locks");
        std::fs::create_dir_all(&directory)?;
        let digest = sha2::Sha256::digest(self.repository.as_os_str().as_encoded_bytes());
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!("{digest:x}.lock")))
    }
}

impl Drop for RepositoryOperationGuard<'_> {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

/// Returns the common-directory lock shared by all checkouts of one repository.
pub fn repository_operation_lock(repository: &GitRepository) -> Arc<RepositoryOperationLock> {
    let key = dunce::simplified(repository.common_dir()).to_path_buf();
    let locks = REPOSITORY_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(RepositoryOperationLock {
        repository: key.clone(),
        local: Mutex::new(()),
    });
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
#[path = "operation_lock_tests.rs"]
mod tests;

use crate::GitRepository;
use fs2::FileExt;
use sha2::Digest;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::RwLock;
use std::sync::RwLockReadGuard;
use std::sync::RwLockWriteGuard;
use std::sync::Weak;

static REPOSITORY_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<RepositoryOperationLock>>>> =
    OnceLock::new();

/// Coordinates repository operations between product hosts and capability processes.
pub struct RepositoryOperationLock {
    repository: PathBuf,
    local: RwLock<()>,
    writers: Mutex<VecDeque<Arc<()>>>,
}

/// Retains FIFO admission while a cancellable writer polls the OS lock. Dropping
/// the waiter cancels admission; subsequent readers cannot overtake queued writers.
pub struct RepositoryOperationWaiter<'a> {
    lock: &'a RepositoryOperationLock,
    ticket: Arc<()>,
}

/// Holds both the local queue and OS lock until the complete operation finishes.
pub struct RepositoryOperationGuard<'a> {
    file: File,
    _local: RwLockWriteGuard<'a, ()>,
}

/// Allows read-only Git queries to overlap while excluding mutations in every host.
/// Queries using this lease must disable Git's optional index writes. Mutations retain
/// the exclusive operation lease; external Git processes do not participate in either.
pub struct RepositoryReadGuard<'a> {
    file: File,
    _local: RwLockReadGuard<'a, ()>,
}

impl RepositoryOperationLock {
    pub fn lock(&self) -> io::Result<RepositoryOperationGuard<'_>> {
        let waiter = self.queue_write()?;
        loop {
            match waiter.try_lock() {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                result => return result,
            }
        }
    }

    pub fn try_lock(&self) -> io::Result<RepositoryOperationGuard<'_>> {
        let writers = self
            .writers
            .lock()
            .map_err(|_| io::Error::other("repository queue poisoned"))?;
        if !writers.is_empty() {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        self.try_write()
    }

    pub fn queue_write(&self) -> io::Result<RepositoryOperationWaiter<'_>> {
        let ticket = Arc::new(());
        self.writers
            .lock()
            .map_err(|_| io::Error::other("repository queue poisoned"))?
            .push_back(ticket.clone());
        Ok(RepositoryOperationWaiter { lock: self, ticket })
    }

    fn try_write(&self) -> io::Result<RepositoryOperationGuard<'_>> {
        let local = self.local.try_write().map_err(|error| match error {
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

    /// Acquires a shared observation lease without waiting for an active mutation.
    pub fn try_read(&self) -> io::Result<RepositoryReadGuard<'_>> {
        // Serialize admission with writer registration, not the observation itself.
        // The outer request queue cannot protect background watcher reads here.
        let writers = self
            .writers
            .lock()
            .map_err(|_| io::Error::other("repository queue poisoned"))?;
        if !writers.is_empty() {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let local = self.local.try_read().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
            std::sync::TryLockError::Poisoned(_) => io::Error::other("repository lock poisoned"),
        })?;
        let file = self.open()?;
        FileExt::try_lock_shared(&file).map_err(|error| {
            if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                io::Error::new(io::ErrorKind::WouldBlock, error)
            } else {
                error
            }
        })?;
        Ok(RepositoryReadGuard {
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

impl<'a> RepositoryOperationWaiter<'a> {
    pub fn try_lock(&self) -> io::Result<RepositoryOperationGuard<'a>> {
        let writers = self
            .lock
            .writers
            .lock()
            .map_err(|_| io::Error::other("repository queue poisoned"))?;
        if !writers
            .front()
            .is_some_and(|ticket| Arc::ptr_eq(ticket, &self.ticket))
        {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        self.lock.try_write()
    }
}

impl Drop for RepositoryOperationWaiter<'_> {
    fn drop(&mut self) {
        self.lock
            .writers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|ticket| !Arc::ptr_eq(ticket, &self.ticket));
    }
}

impl Drop for RepositoryOperationGuard<'_> {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl Drop for RepositoryReadGuard<'_> {
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
        local: RwLock::new(()),
        writers: Mutex::new(VecDeque::new()),
    });
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
#[path = "operation_lock_tests.rs"]
mod tests;

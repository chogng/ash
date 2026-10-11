#[cfg(test)]
use ash_async_utils::CancellationToken;
use ash_git::GitError;
#[cfg(test)]
use std::sync::Mutex;

#[derive(Debug)]
pub(crate) enum GitServiceError {
    Cancelled,
    BranchNotFound,
    Boundary,
    CommitChangeNotFound,
    ConflictChanged,
    Git(GitError),
    Runtime,
    Permission,
}

#[cfg(test)]
pub(crate) fn lock_for_request<'a, T>(
    lock: &'a Mutex<T>,
    cancellation: &CancellationToken,
) -> Result<std::sync::MutexGuard<'a, T>, GitServiceError> {
    loop {
        cancellation
            .check()
            .map_err(|_| GitServiceError::Cancelled)?;
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(GitServiceError::Runtime),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
        }
    }
}

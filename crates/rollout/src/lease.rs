use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::path::PathBuf;

use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use core_api::CoreError;
use core_api::LeaseGuard;
use core_api::WriterLease;

pub(super) struct LeaseDirectory {
    root: PathBuf,
}

struct FileLease {
    file: File,
}

impl Drop for FileLease {
    fn drop(&mut self) {
        // A child can inherit the open file description between fork and exec.
        // Closing our descriptor alone would leave that child holding the writer lock.
        let _ = self.file.unlock();
    }
}

impl LeaseDirectory {
    pub(super) fn open(root: impl Into<PathBuf>) -> Result<Self, CoreError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| CoreError::Journal(error.to_string()))?;
        Ok(Self { root })
    }

    fn acquire_file(&self, kind: &str, id: &str) -> Result<Box<dyn LeaseGuard>, CoreError> {
        let path = self.root.join(format!("{kind}-{}.lease", encode_hex(id)));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| {
                CoreError::Journal(format!("{kind} writer lease unavailable: {error}"))
            })?;
        file.try_lock().map_err(|error| {
            CoreError::Journal(format!("{kind} writer lease unavailable: {error}"))
        })?;
        Ok(Box::new(FileLease { file }))
    }
}

impl WriterLease<ThreadId> for LeaseDirectory {
    fn acquire(&self, thread_id: &ThreadId) -> Result<Box<dyn LeaseGuard>, CoreError> {
        self.acquire_file("thread", thread_id.as_str())
    }
}

impl WriterLease<SessionId> for LeaseDirectory {
    fn acquire(&self, session_id: &SessionId) -> Result<Box<dyn LeaseGuard>, CoreError> {
        self.acquire_file("session", session_id.as_str())
    }
}

impl LeaseGuard for FileLease {}

fn encode_hex(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "lease_tests.rs"]
mod tests;

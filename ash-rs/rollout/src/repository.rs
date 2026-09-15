use crate::LocalStateError;
use crate::lease::LeaseDirectory;
use ash_attachments::Attachments;
use ash_attachments::FileAttachmentStore;
use ash_core::ThreadController;
use ash_core::ThreadStore;
use ash_state::{SqliteThreadStore, StateRuntime};
use core_api::WriterLease;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Opens and recovers local authoritative Thread state under one profile root.
///
/// A repository provides the typed store ports needed by consumers that must inspect durable
/// history. New controllers must be obtained through [`Self::recover_threads`] so resumable work
/// is restored before product services start while ordinary history stays lazy.
pub struct LocalStateRepository {
    database_path: PathBuf,
    thread_store: Arc<SqliteThreadStore>,
    writer_lease: Arc<LeaseDirectory>,
    attachments: Arc<Attachments>,
}

impl LocalStateRepository {
    pub fn open(state: &StateRuntime) -> Result<Self, LocalStateError> {
        let root = state.profile_root();
        let database_path = state.database_path().to_path_buf();
        let image_store = FileAttachmentStore::open(root.join("attachments"))
            .map_err(|error| core_api::CoreError::Journal(error.to_string()))?;
        Ok(Self {
            thread_store: Arc::new(SqliteThreadStore::open(&database_path)?),
            writer_lease: Arc::new(LeaseDirectory::open(state.writer_leases_root())?),
            attachments: Arc::new(Attachments::new(Arc::new(image_store))),
            database_path,
        })
    }

    /// Returns the shared SQLite database used by the repository's local authorities.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Returns the read/write Thread history port for this repository.
    pub fn thread_store(&self) -> Arc<dyn ThreadStore> {
        self.thread_store.clone()
    }

    /// Recovers the Core Thread authority from this repository's durable history.
    pub fn recover_threads(&self) -> Result<Arc<ThreadController>, LocalStateError> {
        self.recover_threads_with_attachments(Arc::clone(&self.attachments))
    }

    /// Opens Thread state, upgrades missing catalog rows, and recovers only resumable work.
    pub fn recover_threads_with_attachments(
        &self,
        attachments: Arc<Attachments>,
    ) -> Result<Arc<ThreadController>, LocalStateError> {
        let thread_store: Arc<dyn ThreadStore> = self.thread_store.clone();
        let thread_lease: Arc<dyn WriterLease<ash_protocol::ThreadId>> = self.writer_lease.clone();
        let threads = Arc::new(ThreadController::with_store_lease_and_attachments(
            thread_store,
            thread_lease,
            attachments,
        ));
        let catalog = self.thread_store.list_catalog()?;
        let catalog_ids = catalog
            .iter()
            .map(|record| record.thread.thread_id.clone())
            .collect::<BTreeSet<_>>();
        let mut recovered = BTreeSet::new();
        for thread_id in self.thread_store.list_thread_ids()? {
            if catalog_ids.contains(&thread_id) {
                continue;
            }
            threads.recover_thread(&thread_id)?;
            let record = threads.thread_catalog_record(&thread_id)?;
            self.thread_store.backfill_catalog(&record)?;
            recovered.insert(thread_id);
        }
        for record in self.thread_store.list_catalog()? {
            if record.requires_startup_recovery && recovered.insert(record.thread.thread_id.clone())
            {
                threads.recover_thread(&record.thread.thread_id)?;
            }
        }

        Ok(threads)
    }
}

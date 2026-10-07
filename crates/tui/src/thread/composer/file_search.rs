//! Background orchestration for directory-path mention searches.

use ash_file_search::PathSearchHandle;
use ash_file_search::PathSearchOptions;
use ash_file_search::PathSearchSnapshot;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;

#[derive(Debug)]
pub(crate) struct FileSearchManager {
    search_root: PathBuf,
    service: ash_file_search::Service,
    latest_query: Option<String>,
    latest_query_revision: Option<u64>,
    handle: Option<PathSearchHandle>,
    snapshots: Option<Receiver<PathSearchSnapshot>>,
    pending: Vec<PathSearchSnapshot>,
}

impl FileSearchManager {
    pub(crate) fn new(search_root: PathBuf) -> Self {
        Self {
            search_root,
            service: ash_file_search::Service,
            latest_query: None,
            latest_query_revision: None,
            handle: None,
            snapshots: None,
            pending: Vec::new(),
        }
    }

    pub(crate) fn update_query(&mut self, query: &str) {
        if self.latest_query.as_deref() == Some(query) && self.handle.is_some() {
            return;
        }
        if self.handle.is_none() {
            let (handle, snapshots) = match self
                .service
                .start(self.search_root.clone(), PathSearchOptions::default())
            {
                Ok(started) => started,
                Err(_) => {
                    self.latest_query = Some(query.to_owned());
                    self.latest_query_revision = Some(0);
                    self.pending = vec![PathSearchSnapshot {
                        query_revision: 0,
                        query: query.to_owned(),
                        scan_complete: true,
                        search_complete: true,
                        ..PathSearchSnapshot::default()
                    }];
                    return;
                }
            };
            self.pending.clear();
            self.handle = Some(handle);
            self.snapshots = Some(snapshots);
        }
        if let Some(handle) = &self.handle {
            self.latest_query = Some(query.to_owned());
            self.latest_query_revision = Some(handle.update_query(query));
        }
    }

    pub(crate) fn stop(&mut self) {
        self.latest_query = None;
        self.latest_query_revision = None;
        self.handle = None;
        self.snapshots = None;
        self.pending.clear();
    }

    pub(crate) fn poll(&mut self) -> Vec<PathSearchSnapshot> {
        let mut current = std::mem::take(&mut self.pending);
        let Some(snapshots) = &self.snapshots else {
            return current;
        };
        loop {
            match snapshots.try_recv() {
                Ok(snapshot)
                    if self.latest_query.as_deref() == Some(snapshot.query.as_str())
                        && self.latest_query_revision == Some(snapshot.query_revision) =>
                {
                    current.push(snapshot);
                }
                Ok(_) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.handle = None;
                    self.snapshots = None;
                    break;
                }
            }
        }
        current
    }
}

#[cfg(test)]
#[path = "file_search_tests.rs"]
mod tests;

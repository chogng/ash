use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread::JoinHandle;

use ash_async_utils::CancellationSource;
use ash_file_access::Authorization;
use ash_file_access::Permission;

use crate::discovery;
use crate::model::Catalog;
use crate::model::OperationKind;
use crate::model::OperationStatus;
use crate::model::Snapshot;
use crate::model::Update;
use crate::runner;

pub(crate) const MAX_TESTS: usize = 10_000;
const MAX_OPERATIONS: usize = 32;

#[derive(Debug, Clone, thiserror::Error)]
pub enum TestingError {
    #[error("invalid test operation")]
    InvalidInput,
    #[error("test operation was not found")]
    NotFound,
    #[error("test operation limit reached")]
    Busy,
    #[error("test permission is required")]
    PermissionRequired,
    #[error("{0}")]
    Failed(String),
    #[error("test operation cancelled")]
    Cancelled,
}

pub(crate) struct Operation {
    pub(crate) snapshot: Mutex<Snapshot>,
    pub(crate) cancellation: CancellationSource,
    pub(crate) publish: Arc<dyn Fn(Update) + Send + Sync>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Operation {
    pub(crate) fn update(&self, change: impl FnOnce(&mut Snapshot) -> Update) {
        let mut snapshot = self.snapshot.lock().expect("test state mutex");
        snapshot.sequence += 1;
        let update = change(&mut snapshot);
        // Publication stays under the state lock so sequence order also holds on the wire.
        (self.publish)(update);
    }

    fn join(&self) {
        if let Some(worker) = self.worker.lock().expect("test worker mutex").take() {
            worker.join().expect("test worker completed");
        }
    }
}

struct Record {
    root: std::path::PathBuf,
    operation: Arc<Operation>,
}

/// Owns connection-scoped catalogs and runs until explicit release or connection shutdown.
#[derive(Default)]
pub struct TestingService {
    operations: Mutex<HashMap<(u64, String), Record>>,
}

impl TestingService {
    pub fn discover(
        &self,
        owner: u64,
        operation_id: String,
        read: Authorization,
        execute: Authorization,
        publish: Arc<dyn Fn(Update) + Send + Sync>,
    ) -> Result<(), TestingError> {
        validate_authorizations(&read, &execute)?;
        self.start(
            owner,
            operation_id,
            execute.dir().canonical_path().to_owned(),
            OperationKind::Discovery,
            publish,
            move |worker| {
                let result = discovery::discover(&read, &execute, &worker.cancellation.token());
                worker.update(|snapshot| {
                    match result {
                        Ok(tests) => {
                            snapshot.tests = tests;
                            snapshot.status = OperationStatus::Completed;
                        }
                        Err(TestingError::Cancelled) => {
                            snapshot.status = OperationStatus::Cancelled;
                        }
                        Err(error) => {
                            snapshot.status = OperationStatus::Failed;
                            snapshot.error = Some(error.to_string());
                        }
                    }
                    Update {
                        operation_id: snapshot.operation_id.clone(),
                        sequence: snapshot.sequence,
                        status: snapshot.status,
                        tests: Some(snapshot.tests.clone()),
                        result: None,
                        error: snapshot.error.clone(),
                    }
                });
            },
        )
    }

    pub fn run(
        &self,
        owner: u64,
        operation_id: String,
        catalog_id: &str,
        test_ids: &[String],
        execute: Authorization,
        publish: Arc<dyn Fn(Update) + Send + Sync>,
    ) -> Result<(), TestingError> {
        if execute.permission() != Permission::ExecuteCommands {
            return Err(TestingError::PermissionRequired);
        }
        execute
            .ensure_active()
            .map_err(|_| TestingError::PermissionRequired)?;
        if test_ids.is_empty() || test_ids.len() > MAX_TESTS {
            return Err(TestingError::InvalidInput);
        }
        let catalog = {
            let records = self.operations.lock().expect("test registry mutex");
            let record = records
                .get(&(owner, catalog_id.to_owned()))
                .ok_or(TestingError::NotFound)?;
            if record.root != execute.dir().canonical_path() {
                return Err(TestingError::InvalidInput);
            }
            let snapshot = record.operation.snapshot.lock().expect("test state mutex");
            if snapshot.kind != OperationKind::Discovery
                || snapshot.status != OperationStatus::Completed
            {
                return Err(TestingError::InvalidInput);
            }
            let mut selected = std::collections::HashSet::new();
            let mut tests = Vec::new();
            for id in test_ids {
                if !selected.insert(id) {
                    return Err(TestingError::InvalidInput);
                }
                tests.push(
                    snapshot
                        .tests
                        .iter()
                        .find(|test| &test.id == id)
                        .ok_or(TestingError::InvalidInput)?
                        .clone(),
                );
            }
            Catalog {
                root: record.root.clone(),
                tests,
            }
        };
        self.start(
            owner,
            operation_id,
            catalog.root.clone(),
            OperationKind::Run,
            publish,
            move |worker| runner::run(&worker, catalog, execute),
        )
    }

    pub fn read(&self, owner: u64, operation_id: &str) -> Result<Snapshot, TestingError> {
        Ok(self
            .owned(owner, operation_id)?
            .snapshot
            .lock()
            .expect("test state mutex")
            .clone())
    }

    /// The response follows process termination and the final update, including completion races.
    pub fn cancel(&self, owner: u64, operation_id: &str) -> Result<Snapshot, TestingError> {
        let operation = self.owned(owner, operation_id)?;
        operation.cancellation.cancel();
        operation.join();
        Ok(operation.snapshot.lock().expect("test state mutex").clone())
    }

    pub fn release(&self, owner: u64, operation_id: &str) -> Result<(), TestingError> {
        self.cancel(owner, operation_id)?;
        self.operations
            .lock()
            .expect("test registry mutex")
            .remove(&(owner, operation_id.to_owned()));
        Ok(())
    }

    pub fn close_owner(&self, owner: u64) {
        let operations = {
            let mut records = self.operations.lock().expect("test registry mutex");
            let ids: Vec<_> = records
                .iter()
                .filter(|((record_owner, _), _)| *record_owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .map(|id| records.remove(&id).expect("owned record").operation)
                .collect::<Vec<_>>()
        };
        for operation in &operations {
            operation.cancellation.cancel();
        }
        for operation in operations {
            operation.join();
        }
    }

    fn owned(&self, owner: u64, operation_id: &str) -> Result<Arc<Operation>, TestingError> {
        let records = self.operations.lock().expect("test registry mutex");
        let record = records
            .get(&(owner, operation_id.to_owned()))
            .ok_or(TestingError::NotFound)?;
        Ok(Arc::clone(&record.operation))
    }

    fn start(
        &self,
        owner: u64,
        operation_id: String,
        root: std::path::PathBuf,
        kind: OperationKind,
        publish: Arc<dyn Fn(Update) + Send + Sync>,
        work: impl FnOnce(Arc<Operation>) + Send + 'static,
    ) -> Result<(), TestingError> {
        if operation_id.is_empty()
            || operation_id.len() > 128
            || !operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(TestingError::InvalidInput);
        }
        let mut records = self.operations.lock().expect("test registry mutex");
        if records.contains_key(&(owner, operation_id.clone())) {
            return Err(TestingError::InvalidInput);
        }
        if records.len() >= MAX_OPERATIONS {
            return Err(TestingError::Busy);
        }
        let operation = Arc::new(Operation {
            snapshot: Mutex::new(Snapshot {
                operation_id: operation_id.clone(),
                kind,
                status: OperationStatus::Running,
                tests: Vec::new(),
                results: Vec::new(),
                error: None,
                sequence: 0,
            }),
            cancellation: CancellationSource::new(),
            publish,
            worker: Mutex::new(None),
        });
        // Publish ownership and the worker atomically. Cancel and disconnect must never
        // observe a record whose process can start after they have already returned.
        let worker_operation = Arc::clone(&operation);
        let handle = std::thread::Builder::new()
            .name("testing".into())
            .spawn(move || work(worker_operation))
            .map_err(|error| TestingError::Failed(error.to_string()))?;
        *operation.worker.lock().expect("test worker mutex") = Some(handle);
        records.insert((owner, operation_id), Record { root, operation });
        Ok(())
    }
}

impl Drop for TestingService {
    fn drop(&mut self) {
        let records = self.operations.get_mut().expect("test registry mutex");
        for record in records.values() {
            record.operation.cancellation.cancel();
        }
        for record in records.values() {
            record.operation.join();
        }
    }
}

fn validate_authorizations(
    read: &Authorization,
    execute: &Authorization,
) -> Result<(), TestingError> {
    if read.permission() != Permission::ReadFiles
        || execute.permission() != Permission::ExecuteCommands
        || read.dir() != execute.dir()
    {
        return Err(TestingError::PermissionRequired);
    }
    read.ensure_active()
        .map_err(|_| TestingError::PermissionRequired)?;
    execute
        .ensure_active()
        .map_err(|_| TestingError::PermissionRequired)
}

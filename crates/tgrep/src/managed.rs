//! Versioned managed lifecycle client. Journals contain protocol intent and receipts;
//! authoritative views, generations, ownership and collection remain in the engine.
use super::Error;
use super::Executable;
use super::Status;
use super::check;
use super::failed;
use super::process;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::TryLockError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Category {
    InvalidInput,
    Busy,
    StaleIdentity,
    StaleVersion,
    CacheEvicted,
    CacheMissing,
    GitObjectsUnavailable,
    Incompatible,
    CorruptMetadata,
    ResourcePressure,
    Permission,
    Io,
    Cancelled,
    Deadline,
    ReceiptExpired,
    RecoveryRequired,
}
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Commitment {
    NotCommitted,
    Committed,
    Unknown,
}

/// A typed failure from the managed process boundary, retained for safe replay decisions.
#[derive(Debug, Deserialize)]
pub struct ManagementError {
    category: Category,
    reason_code: String,
    retryable: bool,
    committed_state: Commitment,
    detail: String,
    #[serde(default, rename = "operation_id")]
    _operation_id: Option<String>,
    #[serde(default, rename = "current_version")]
    _current_version: Option<u64>,
}
impl std::fmt::Display for ManagementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}
impl ManagementError {
    pub(super) fn into_error(self) -> Error {
        if self.category == Category::Busy
            && self.retryable
            && self.committed_state == Commitment::NotCommitted
            && matches!(
                self.reason_code.as_str(),
                "view-not-loaded"
                    | "view-not-ready"
                    | "view-input-pending"
                    | "checkpoint-not-current"
                    | "view-has-no-published-pin"
            )
        {
            Error::NotReady(self.detail)
        } else {
            Error::Management(self)
        }
    }
}

const QUEUE_ITEMS: usize = 64;

pub(super) fn policy() -> Value {
    json!({"schema":2,"storage":"managed","retention":{"mode":"bounded","target_bytes":2147483648u64},
        "advancement":{"mode":"fixed"},
        "work":{"max_views":64,"max_leases":256,"workers":2,"queue_items":QUEUE_ITEMS,
            "staging_bytes":1073741824u64,"private_work_bytes":1073741824u64,
            "sort_buffer_bytes":8388608,"blob_bytes":67108864,"operation_timeout_ms":600000,
            "page_objects":128,"max_cursors":16,"cursor_lifetime_ms":30000,"max_receipts":4096,"metadata_bytes":134217728},
        "collection":{"schedule":{"mode":"periodic","interval_ms":60000},"on_pressure":true,
            "checkpoint_grace_ms":300000,"generation_grace_ms":3600000,"max_duration_ms":200,
            "max_examined":128,"max_removed":16,"max_delete_bytes":16777216,"chunk_bytes":65536,"max_pages":16,"retry_ms":1000}})
}
fn token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}-{time}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn persist(path: &Path, value: &Value) -> Result<(), Error> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    // The request is never sent until its intent has reached stable storage.
    #[cfg(unix)]
    std::fs::File::open(
        path.parent()
            .ok_or_else(|| failed("journal has no parent"))?,
    )?
    .sync_all()?;
    Ok(())
}
#[derive(Clone)]
struct Operation {
    sequence: u64,
    method: String,
    envelope: Value,
    id: Option<String>,
}

pub(super) struct Session {
    process: Arc<process::Server>,
    root: PathBuf,
    journal: PathBuf,
    bootstrap: String,
    claim: Mutex<Option<Value>>,
    holder: Mutex<Option<process::Owner>>,
    lease: String,
    view: Mutex<Option<String>>,
    pending: Mutex<Option<Operation>>,
    sequence: AtomicU64,
    // Content work is serialized per registration; filenames do not acquire this gate.
    content: Mutex<()>,
    closed: AtomicBool,
    retiring: AtomicBool,
}
impl Session {
    pub(super) fn open(
        process: Arc<process::Server>,
        executable: &Executable,
        root: &Path,
        revision: &str,
        cancellation: &CancellationToken,
        lifetime: impl Send + 'static,
    ) -> Result<Arc<Self>, Error> {
        let bootstrap = token();
        let journal = process.index().join("clients").join(&bootstrap);
        std::fs::create_dir_all(&journal)?;
        persist(&journal.join("bootstrap.json"), &json!({"token":bootstrap}))?;
        let session = Arc::new(Self {
            process,
            root: root.into(),
            journal,
            bootstrap,
            claim: Mutex::new(None),
            holder: Mutex::new(None),
            lease: token(),
            view: Mutex::new(None),
            pending: Mutex::new(None),
            sequence: AtomicU64::new(1),
            content: Mutex::new(()),
            closed: AtomicBool::new(false),
            retiring: AtomicBool::new(false),
        });
        let result = session.initialize(
            executable,
            revision,
            cancellation,
            Instant::now() + super::TIMEOUT,
        );
        if let Err(error) = result {
            session.retire(lifetime);
            return Err(error);
        }
        Ok(session)
    }
    fn initialize(
        &self,
        executable: &Executable,
        revision: &str,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        let prepared = self.process.rpc(
            "owners.prepare",
            json!({"token":self.bootstrap,"ash_parent":true}),
            cancellation,
            deadline,
        )?;
        let claim = prepared
            .get("claim")
            .cloned()
            .ok_or_else(|| failed("missing managed owner claim"))?;
        let (namespace, instance) = self.process.managed_identity()?;
        if claim["namespace"] != namespace
            || claim["instance"] != instance
            || claim["owner"].as_str().is_none_or(str::is_empty)
        {
            return Err(failed("managed owner identity changed"));
        }
        *self.claim.lock().unwrap_or_else(|e| e.into_inner()) = Some(claim.clone());
        let claim_path = self.journal.join("claim.json");
        persist(&claim_path, &claim)?;
        let holder = process::Owner::start(executable, &claim_path, cancellation, deadline)?;
        *self.holder.lock().unwrap_or_else(|e| e.into_inner()) = Some(holder);
        self.process.rpc(
            "owners.register",
            json!({"claim":claim}),
            cancellation,
            deadline,
        )?;
        let allocation = self
            .process
            .rpc("hello", json!({}), cancellation, deadline)?["allocation"]["version"]
            .as_u64()
            .ok_or_else(|| failed("invalid managed allocation"))?;
        let current =
            match self
                .process
                .rpc("lookup", json!({"root":self.root}), cancellation, deadline)
            {
                Ok(current) => Some(current),
                Err(Error::Management(error)) if error.reason_code == "worktree-not-attached" => {
                    None
                }
                Err(error) => return Err(error),
            };
        let acceptance = current
            .as_ref()
            .filter(|current| current["active"] == true)
            .map(|current| json!({"view":current["view"],"version":current["version"]}));
        let request = json!({"root":self.root,"revision":if acceptance.is_some(){None}else{Some(revision)},
            "profile":super::profile(),"lease":self.lease,"owner":self.owner()?,
            "accept_current":acceptance,"migratable":true,"allocation_version":allocation});
        let mut operation = self.prepare("views.attach", request)?;
        // Keep intent available to cancellation cleanup before any RPC can commit it.
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(operation.clone());
        let receipt = self.submit(&mut operation, cancellation, deadline)?;
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(operation.clone());
        let mut receipt = receipt;
        loop {
            check(cancellation, deadline)?;
            if let Some(view) = receipt["progress"]["view"]
                .as_str()
                .or_else(|| receipt["result"]["current"]["id"].as_str())
            {
                *self.view.lock().unwrap_or_else(|e| e.into_inner()) = Some(view.into());
                // The observer and original root are installed before content construction.
                match self.rpc("status", json!({}), cancellation, deadline) {
                    Ok(_) => return Ok(()),
                    Err(Error::NotReady(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            self.terminal_error(&receipt)?;
            std::thread::sleep(Duration::from_millis(25));
            receipt = self.inspect(&operation, cancellation, deadline)?;
        }
    }
    fn owner(&self) -> Result<String, Error> {
        self.claim
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|v| v["owner"].as_str())
            .map(str::to_owned)
            .ok_or_else(|| failed("managed owner is unavailable"))
    }
    fn prepare(&self, method: &str, request: Value) -> Result<Operation, Error> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let envelope = json!({"token":{"scope":self.owner()?,"sequence":sequence,"token":token()},"request":request});
        persist(
            &self.journal.join(format!("{sequence}.request.json")),
            &json!({"method":method,"params":envelope}),
        )?;
        Ok(Operation {
            sequence,
            method: method.into(),
            envelope,
            id: None,
        })
    }
    fn validate_receipt(&self, op: &Operation, receipt: &Value) -> Result<(), Error> {
        let (_, instance) = self.process.managed_identity()?;
        if receipt["token"] != op.envelope["token"]
            || receipt["request"] != op.envelope["request"]
            || receipt["instance"] != instance
            || receipt["id"].as_str().is_none_or(str::is_empty)
            || op.id.as_ref().is_some_and(|id| receipt["id"] != *id)
            || !matches!(
                receipt["state"].as_str(),
                Some(
                    "accepted"
                        | "preparing"
                        | "committed"
                        | "completed"
                        | "cancelling"
                        | "cancelled"
                        | "failed"
                )
            )
        {
            return Err(failed("invalid managed operation receipt"));
        }
        Ok(())
    }
    fn submit(
        &self,
        op: &mut Operation,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        let receipt = self
            .process
            .rpc(&op.method, op.envelope.clone(), cancellation, deadline)?;
        self.validate_receipt(op, &receipt)?;
        op.id = receipt["id"].as_str().map(str::to_owned);
        Ok(receipt)
    }
    fn inspect(
        &self,
        op: &Operation,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        let receipt = if let Some(id) = &op.id {
            self.process.rpc(
                "operations.inspect",
                json!({"id":id}),
                cancellation,
                deadline,
            )?
        } else {
            self.process.rpc(
                "operations.lookup",
                op.envelope["token"].clone(),
                cancellation,
                deadline,
            )?
        };
        self.validate_receipt(op, &receipt)?;
        Ok(receipt)
    }
    fn terminal_error(&self, receipt: &Value) -> Result<(), Error> {
        if matches!(receipt["state"].as_str(), Some("failed" | "cancelled")) {
            let error: ManagementError = serde_json::from_value(receipt["error"].clone())?;
            return Err(Error::Management(error));
        }
        Ok(())
    }
    fn finish(
        &self,
        op: &Operation,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        loop {
            check(cancellation, deadline)?;
            let result_path = self.journal.join(format!("{}.result.json", op.sequence));
            let receipt = match std::fs::read(&result_path) {
                Ok(bytes) => {
                    let receipt = serde_json::from_slice(&bytes)?;
                    self.validate_receipt(op, &receipt)?;
                    receipt
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.inspect(op, cancellation, deadline)?
                }
                Err(error) => return Err(error.into()),
            };
            if matches!(
                receipt["state"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                if !result_path.exists() {
                    persist(&result_path, &receipt)?;
                }
                loop {
                    check(cancellation, deadline)?;
                    match self.process.rpc(
                        "operations.acknowledge",
                        json!({"scope":self.owner()?,"through":op.sequence}),
                        cancellation,
                        deadline,
                    ) {
                        // Terminal publication precedes release of the worker's result guard.
                        // Retry only this explicit, uncommitted acknowledgment contention.
                        Err(Error::Management(error))
                            if error.category == Category::Busy
                                && error.retryable
                                && error.committed_state == Commitment::NotCommitted
                                && error.reason_code == "operation-result-still-in-use" =>
                        {
                            std::thread::sleep(Duration::from_millis(25));
                        }
                        result => {
                            result?;
                            break;
                        }
                    }
                }
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                if pending
                    .as_ref()
                    .is_some_and(|pending| pending.sequence == op.sequence)
                {
                    pending.take();
                }
                drop(pending);
                let _ = std::fs::remove_file(
                    self.journal.join(format!("{}.request.json", op.sequence)),
                );
                let _ = std::fs::remove_file(result_path);
                self.terminal_error(&receipt)?;
                return Ok(receipt["result"].clone());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    fn await_pending(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        let operation = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(mut operation) = operation {
            if operation.id.is_none() {
                // A lost submission response may mean either no commit or accepted work.
                // Replaying this exact persisted token handles both cases in the engine.
                self.submit(&mut operation, cancellation, deadline)?;
                *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(operation.clone());
            }
            self.finish(&operation, cancellation, deadline)?;
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
        }
        Ok(())
    }
    pub(super) fn lookup(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        let value =
            self.process
                .rpc("lookup", json!({"root":self.root}), cancellation, deadline)?;
        if dunce::simplified(&serde_json::from_value::<PathBuf>(value["root"].clone())?)
            != self.root
            || value["version"].as_u64().is_none()
            || value["generation"]["profile"] != super::profile()
            || self
                .view
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_some_and(|view| value["view"] != *view)
        {
            return Err(failed("managed view identity changed"));
        }
        Ok(value)
    }
    pub(super) fn rpc(
        &self,
        method: &str,
        query: Value,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        for attempt in 0..3 {
            let pin = self.lookup(cancellation, deadline)?;
            let value=match self.process.rpc(method,json!({"root":self.root,"view":pin["view"],"expected_version":pin["version"],"query":query}),cancellation,deadline){
                Err(Error::Management(error)) if error.category==Category::StaleVersion && attempt<2=>continue,
                result=>result?,
            };
            if dunce::simplified(&serde_json::from_value::<PathBuf>(value["root"].clone())?)
                != self.root
                || value["view"] != pin["view"]
                || value["version"] != pin["version"]
                || value["generation"] != pin["generation"]
            {
                return Err(failed("managed query publication changed"));
            }
            if method != "status" {
                let readiness = if method.starts_with("files/") {
                    "files_ready"
                } else {
                    "ready"
                };
                if value[readiness] != true || value["epoch"].as_u64().is_none() {
                    return Err(failed("managed query is not ready"));
                }
            }
            return Ok(value);
        }
        Err(failed("managed publication kept changing"))
    }
    pub(super) fn status(&self, cancellation: &CancellationToken) -> Result<Status, Error> {
        let value = self.rpc(
            "status",
            json!({}),
            cancellation,
            Instant::now() + super::TIMEOUT,
        )?;
        if let Some(error) = value["status"]["error"].as_object() {
            return Err(Error::Management(serde_json::from_value(Value::Object(
                error.clone(),
            ))?));
        }
        Ok(Status {
            indexed_file_count: value["num_files"]
                .as_u64()
                .ok_or_else(|| failed("invalid managed file count"))?
                as usize,
            indexing: value["reconcile_running"]
                .as_bool()
                .ok_or_else(|| failed("invalid managed reconciliation status"))?,
            ready: value["ready"]
                .as_bool()
                .ok_or_else(|| failed("invalid managed readiness"))?,
            watcher_active: value["watch_mode"] == "native",
            files_ready: value["files_ready"]
                .as_bool()
                .ok_or_else(|| failed("invalid managed filename readiness"))?,
            file_count: value["file_count"]
                .as_u64()
                .ok_or_else(|| failed("invalid managed filename count"))?
                as usize,
        })
    }
    fn content(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<MutexGuard<'_, ()>, Error> {
        loop {
            check(cancellation, deadline)?;
            match self.content.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    }
    pub(super) fn wait_ready(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        let _content = self.content(cancellation, deadline)?;
        self.await_pending(cancellation, deadline)?;
        self.wait_reconciled(cancellation, deadline, 0)
    }
    fn wait_reconciled(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
        epoch: u64,
    ) -> Result<(), Error> {
        loop {
            check(cancellation, deadline)?;
            let status = self.rpc("status", json!({}), cancellation, deadline)?;
            if let Some(error) = status["status"]["error"].as_object() {
                return Err(Error::Management(serde_json::from_value(Value::Object(
                    error.clone(),
                ))?));
            }
            if status["ready"] == true
                && status["epoch"].as_u64().is_some_and(|value| value >= epoch)
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    pub(super) fn refresh(
        &self,
        changed: &[PathBuf],
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        let _content = self.content(cancellation, deadline)?;
        self.await_pending(cancellation, deadline)?;
        let pin = self.lookup(cancellation, deadline)?;
        // Managed invalidation bounds hint count by its work queue. A larger Ash batch
        // becomes one full invalidation rather than failing every subsequent query.
        let full = changed.is_empty() || changed.len() > QUEUE_ITEMS;
        let changed = if full { &[][..] } else { changed };
        let response=self.process.rpc("views.invalidate",json!({"view":pin["view"],"expected_version":pin["version"],"owner":self.owner()?,"changed":changed,"full":full}),cancellation,deadline)?;
        let epoch = response["input_epoch"]
            .as_u64()
            .ok_or_else(|| failed("invalid managed invalidation epoch"))?;
        self.wait_reconciled(cancellation, deadline, epoch)
    }
    pub(super) fn rebuild(
        &self,
        executable: &Executable,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        let _content = self.content(cancellation, deadline)?;
        self.await_pending(cancellation, deadline)?;
        let pin = self.lookup(cancellation, deadline)?;
        let revision = executable
            .identity(&self.root, cancellation)?
            .revision
            .ok_or_else(|| failed("managed worktree has no commit"))?;
        let allocation = self
            .process
            .rpc("hello", json!({}), cancellation, deadline)?["allocation"]["version"]
            .as_u64()
            .ok_or_else(|| failed("invalid managed allocation"))?;
        let (method, request) = if pin["commit"] != revision {
            (
                "views.advance",
                json!({"view":pin["view"],"root":self.root,"expected_version":pin["version"],"target_commit":revision,"profile":super::profile(),"owner":self.owner()?,"allocation_version":allocation}),
            )
        } else {
            (
                "views.refresh",
                json!({"view":pin["view"],"expected_version":pin["version"],"owner":self.owner()?,"allocation_version":allocation}),
            )
        };
        let mut operation = self.prepare(method, request)?;
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(operation.clone());
        self.submit(&mut operation, cancellation, deadline)?;
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(operation.clone());
        self.finish(&operation, cancellation, deadline)?;
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        Ok(())
    }
    pub(super) fn close(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let _content = self.content(cancellation, deadline)?;
        if self.process.is_stopped()? {
            self.closed.store(true, Ordering::Release);
            return Ok(());
        }
        if self
            .claim
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none()
        {
            let prepared = self.process.rpc(
                "owners.prepare",
                json!({"token":self.bootstrap,"ash_parent":true}),
                cancellation,
                deadline,
            )?;
            *self.claim.lock().unwrap_or_else(|e| e.into_inner()) = Some(prepared["claim"].clone());
        }
        let claim = self
            .claim
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| failed("missing managed owner"))?;
        // Closing the owner first fences a late, disconnected lifecycle request. It also
        // cancels accepted work without accidentally starting an intent just to clean it up.
        self.process.rpc(
            "owners.release",
            json!({"claim":claim}),
            cancellation,
            deadline,
        )?;
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(operation) = pending {
            loop {
                check(cancellation, deadline)?;
                let receipt = self.process.rpc(
                    "operations.lookup",
                    operation.envelope["token"].clone(),
                    cancellation,
                    deadline,
                )?;
                if receipt.is_null() {
                    break;
                }
                self.validate_receipt(&operation, &receipt)?;
                if matches!(
                    receipt["state"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                ) {
                    let path = self
                        .journal
                        .join(format!("{}.result.json", operation.sequence));
                    if !path.exists() {
                        persist(&path, &receipt)?;
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
        }
        loop {
            check(cancellation, deadline)?;
            match self.process.rpc(
                "views.detach",
                json!({"owner":self.owner()?,"lease":self.lease}),
                cancellation,
                deadline,
            ) {
                Ok(value)
                    if value["root_handles_released"] == true
                        || value["remaining_leases"].as_u64().is_some_and(|n| n > 0) =>
                {
                    break;
                }
                Ok(_) => std::thread::sleep(Duration::from_millis(25)),
                Err(Error::Management(error)) if error.reason_code == "lease-not-found" => break,
                Err(error) => return Err(error),
            }
        }
        self.holder.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.closed.store(true, Ordering::Release);
        // A new daemon instance uses fresh owners and tokens; terminal acknowledged intent
        // is no longer needed once every lease and root read has drained.
        std::fs::remove_dir_all(&self.journal)?;
        Ok(())
    }
    pub(super) fn retire(self: &Arc<Self>, lifetime: impl Send + 'static) {
        if self.retiring.swap(true, Ordering::AcqRel) {
            return;
        }
        let session = Arc::clone(self);
        std::thread::spawn(move || {
            let _lifetime = lifetime;
            let token = CancellationSource::new().token();
            if session
                .close(&token, Instant::now() + super::INDEX_TIMEOUT)
                .is_err()
            {
                while session.process.stop().is_err() {
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        });
    }
}

#[cfg(test)]
#[path = "managed_tests.rs"]
mod tests;

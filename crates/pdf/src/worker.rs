//! A bounded, process-isolated native document pool. Idle helpers are evictable;
//! the owning document's disk snapshot remains authoritative after eviction or failure.
use crate::EngineRequest;
use crate::EngineResult;
use crate::PdfError;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use sysinfo::Pid;
use sysinfo::ProcessRefreshKind;
use sysinfo::ProcessesToUpdate;
use sysinfo::System;

pub(super) type Handle = Arc<Mutex<Option<Worker>>>;
static WORKERS: Mutex<Vec<Weak<Mutex<Option<Worker>>>>> = Mutex::new(Vec::new());
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
const MAX_RETAINED_WORKER_BYTES: u64 = 96 * 1024 * 1024;

pub(super) fn handle() -> Result<Handle, PdfError> {
    let handle = Arc::new(Mutex::new(None));
    let mut workers = WORKERS.lock().map_err(failed)?;
    workers.retain(|worker| worker.strong_count() > 0);
    workers.push(Arc::downgrade(&handle));
    Ok(handle)
}

pub(super) fn run(
    handle: &Handle,
    executable: &Path,
    request: &EngineRequest,
    cancelled: &dyn Fn() -> bool,
) -> Result<EngineResult, PdfError> {
    if cancelled() {
        return Err(PdfError::Cancelled);
    }
    let mut worker = handle.lock().map_err(failed)?;
    if worker.is_none() {
        // Spawn and eviction share one gate. An operation holds its own handle lock,
        // so eviction can only touch idle native documents, never an in-flight edit.
        let mut workers = WORKERS.lock().map_err(failed)?;
        workers.retain(|worker| worker.strong_count() > 0);
        if ACTIVE.load(Ordering::Acquire) >= 2 {
            for candidate in workers.iter().filter_map(Weak::upgrade) {
                if let Ok(mut idle) = candidate.try_lock() {
                    if idle.take().is_some() {
                        break;
                    }
                }
            }
        }
        if ACTIVE.load(Ordering::Acquire) >= 2 {
            return Err(PdfError::Capacity);
        }
        *worker = Some(Worker::spawn(executable)?);
    }
    let active = worker.as_mut().ok_or(PdfError::Capacity)?;
    let result = active.request(request, cancelled);
    // Decoding a scan can leave PDFium and its allocator holding a large arena.
    // Cached page artifacts and the private source outlive the native worker.
    if result.is_err() || request.modified.is_some() || active.exceeds_retention_budget() {
        worker.take();
    }
    result
}

pub(super) fn release(handle: &Handle) {
    if let Ok(mut worker) = handle.lock() {
        worker.take();
    }
}

pub(super) struct Worker {
    child: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<Result<EngineResult, String>>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl Worker {
    fn exceeds_retention_budget(&self) -> bool {
        let pid = Pid::from_u32(self.child.id());
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        system
            .process(pid)
            .is_some_and(|process| process.memory() > MAX_RETAINED_WORKER_BYTES)
    }

    fn spawn(executable: &Path) -> Result<Self, PdfError> {
        let mut command = Command::new(executable);
        command
            .arg(crate::WORKER_ARGUMENT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Return large raster buffers once PDFium and the encoder release them.
        #[cfg(target_os = "macos")]
        command.env("MallocLargeCache", "0");
        let mut child = command.spawn().map_err(failed)?;
        let input = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (sender, replies) = mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut input = std::io::BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let result = input
                    .by_ref()
                    .take(4 * 1024 * 1024)
                    .read_until(b'\n', &mut bytes);
                if !matches!(result, Ok(length) if length > 0) {
                    break;
                }
                let result = if bytes.last() == Some(&b'\n') {
                    serde_json::from_slice::<Result<EngineResult, String>>(&bytes)
                        .unwrap_or_else(|error| Err(error.to_string()))
                } else {
                    Err("PDF worker reply exceeds output budget".into())
                };
                if sender.send(result).is_err() {
                    break;
                }
            }
        });
        ACTIVE.fetch_add(1, Ordering::AcqRel);
        Ok(Self {
            child,
            input,
            replies,
            reader: Some(reader),
        })
    }

    fn request(
        &mut self,
        request: &EngineRequest,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<EngineResult, PdfError> {
        let mut bytes = serde_json::to_vec(request).map_err(failed)?;
        bytes.push(b'\n');
        if bytes.len() > 64 * 1024 {
            return Err(PdfError::Invalid);
        }
        self.input.write_all(&bytes).map_err(failed)?;
        self.input.flush().map_err(failed)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if cancelled() {
                return Err(PdfError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(PdfError::Failed("PDF operation timed out".into()));
            }
            match self.replies.recv_timeout(Duration::from_millis(10)) {
                Ok(result) => return result.map_err(PdfError::Failed),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(PdfError::Failed("Could not process this PDF".into()));
                }
            }
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

fn failed(error: impl std::fmt::Display) -> PdfError {
    PdfError::Failed(error.to_string())
}

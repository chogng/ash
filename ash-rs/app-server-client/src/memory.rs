use crate::AppServerRequestHandle;
use ash_app_server_protocol::protocol::memory_diagnostics::MemoryDiagnosticsSessionParams;
use ash_memory_diagnostics::MemoryEvidence;
use ash_memory_diagnostics::MemoryMetric;
use ash_memory_diagnostics::MemoryProduct;
use ash_memory_diagnostics::MemoryReport;
use ash_memory_diagnostics::MemoryRole;
use ash_memory_diagnostics::MemoryStart;
use ash_memory_diagnostics::MemoryStatus;
use ash_memory_diagnostics::ProcessResourceMetrics;
use ash_memory_diagnostics::ProcessResourceTargets;
use ash_memory_diagnostics::ProcessResourcesSampler;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;

/// Runs only the client-host evidence collector; the server owns recording and analysis.
pub struct MemoryRecording {
    id: String,
    client: AppServerRequestHandle,
    control: Arc<(Mutex<bool>, Condvar)>,
    report: Arc<Mutex<Result<MemoryReport, String>>>,
    worker: Option<JoinHandle<()>>,
}

impl MemoryRecording {
    /// Starts on a request worker, never on a UI event loop.
    pub fn start(
        mut client: AppServerRequestHandle,
        product: MemoryProduct,
        request_id: String,
        metrics: impl Fn() -> Vec<MemoryMetric> + Send + 'static,
    ) -> Result<Self, String> {
        let report = client
            .start_memory_diagnostics(MemoryStart {
                request_id,
                product,
                duration_secs: 1800,
            })
            .map_err(|error| error.to_string())?;
        let id = report.session_id.clone();
        let control = Arc::new((Mutex::new(false), Condvar::new()));
        let snapshot = Arc::new(Mutex::new(Ok(report.clone())));
        let in_process = client.transport.in_process;
        let mut worker_client = client.clone();
        let worker_control = Arc::clone(&control);
        let worker_snapshot = Arc::clone(&snapshot);
        let worker_id = id.clone();
        let spawned = std::thread::Builder::new()
            .name("ash-memory-evidence".into())
            .spawn(move || {
                let role = match product {
                    MemoryProduct::Tui => MemoryRole::Tui,
                    MemoryProduct::RustGui => MemoryRole::RustGui,
                    MemoryProduct::Electron | MemoryProduct::Browser => MemoryRole::Renderer,
                };
                let mut sampler = ProcessResourcesSampler::new(
                    ProcessResourceTargets::Current,
                    ProcessResourceMetrics::Memory,
                    0,
                );
                let mut sequence = 0;
                let mut embedded_observations = None;
                loop {
                    if *worker_control.0.lock().unwrap() {
                        break;
                    }
                    let current = worker_client
                        .read_memory_diagnostics(MemoryDiagnosticsSessionParams {
                            session_id: worker_id.clone(),
                        })
                        .map_err(|error| error.to_string());
                    if !current
                        .as_ref()
                        .is_ok_and(|report| report.status == MemoryStatus::Recording)
                    {
                        *worker_snapshot.lock().unwrap() = current;
                        break;
                    }
                    let mut observations = if in_process {
                        embedded_observations
                            .get_or_insert_with(|| {
                                let mut observations = sampler.memory_observations(role);
                                for observation in &mut observations {
                                    observation.metrics.clear();
                                }
                                observations
                            })
                            .clone()
                    } else {
                        sampler.memory_observations(role)
                    };
                    if let Some(observation) = observations.first_mut() {
                        observation.metrics.extend(metrics());
                    }
                    sequence += 1;
                    let result = (|| {
                        if !observations.is_empty() {
                            worker_client.submit_memory_diagnostics(MemoryEvidence {
                                session_id: worker_id.clone(),
                                sequence,
                                observations,
                            })?;
                        }
                        worker_client.read_memory_diagnostics(MemoryDiagnosticsSessionParams {
                            session_id: worker_id.clone(),
                        })
                    })()
                    .map_err(|error| error.to_string());
                    let finished = result
                        .as_ref()
                        .map_or(true, |report| report.status != MemoryStatus::Recording);
                    *worker_snapshot.lock().unwrap() = result;
                    if finished {
                        break;
                    }
                    let stopped = worker_control.0.lock().unwrap();
                    let _ = worker_control
                        .1
                        .wait_timeout_while(
                            stopped,
                            Duration::from_millis(u64::from(report.sample_interval_ms)),
                            |stopped| !*stopped,
                        )
                        .unwrap();
                }
                // A canceled product operation may discard the handle while its connection lives.
                // Release the backend resource on the collector worker, including on Drop.
                if let Ok(report) =
                    worker_client.stop_memory_diagnostics(MemoryDiagnosticsSessionParams {
                        session_id: worker_id,
                    })
                {
                    let mut snapshot = worker_snapshot.lock().unwrap();
                    if snapshot.is_ok() {
                        *snapshot = Ok(report);
                    }
                }
            });
        let worker = match spawned {
            Ok(worker) => worker,
            Err(error) => {
                let _ = client
                    .stop_memory_diagnostics(MemoryDiagnosticsSessionParams { session_id: id });
                return Err(error.to_string());
            }
        };
        Ok(Self {
            id,
            client,
            control,
            report: snapshot,
            worker: Some(worker),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.id
    }

    pub fn report(&self) -> Result<MemoryReport, String> {
        self.report.lock().unwrap().clone()
    }

    pub fn status(&self) -> Result<MemoryStatus, String> {
        match &*self.report.lock().unwrap() {
            Ok(report) => Ok(report.status),
            Err(error) => Err(error.clone()),
        }
    }

    /// Must be called on a request worker; the returned report remains readable after stopping.
    pub fn stop(&mut self) -> Result<MemoryReport, String> {
        self.stop_collector();
        let result = self
            .client
            .stop_memory_diagnostics(MemoryDiagnosticsSessionParams {
                session_id: self.id.clone(),
            })
            .map_err(|error| error.to_string());
        *self.report.lock().unwrap() = result.clone();
        result
    }

    fn stop_collector(&mut self) {
        *self.control.0.lock().unwrap() = true;
        self.control.1.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for MemoryRecording {
    fn drop(&mut self) {
        self.stop_collector();
        // Connection shutdown owns backend cleanup; dropping a local collector does not issue IO.
    }
}

use crate::ProcessResourceMetrics;
use crate::ProcessResourceTargets;
use crate::ProcessResourcesSampler;
use crate::types::*;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const INTERVAL: Duration = Duration::from_secs(5);
const MAX_SESSIONS: usize = 8;
const MAX_TARGETS: usize = 32;
const MAX_SAMPLES: usize = 360;
const RETENTION: Duration = Duration::from_secs(600);

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum MemoryDiagnosticsError {
    #[error("invalid memory diagnostic input")]
    Invalid,
    #[error("memory diagnostic capacity reached")]
    Capacity,
    #[error("memory diagnostic not found on this connection")]
    NotFound,
    #[error("memory diagnostic request conflicts with current recording")]
    Conflict,
    #[error("memory diagnostic is no longer recording")]
    Stopped,
    #[error("memory diagnostic evidence is stale")]
    Stale,
    #[error("memory diagnostic worker could not start")]
    Unavailable,
}

/// Owns one shared sampler and bounded recording state. Dropping the service joins its worker.
pub struct MemoryDiagnostics {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    shutdown: bool,
    next_id: u64,
    sessions: BTreeMap<String, Session>,
}

struct Session {
    owner: u64,
    request: MemoryStart,
    id: String,
    started: Instant,
    started_at_ms: u64,
    ended: Option<Instant>,
    status: MemoryStatus,
    sequence: u64,
    gaps: u32,
    targets: Vec<Target>,
}

struct Target {
    origin: MemoryOrigin,
    instance_id: String,
    process_id: Option<u32>,
    role: MemoryRole,
    discarded: u32,
    samples: VecDeque<MemorySample>,
}

impl Default for MemoryDiagnostics {
    fn default() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
            }),
            worker: Mutex::new(None),
        }
    }
}

impl MemoryDiagnostics {
    pub fn start(
        &self,
        owner: u64,
        request: MemoryStart,
    ) -> Result<MemoryReport, MemoryDiagnosticsError> {
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || !(10..=1800).contains(&request.duration_secs)
        {
            return Err(MemoryDiagnosticsError::Invalid);
        }
        let mut state = self.shared.state.lock().unwrap();
        state.prune(Instant::now());
        if let Some(session) = state.sessions.values().find(|session| {
            session.owner == owner && session.request.request_id == request.request_id
        }) {
            return if session.request == request {
                Ok(session.report())
            } else {
                Err(MemoryDiagnosticsError::Conflict)
            };
        }
        if state
            .sessions
            .values()
            .any(|session| session.owner == owner && session.status == MemoryStatus::Recording)
        {
            return Err(MemoryDiagnosticsError::Conflict);
        }
        if state.sessions.len() == MAX_SESSIONS {
            return Err(MemoryDiagnosticsError::Capacity);
        }
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| MemoryDiagnosticsError::Unavailable)?
            .as_millis() as u64;
        let mut worker = self.worker.lock().unwrap();
        if worker.is_none() {
            let shared = Arc::clone(&self.shared);
            *worker = Some(
                std::thread::Builder::new()
                    .name("ash-memory-diagnostics".into())
                    .spawn(move || run(shared))
                    .map_err(|_| MemoryDiagnosticsError::Unavailable)?,
            );
        }
        state.next_id += 1;
        let id = format!("memory-{}", state.next_id);
        let session = Session {
            owner,
            request,
            id: id.clone(),
            started: Instant::now(),
            started_at_ms,
            ended: None,
            status: MemoryStatus::Recording,
            sequence: 0,
            gaps: 0,
            targets: Vec::new(),
        };
        let report = session.report();
        state.sessions.insert(id, session);
        self.shared.changed.notify_all();
        Ok(report)
    }

    pub fn read(&self, owner: u64, id: &str) -> Result<MemoryReport, MemoryDiagnosticsError> {
        let mut state = self.shared.state.lock().unwrap();
        state.prune(Instant::now());
        Ok(state.owned(owner, id)?.report())
    }

    pub fn stop(&self, owner: u64, id: &str) -> Result<MemoryReport, MemoryDiagnosticsError> {
        let mut state = self.shared.state.lock().unwrap();
        let session = state.owned(owner, id)?;
        session.finish(MemoryStatus::Stopped, Instant::now());
        let report = session.report();
        self.shared.changed.notify_all();
        Ok(report)
    }

    pub fn submit(
        &self,
        owner: u64,
        evidence: MemoryEvidence,
    ) -> Result<(), MemoryDiagnosticsError> {
        if evidence.observations.is_empty()
            || evidence.observations.len() > MAX_TARGETS
            || evidence.sequence == 0
            || evidence.sequence > 9_007_199_254_740_991
        {
            return Err(MemoryDiagnosticsError::Invalid);
        }
        let mut identities = BTreeSet::new();
        for observation in &evidence.observations {
            if observation.instance_id.is_empty()
                || observation.instance_id.len() > 128
                || !identities.insert(&observation.instance_id)
                || observation.metrics.is_empty()
                || observation.metrics.len() > 11
            {
                return Err(MemoryDiagnosticsError::Invalid);
            }
            let mut metrics = BTreeSet::new();
            for metric in &observation.metrics {
                if !metrics.insert(metric.kind)
                    || metric.value.is_some() == metric.unavailable.is_some()
                    || metric
                        .value
                        .is_some_and(|value| value > 9_007_199_254_740_991)
                {
                    return Err(MemoryDiagnosticsError::Invalid);
                }
            }
        }
        let mut state = self.shared.state.lock().unwrap();
        let now = Instant::now();
        state.prune(now);
        let session = state.owned(owner, &evidence.session_id)?;
        if session.status != MemoryStatus::Recording {
            return Err(MemoryDiagnosticsError::Stopped);
        }
        if evidence.sequence <= session.sequence {
            return Err(MemoryDiagnosticsError::Stale);
        }
        // Validate the complete batch before changing any state.
        let mut new_targets = 0;
        for observation in &evidence.observations {
            if let Some(target) = session.targets.iter().find(|target| {
                target.origin == MemoryOrigin::ClientHost
                    && target.instance_id == observation.instance_id
            }) {
                if target.process_id != observation.process_id || target.role != observation.role {
                    return Err(MemoryDiagnosticsError::Conflict);
                }
            } else {
                new_targets += 1;
            }
        }
        if session.targets.len() + new_targets > MAX_TARGETS {
            return Err(MemoryDiagnosticsError::Capacity);
        }
        if evidence.sequence != session.sequence + 1 {
            session.gaps = session.gaps.saturating_add(1);
        }
        session.sequence = evidence.sequence;
        session.record(MemoryOrigin::ClientHost, evidence.observations, now);
        Ok(())
    }

    /// Returns a versioned report and its bounded raw samples; the host owns file delivery.
    pub fn export(&self, owner: u64, id: &str) -> Result<Vec<u8>, MemoryDiagnosticsError> {
        let mut state = self.shared.state.lock().unwrap();
        let session = state.owned(owner, id)?;
        let samples: Vec<_> = session.targets.iter().map(|target| serde_json::json!({
            "origin": target.origin, "instanceId": target.instance_id, "samples": target.samples,
        })).collect();
        serde_json::to_vec(&serde_json::json!({ "report": session.report(), "series": samples }))
            .map_err(|_| MemoryDiagnosticsError::Unavailable)
    }

    pub fn close_owner(&self, owner: u64) {
        self.shared
            .state
            .lock()
            .unwrap()
            .sessions
            .retain(|_, session| session.owner != owner);
        self.shared.changed.notify_all();
    }
}

impl Drop for MemoryDiagnostics {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().shutdown = true;
        self.shared.changed.notify_all();
        if let Some(worker) = self.worker.get_mut().unwrap().take() {
            let _ = worker.join();
        }
    }
}

impl State {
    fn owned(&mut self, owner: u64, id: &str) -> Result<&mut Session, MemoryDiagnosticsError> {
        self.sessions
            .get_mut(id)
            .filter(|session| session.owner == owner)
            .ok_or(MemoryDiagnosticsError::NotFound)
    }

    fn retention_delay(&self, now: Instant) -> Duration {
        self.sessions
            .values()
            .map(|session| {
                (session.ended.expect("finished recordings have an end time") + RETENTION)
                    .saturating_duration_since(now)
            })
            .min()
            .expect("retained recordings are not empty")
    }

    fn prune(&mut self, now: Instant) {
        for session in self.sessions.values_mut() {
            if now.duration_since(session.started)
                >= Duration::from_secs(u64::from(session.request.duration_secs))
            {
                session.finish(MemoryStatus::BudgetExpired, now);
            }
        }
        self.sessions.retain(|_, session| {
            session
                .ended
                .is_none_or(|ended| now.duration_since(ended) < RETENTION)
        });
    }
}

impl Session {
    fn finish(&mut self, status: MemoryStatus, now: Instant) {
        if self.status == MemoryStatus::Recording {
            self.status = status;
            self.ended = Some(now);
        }
    }

    fn record(&mut self, origin: MemoryOrigin, observations: Vec<MemoryObservation>, now: Instant) {
        let elapsed_ms = now.duration_since(self.started).as_millis() as u64;
        for target in self
            .targets
            .iter_mut()
            .filter(|target| target.origin == origin && observations.len() <= MAX_TARGETS)
        {
            if !observations
                .iter()
                .any(|observation| observation.instance_id == target.instance_id)
            {
                let latest = target
                    .samples
                    .back()
                    .expect("registered targets have samples");
                if latest
                    .metrics
                    .iter()
                    .all(|metric| metric.unavailable == Some(MemoryUnavailable::Exited))
                {
                    continue;
                }
                let metrics = latest
                    .metrics
                    .iter()
                    .map(|metric| MemoryMetric {
                        kind: metric.kind,
                        value: None,
                        unavailable: Some(MemoryUnavailable::Exited),
                    })
                    .collect();
                if target.samples.len() == MAX_SAMPLES {
                    target.samples.pop_front();
                    target.discarded = target.discarded.saturating_add(1);
                }
                target.samples.push_back(MemorySample {
                    elapsed_ms,
                    phase: MemoryPhase::Unknown,
                    metrics,
                });
            }
        }
        for observation in observations {
            let index = self.targets.iter().position(|target| {
                target.origin == origin && target.instance_id == observation.instance_id
            });
            let index = match index {
                Some(index) => index,
                None if self.targets.len() < MAX_TARGETS => {
                    self.targets.push(Target {
                        origin,
                        instance_id: observation.instance_id,
                        process_id: observation.process_id,
                        role: observation.role,
                        discarded: 0,
                        samples: VecDeque::new(),
                    });
                    self.targets.len() - 1
                }
                None => {
                    self.gaps = self.gaps.saturating_add(1);
                    continue;
                }
            };
            let target = &mut self.targets[index];
            if target.samples.len() == MAX_SAMPLES {
                target.samples.pop_front();
                target.discarded = target.discarded.saturating_add(1);
            }
            target.samples.push_back(MemorySample {
                elapsed_ms: now.duration_since(self.started).as_millis() as u64,
                phase: observation.phase,
                metrics: observation.metrics,
            });
        }
    }

    fn report(&self) -> MemoryReport {
        let elapsed_ms = self
            .ended
            .unwrap_or_else(Instant::now)
            .duration_since(self.started)
            .as_millis() as u64;
        let stale_targets = self
            .targets
            .iter()
            .filter(|target| {
                target.samples.back().is_some_and(|sample| {
                    sample.metrics.iter().any(|metric| metric.value.is_some())
                        && elapsed_ms.saturating_sub(sample.elapsed_ms)
                            > INTERVAL.as_millis() as u64 * 3
                })
            })
            .count() as u32;
        let evidence_gaps = self.gaps.saturating_add(stale_targets);
        MemoryReport {
            version: 1,
            session_id: self.id.clone(),
            product: self.request.product,
            status: self.status,
            started_at_ms: self.started_at_ms,
            elapsed_ms,
            sample_interval_ms: INTERVAL.as_millis() as u32,
            evidence_gaps,
            targets: self
                .targets
                .iter()
                .map(|target| {
                    let latest = target
                        .samples
                        .back()
                        .expect("registered targets have samples")
                        .clone();
                    let kinds: BTreeSet<_> = target
                        .samples
                        .iter()
                        .flat_map(|sample| sample.metrics.iter().map(|metric| metric.kind))
                        .collect();
                    MemoryTargetReport {
                        origin: target.origin,
                        instance_id: target.instance_id.clone(),
                        process_id: target.process_id,
                        role: target.role,
                        samples: target.samples.len() as u32,
                        discarded_samples: target.discarded,
                        latest,
                        trends: kinds
                            .into_iter()
                            .map(|kind| trend(&target.samples, kind, evidence_gaps))
                            .collect(),
                    }
                })
                .collect(),
        }
    }
}

fn trend(samples: &VecDeque<MemorySample>, kind: MemoryMetricKind, gaps: u32) -> MemoryTrend {
    let points: Vec<_> = samples
        .iter()
        .filter_map(|sample| {
            sample
                .metrics
                .iter()
                .find(|metric| metric.kind == kind)
                .and_then(|metric| metric.value)
                .map(|value| {
                    (
                        sample.elapsed_ms as f64 / 1000.0,
                        value as f64,
                        sample.phase,
                    )
                })
        })
        .collect();
    let span = points
        .first()
        .zip(points.last())
        .map_or(0.0, |(first, last)| last.0 - first.0);
    let mut result = MemoryTrend {
        kind,
        finding: MemoryFinding::InsufficientEvidence,
        samples: points.len() as u32,
        span_secs: span,
        growth_per_second: None,
    };
    if points.len() < 12
        || span < 600.0
        || gaps > 0
        || points.len() != samples.len()
        || points
            .windows(2)
            .any(|pair| pair[1].0 - pair[0].0 > INTERVAL.as_secs_f64() * 3.0)
    {
        return result;
    }
    let n = points.len() as f64;
    let x = points.iter().map(|point| point.0).sum::<f64>() / n;
    let y = points.iter().map(|point| point.1).sum::<f64>() / n;
    let variance = points
        .iter()
        .map(|point| (point.0 - x).powi(2))
        .sum::<f64>();
    if variance == 0.0 {
        return result;
    }
    let slope = points
        .iter()
        .map(|point| (point.0 - x) * (point.1 - y))
        .sum::<f64>()
        / variance;
    result.growth_per_second = Some(slope);
    // Require growth in each chronological third; one cache warm-up is insufficient.
    let sustained = points
        .chunks(points.len().div_ceil(3))
        .all(|chunk| chunk.len() >= 2 && chunk.last().unwrap().1 > chunk.first().unwrap().1);
    result.finding = if slope > 0.0 && sustained {
        if points.iter().all(|point| point.2 == MemoryPhase::Idle) {
            MemoryFinding::IdleBaselineGrowth
        } else {
            MemoryFinding::SustainedGrowth
        }
    } else {
        MemoryFinding::NoSustainedGrowthObserved
    };
    result
}

fn run(shared: Arc<Shared>) {
    let mut sampler = None;
    let mut state = shared.state.lock().unwrap();
    loop {
        state.prune(Instant::now());
        if state.shutdown {
            return;
        }
        if !state
            .sessions
            .values()
            .any(|session| session.status == MemoryStatus::Recording)
        {
            sampler = None;
            if state.sessions.is_empty() {
                state = shared.changed.wait(state).unwrap();
            } else {
                let delay = state.retention_delay(Instant::now());
                state = shared.changed.wait_timeout(state, delay).unwrap().0;
            }
            continue;
        }
        drop(state);
        let observations = sampler
            .get_or_insert_with(|| {
                ProcessResourcesSampler::new(
                    ProcessResourceTargets::CurrentAndTree(std::process::id()),
                    ProcessResourceMetrics::Memory,
                    0,
                )
            })
            .memory_observations(MemoryRole::Backend);
        state = shared.state.lock().unwrap();
        let now = Instant::now();
        state.prune(now);
        for session in state
            .sessions
            .values_mut()
            .filter(|session| session.status == MemoryStatus::Recording)
        {
            if observations.is_empty() {
                session.gaps = session.gaps.saturating_add(1);
            }
            session.record(MemoryOrigin::BackendHost, observations.clone(), now);
        }
        state = shared.changed.wait_timeout(state, INTERVAL).unwrap().0;
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

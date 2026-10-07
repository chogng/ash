use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;
use sysinfo::Pid;
use sysinfo::ProcessRefreshKind;
use sysinfo::ProcessesToUpdate;
use sysinfo::System;
use sysinfo::get_current_pid;

const SUMMARY_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const DETAIL_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
struct ProcessResourceSampleIntervals {
    summary: Duration,
    detail: Duration,
}

impl Default for ProcessResourceSampleIntervals {
    fn default() -> Self {
        Self {
            summary: SUMMARY_SAMPLE_INTERVAL,
            detail: DETAIL_SAMPLE_INTERVAL,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessResourceTargets {
    Current,
    CurrentAndTree(u32),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessResourceMetrics {
    Memory,
    Cpu,
    MemoryAndCpu,
}

impl ProcessResourceMetrics {
    pub const fn includes_memory(self) -> bool {
        matches!(self, Self::Memory | Self::MemoryAndCpu)
    }

    pub const fn includes_cpu(self) -> bool {
        matches!(self, Self::Cpu | Self::MemoryAndCpu)
    }

    pub const fn union(self, other: Self) -> Self {
        match (self, other) {
            (Self::Memory, Self::Memory) => Self::Memory,
            (Self::Cpu, Self::Cpu) => Self::Cpu,
            _ => Self::MemoryAndCpu,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessResourceDemand {
    #[default]
    Disabled,
    Summary(ProcessResourceMetrics),
    Detailed,
}

impl ProcessResourceDemand {
    pub const fn metrics(self) -> Option<ProcessResourceMetrics> {
        match self {
            Self::Disabled => None,
            Self::Summary(metrics) => Some(metrics),
            Self::Detailed => Some(ProcessResourceMetrics::MemoryAndCpu),
        }
    }

    const fn sample_interval(self, intervals: ProcessResourceSampleIntervals) -> Option<Duration> {
        match self {
            Self::Disabled => None,
            Self::Summary(_) => Some(intervals.summary),
            Self::Detailed => Some(intervals.detail),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ProcessResourceRequest {
    pub revision: u64,
    pub cpu_cycle: u64,
    pub demand: ProcessResourceDemand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessResourceUsage {
    pub resident_bytes: Option<u64>,
    pub cpu_tenths_percent: Option<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedProcess {
    pub process_id: u32,
    pub depth: usize,
    pub name: String,
    pub usage: Result<ProcessResourceUsage, String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessTreeResourceUsage {
    pub root: ProcessResourceUsage,
    pub descendants: Vec<ObservedProcess>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessResourcesReading {
    pub request: ProcessResourceRequest,
    pub current: Result<ProcessResourceUsage, String>,
    pub tree: Option<Result<ProcessTreeResourceUsage, String>>,
    pub sampled_at: Instant,
}

pub struct ProcessResourcesSource {
    stop: Arc<AtomicBool>,
    control: Arc<ProcessResourcesControl>,
    task: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct ProcessResourcesControl {
    request: Mutex<ProcessResourceRequest>,
    changed: Condvar,
}

impl ProcessResourcesSource {
    pub fn start(
        stop: Arc<AtomicBool>,
        targets: ProcessResourceTargets,
        emit: impl FnMut(ProcessResourcesReading) -> bool + Send + 'static,
    ) -> Result<Self, io::Error> {
        Self::start_with_intervals(
            stop,
            targets,
            ProcessResourceSampleIntervals::default(),
            emit,
        )
    }

    fn start_with_intervals(
        stop: Arc<AtomicBool>,
        targets: ProcessResourceTargets,
        intervals: ProcessResourceSampleIntervals,
        mut emit: impl FnMut(ProcessResourcesReading) -> bool + Send + 'static,
    ) -> Result<Self, io::Error> {
        let task_stop = Arc::clone(&stop);
        let control = Arc::new(ProcessResourcesControl::default());
        let task_control = Arc::clone(&control);
        let task = thread::Builder::new()
            .name("ash-process-resources".into())
            .spawn(move || {
                let mut sampler = None;
                loop {
                    let request = {
                        let mut request = task_control.request.lock().unwrap();
                        while matches!(request.demand, ProcessResourceDemand::Disabled)
                            && !task_stop.load(Ordering::Acquire)
                        {
                            sampler = None;
                            request = task_control.changed.wait(request).unwrap();
                        }
                        if task_stop.load(Ordering::Acquire) {
                            return;
                        }
                        *request
                    };
                    let metrics = request
                        .demand
                        .metrics()
                        .expect("an active resource demand has metrics");
                    let sampler = sampler.get_or_insert_with(|| {
                        ProcessResourcesSampler::new(targets, metrics, request.cpu_cycle)
                    });
                    sampler.set_request(request);
                    let reading = sampler.sample(request, Instant::now());
                    if !emit(reading) {
                        return;
                    }
                    let interval = request
                        .demand
                        .sample_interval(intervals)
                        .expect("an active resource demand has an interval");
                    let current = task_control.request.lock().unwrap();
                    let _ = task_control
                        .changed
                        .wait_timeout_while(current, interval, |current| {
                            *current == request && !task_stop.load(Ordering::Acquire)
                        })
                        .unwrap();
                }
            })?;
        Ok(Self {
            stop,
            control,
            task: Some(task),
        })
    }

    pub fn set_request(&self, request: ProcessResourceRequest) {
        let mut current = self.control.request.lock().unwrap();
        if *current == request {
            return;
        }
        *current = request;
        self.control.changed.notify_one();
    }

    pub fn join(&mut self) -> Result<(), io::Error> {
        self.stop.store(true, Ordering::Release);
        let Some(task) = self.task.take() else {
            return Ok(());
        };
        self.control.changed.notify_one();
        task.join()
            .map_err(|_| io::Error::other("process resource source panicked"))
    }
}

impl Drop for ProcessResourcesSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.join();
    }
}

pub struct ProcessResourcesSampler {
    state: Result<SamplerState, String>,
    targets: ProcessResourceTargets,
    metrics: ProcessResourceMetrics,
    cpu_cycle: u64,
}

struct SamplerState {
    system: System,
    current_pid: Pid,
    tree_pid: Option<Pid>,
    logical_processors: usize,
    cpu_ready: bool,
}

impl ProcessResourcesSampler {
    pub fn new(
        targets: ProcessResourceTargets,
        metrics: ProcessResourceMetrics,
        cpu_cycle: u64,
    ) -> Self {
        let state = if sysinfo::IS_SUPPORTED_SYSTEM {
            get_current_pid()
                .map(|current_pid| SamplerState {
                    system: System::new(),
                    current_pid,
                    tree_pid: match targets {
                        ProcessResourceTargets::Current => None,
                        ProcessResourceTargets::CurrentAndTree(process_id) => {
                            Some(Pid::from_u32(process_id))
                        }
                    },
                    logical_processors: thread::available_parallelism()
                        .map(usize::from)
                        .unwrap_or(1),
                    cpu_ready: false,
                })
                .map_err(|error| format!("could not identify the Current process process: {error}"))
        } else {
            Err("process resources are unavailable on this operating system".into())
        };
        Self {
            state,
            targets,
            metrics,
            cpu_cycle,
        }
    }

    /// Reads memory evidence for the current process and its owned descendants.
    /// Process start time separates reused operating-system process identifiers.
    pub fn memory_observations(
        &mut self,
        role: crate::MemoryRole,
    ) -> Vec<crate::MemoryObservation> {
        let request = ProcessResourceRequest {
            revision: 0,
            cpu_cycle: 0,
            demand: ProcessResourceDemand::Detailed,
        };
        let _ = self.sample(request, Instant::now());
        let Ok(state) = &self.state else {
            return vec![crate::MemoryObservation {
                instance_id: format!("{}:unavailable", std::process::id()),
                process_id: Some(std::process::id()),
                role,
                phase: crate::MemoryPhase::Unknown,
                metrics: vec![crate::MemoryMetric {
                    kind: crate::MemoryMetricKind::ResidentBytes,
                    value: None,
                    unavailable: Some(if sysinfo::IS_SUPPORTED_SYSTEM {
                        crate::MemoryUnavailable::ReadFailed
                    } else {
                        crate::MemoryUnavailable::Unsupported
                    }),
                }],
            }];
        };
        let root = state.current_pid;
        let mut pids = vec![root];
        if let Some(tree) = state.tree_pid {
            if tree != root {
                pids.push(tree);
            }
            pids.extend(
                descendant_processes(&state.system, tree)
                    .into_iter()
                    .map(|(pid, _)| pid),
            );
        }
        pids.sort();
        pids.dedup();
        pids.into_iter()
            .take(33)
            .filter_map(|pid| {
                let process = state.system.process(pid)?;
                Some(crate::MemoryObservation {
                    instance_id: format!("{}:{}", pid.as_u32(), process.start_time()),
                    process_id: Some(pid.as_u32()),
                    role: if pid == root {
                        role
                    } else {
                        crate::MemoryRole::Tool
                    },
                    phase: crate::MemoryPhase::Unknown,
                    metrics: vec![crate::MemoryMetric {
                        kind: crate::MemoryMetricKind::ResidentBytes,
                        value: Some(process.memory()),
                        unavailable: None,
                    }],
                })
            })
            .collect()
    }

    fn set_request(&mut self, request: ProcessResourceRequest) {
        let metrics = request
            .demand
            .metrics()
            .expect("an active resource demand has metrics");
        if self.cpu_cycle != request.cpu_cycle
            || !self.metrics.includes_cpu()
            || !metrics.includes_cpu()
        {
            if let Ok(state) = self.state.as_mut() {
                state.cpu_ready = false;
            }
        }
        self.metrics = metrics;
        self.cpu_cycle = request.cpu_cycle;
    }

    pub fn sample(
        &mut self,
        request: ProcessResourceRequest,
        sampled_at: Instant,
    ) -> ProcessResourcesReading {
        let state = match self.state.as_mut() {
            Ok(state) => state,
            Err(error) => {
                return ProcessResourcesReading {
                    request,
                    current: Err(error.clone()),
                    tree: matches!(self.targets, ProcessResourceTargets::CurrentAndTree(_))
                        .then(|| Err(error.clone())),
                    sampled_at,
                };
            }
        };
        let mut refresh = ProcessRefreshKind::nothing().without_tasks();
        if self.metrics.includes_memory() {
            refresh = refresh.with_memory();
        }
        if self.metrics.includes_cpu() {
            refresh = refresh.with_cpu();
        }
        match state.tree_pid {
            Some(_) => {
                state
                    .system
                    .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
            }
            None => {
                state.system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[state.current_pid]),
                    true,
                    refresh,
                );
            }
        }
        let current = process_usage(
            &state.system,
            state.current_pid,
            "Current process",
            self.metrics,
            state.cpu_ready,
            state.logical_processors,
        );
        let tree = state.tree_pid.map(|pid| {
            let root = process_usage(
                &state.system,
                pid,
                "Process tree",
                self.metrics,
                state.cpu_ready,
                state.logical_processors,
            )?;
            let descendants = descendant_processes(&state.system, pid)
                .into_iter()
                .map(|(process_id, depth)| {
                    let name = process_name(&state.system, process_id);
                    ObservedProcess {
                        process_id: process_id.as_u32(),
                        depth,
                        usage: process_usage(
                            &state.system,
                            process_id,
                            &name,
                            self.metrics,
                            state.cpu_ready,
                            state.logical_processors,
                        ),
                        name,
                    }
                })
                .collect();
            Ok(ProcessTreeResourceUsage { root, descendants })
        });
        state.cpu_ready = self.metrics.includes_cpu();
        ProcessResourcesReading {
            request,
            current,
            tree,
            sampled_at,
        }
    }
}

fn descendant_processes(system: &System, root: Pid) -> Vec<(Pid, usize)> {
    let mut children = HashMap::<Pid, Vec<Pid>>::new();
    for (process_id, process) in system.processes() {
        if let Some(parent_process_id) = process.parent() {
            children
                .entry(parent_process_id)
                .or_default()
                .push(*process_id);
        }
    }
    for process_ids in children.values_mut() {
        process_ids.sort_by_key(|process_id| {
            (
                process_name(system, *process_id).to_lowercase(),
                process_id.as_u32(),
            )
        });
    }

    let mut descendants = Vec::new();
    let mut visited = HashSet::from([root]);
    append_descendants(root, 1, &children, &mut visited, &mut descendants);
    descendants
}

fn append_descendants(
    parent: Pid,
    depth: usize,
    children: &HashMap<Pid, Vec<Pid>>,
    visited: &mut HashSet<Pid>,
    descendants: &mut Vec<(Pid, usize)>,
) {
    let Some(process_ids) = children.get(&parent) else {
        return;
    };
    for process_id in process_ids {
        if !visited.insert(*process_id) {
            continue;
        }
        descendants.push((*process_id, depth));
        append_descendants(
            *process_id,
            depth.saturating_add(1),
            children,
            visited,
            descendants,
        );
    }
}

fn process_name(system: &System, pid: Pid) -> String {
    let fallback = || format!("process {}", pid.as_u32());
    let Some(process) = system.process(pid) else {
        return fallback();
    };
    let name = process
        .name()
        .to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_control() {
                '�'
            } else {
                character
            }
        })
        .collect::<String>();
    if name.trim().is_empty() {
        fallback()
    } else {
        name
    }
}

fn process_usage(
    system: &System,
    pid: Pid,
    label: &str,
    metrics: ProcessResourceMetrics,
    cpu_ready: bool,
    logical_processors: usize,
) -> Result<ProcessResourceUsage, String> {
    let process = system
        .process(pid)
        .ok_or_else(|| format!("{label} process resources are unavailable"))?;
    let resident_bytes = if metrics.includes_memory() {
        let resident_bytes = process.memory();
        if resident_bytes == 0 {
            return Err(format!("{label} resident memory is unavailable"));
        }
        Some(resident_bytes)
    } else {
        None
    };
    let cpu_tenths_percent = (metrics.includes_cpu() && cpu_ready).then(|| {
        let normalized = process.cpu_usage() / logical_processors.max(1) as f32;
        (normalized.clamp(0.0, 100.0) * 10.0).round() as u16
    });
    Ok(ProcessResourceUsage {
        resident_bytes,
        cpu_tenths_percent,
    })
}

#[cfg(test)]
#[path = "process_resources_tests.rs"]
mod tests;

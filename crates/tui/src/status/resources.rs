use crate::AppServerProcess;
use ash_memory_diagnostics::ProcessResourceMetrics;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_memory_diagnostics::ProcessResourceUsage;
use ash_memory_diagnostics::ProcessResourcesReading;
use ash_memory_diagnostics::ProcessTreeResourceUsage;
const MEBIBYTE: u64 = 1024 * 1024;
const GIBIBYTE: u64 = 1024 * MEBIBYTE;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ProcessResourcesView {
    pub(crate) local: ProcessUsageView,
    pub(crate) tui: ProcessUsageView,
    pub(crate) app_server: AppServerResourcesView,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct AppServerProcessResourcesView {
    pub(crate) total: ProcessUsageView,
    pub(crate) process: ProcessUsageView,
    pub(crate) descendants: Vec<ObservedProcessResourcesView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ObservedProcessResourcesView {
    pub(crate) process_id: u32,
    pub(crate) depth: usize,
    pub(crate) name: String,
    pub(crate) usage: ProcessUsageView,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ProcessUsageView {
    pub(crate) memory: ProcessMemoryCurrent,
    pub(crate) cpu: ProcessCpuCurrent,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ProcessMemoryCurrent {
    #[default]
    Collecting,
    Available(u64),
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ProcessCpuCurrent {
    #[default]
    Collecting,
    Available(u16),
    Unavailable,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) enum AppServerResourcesView {
    #[default]
    IncludedInTui,
    Local(AppServerProcessResourcesView),
    Remote,
}

#[derive(Debug)]
pub(crate) struct ProcessResourcesModel {
    app_server_process: AppServerProcess,
    request: ProcessResourceRequest,
    tui: ProcessUsageView,
    app_server: AppServerProcessResourcesView,
}

impl ProcessResourcesModel {
    pub(crate) fn new(app_server_process: AppServerProcess) -> Self {
        Self {
            app_server_process,
            request: ProcessResourceRequest::default(),
            tui: ProcessUsageView::default(),
            app_server: AppServerProcessResourcesView::default(),
        }
    }

    pub(crate) fn apply_request(&mut self, request: ProcessResourceRequest) {
        if request.revision <= self.request.revision {
            return;
        }
        let previous = self.request.demand.metrics();
        let next = request.demand.metrics();
        let previous_memory = previous.is_some_and(ProcessResourceMetrics::includes_memory);
        let next_memory = next.is_some_and(ProcessResourceMetrics::includes_memory);
        if !previous_memory && next_memory {
            self.tui.memory = ProcessMemoryCurrent::Collecting;
            self.app_server.process.memory = ProcessMemoryCurrent::Collecting;
            for descendant in &mut self.app_server.descendants {
                descendant.usage.memory = ProcessMemoryCurrent::Collecting;
            }
        }
        let previous_cpu = previous.is_some_and(ProcessResourceMetrics::includes_cpu);
        let next_cpu = next.is_some_and(ProcessResourceMetrics::includes_cpu);
        if !previous_cpu && next_cpu {
            self.tui.cpu = ProcessCpuCurrent::Collecting;
            self.app_server.process.cpu = ProcessCpuCurrent::Collecting;
            for descendant in &mut self.app_server.descendants {
                descendant.usage.cpu = ProcessCpuCurrent::Collecting;
            }
        }
        update_app_server_total(&mut self.app_server);
        self.request = request;
    }

    pub(crate) fn apply(&mut self, reading: ProcessResourcesReading) {
        if reading.request != self.request {
            return;
        }
        let Some(metrics) = self.request.demand.metrics() else {
            return;
        };
        apply_usage(&mut self.tui, reading.current, metrics);
        if matches!(self.app_server_process, AppServerProcess::Local(_)) {
            match reading.tree {
                Some(Ok(usage)) => apply_app_server_usage(&mut self.app_server, usage, metrics),
                Some(Err(_)) | None => {
                    mark_usage_unavailable(&mut self.app_server.process, metrics);
                    self.app_server.descendants.clear();
                    self.app_server.total = self.app_server.process;
                }
            }
        }
    }

    pub(crate) fn view(&self) -> ProcessResourcesView {
        ProcessResourcesView {
            local: self.local_usage(),
            tui: self.tui,
            app_server: match self.app_server_process {
                AppServerProcess::IncludedInTui => AppServerResourcesView::IncludedInTui,
                AppServerProcess::Local(_) => {
                    AppServerResourcesView::Local(self.app_server.clone())
                }
                AppServerProcess::Remote => AppServerResourcesView::Remote,
            },
        }
    }

    fn local_usage(&self) -> ProcessUsageView {
        match self.app_server_process {
            AppServerProcess::IncludedInTui | AppServerProcess::Remote => self.tui,
            AppServerProcess::Local(_) => ProcessUsageView {
                memory: sum_memory(self.tui.memory, self.app_server.total.memory),
                cpu: sum_cpu(self.tui.cpu, self.app_server.total.cpu),
            },
        }
    }
}

fn apply_app_server_usage(
    view: &mut AppServerProcessResourcesView,
    usage: ProcessTreeResourceUsage,
    metrics: ProcessResourceMetrics,
) {
    apply_usage(&mut view.process, Ok(usage.root), metrics);
    view.descendants = usage
        .descendants
        .into_iter()
        .map(|process| {
            let mut usage = ProcessUsageView::default();
            apply_usage(&mut usage, process.usage, metrics);
            ObservedProcessResourcesView {
                process_id: process.process_id,
                depth: process.depth,
                name: process.name,
                usage,
            }
        })
        .collect();
    update_app_server_total(view);
}

fn update_app_server_total(view: &mut AppServerProcessResourcesView) {
    view.total = view
        .descendants
        .iter()
        .fold(view.process, |total, process| ProcessUsageView {
            memory: sum_memory(total.memory, process.usage.memory),
            cpu: sum_cpu(total.cpu, process.usage.cpu),
        });
}

impl Default for ProcessResourcesModel {
    fn default() -> Self {
        Self::new(AppServerProcess::IncludedInTui)
    }
}

fn apply_usage(
    view: &mut ProcessUsageView,
    usage: Result<ProcessResourceUsage, String>,
    metrics: ProcessResourceMetrics,
) {
    match usage {
        Ok(usage) => {
            if metrics.includes_memory() {
                view.memory = usage.resident_bytes.map_or(
                    ProcessMemoryCurrent::Unavailable,
                    ProcessMemoryCurrent::Available,
                );
            }
            if metrics.includes_cpu() {
                view.cpu = usage
                    .cpu_tenths_percent
                    .map_or(ProcessCpuCurrent::Collecting, ProcessCpuCurrent::Available);
            }
        }
        Err(_) => mark_usage_unavailable(view, metrics),
    }
}

fn mark_usage_unavailable(view: &mut ProcessUsageView, metrics: ProcessResourceMetrics) {
    if metrics.includes_memory() {
        view.memory = ProcessMemoryCurrent::Unavailable;
    }
    if metrics.includes_cpu() {
        view.cpu = ProcessCpuCurrent::Unavailable;
    }
}

fn sum_memory(left: ProcessMemoryCurrent, right: ProcessMemoryCurrent) -> ProcessMemoryCurrent {
    match (left, right) {
        (ProcessMemoryCurrent::Available(left), ProcessMemoryCurrent::Available(right)) => {
            ProcessMemoryCurrent::Available(left.saturating_add(right))
        }
        (ProcessMemoryCurrent::Unavailable, _) | (_, ProcessMemoryCurrent::Unavailable) => {
            ProcessMemoryCurrent::Unavailable
        }
        _ => ProcessMemoryCurrent::Collecting,
    }
}

fn sum_cpu(left: ProcessCpuCurrent, right: ProcessCpuCurrent) -> ProcessCpuCurrent {
    match (left, right) {
        (ProcessCpuCurrent::Available(left), ProcessCpuCurrent::Available(right)) => {
            ProcessCpuCurrent::Available(left.saturating_add(right).min(1_000))
        }
        (ProcessCpuCurrent::Unavailable, _) | (_, ProcessCpuCurrent::Unavailable) => {
            ProcessCpuCurrent::Unavailable
        }
        _ => ProcessCpuCurrent::Collecting,
    }
}

pub(crate) fn format_process_memory(current: ProcessMemoryCurrent) -> String {
    match current {
        ProcessMemoryCurrent::Collecting => "collecting".into(),
        ProcessMemoryCurrent::Available(bytes) => format_bytes(bytes),
        ProcessMemoryCurrent::Unavailable => "unavailable".into(),
    }
}

pub(crate) fn format_bytes(bytes: u64) -> String {
    if bytes >= GIBIBYTE {
        format!("{:.2} GiB", bytes as f64 / GIBIBYTE as f64)
    } else {
        format!("{:.1} MiB", bytes as f64 / MEBIBYTE as f64)
    }
}

pub(crate) fn format_compact_process_memory(current: ProcessMemoryCurrent) -> String {
    match current {
        ProcessMemoryCurrent::Collecting => "mem …".into(),
        ProcessMemoryCurrent::Unavailable => "mem ?".into(),
        ProcessMemoryCurrent::Available(bytes) if bytes >= GIBIBYTE => {
            format!("mem {:.2}G", bytes as f64 / GIBIBYTE as f64)
        }
        ProcessMemoryCurrent::Available(bytes) if bytes < MEBIBYTE => "mem <1M".into(),
        ProcessMemoryCurrent::Available(bytes) => {
            format!("mem {:.0}M", bytes as f64 / MEBIBYTE as f64)
        }
    }
}

pub(crate) fn format_process_cpu(current: ProcessCpuCurrent) -> String {
    match current {
        ProcessCpuCurrent::Collecting => "collecting".into(),
        ProcessCpuCurrent::Available(tenths) => {
            format!("{}.{:01}%", tenths / 10, tenths % 10)
        }
        ProcessCpuCurrent::Unavailable => "unavailable".into(),
    }
}

pub(crate) fn format_compact_process_cpu(current: ProcessCpuCurrent) -> String {
    match current {
        ProcessCpuCurrent::Collecting => "cpu …".into(),
        ProcessCpuCurrent::Unavailable => "cpu ?".into(),
        ProcessCpuCurrent::Available(tenths) => format!("cpu {}%", (tenths + 5) / 10),
    }
}

pub(crate) fn format_process_usage(usage: ProcessUsageView) -> String {
    match (usage.memory, usage.cpu) {
        (ProcessMemoryCurrent::Collecting, ProcessCpuCurrent::Collecting) => "collecting".into(),
        (ProcessMemoryCurrent::Unavailable, ProcessCpuCurrent::Unavailable) => "unavailable".into(),
        _ => format!(
            "{} · {}",
            format_process_memory(usage.memory),
            format_process_cpu(usage.cpu),
        ),
    }
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod tests;

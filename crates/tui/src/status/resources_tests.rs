use super::AppServerResourcesView;
use super::ProcessCpuCurrent;
use super::ProcessMemoryCurrent;
use super::ProcessResourcesModel;
use super::ProcessResourcesView;
use super::ProcessUsageView;
use super::format_bytes;
use super::format_compact_process_cpu;
use super::format_compact_process_memory;
use super::format_process_usage;
use crate::AppServerProcess;
use ash_memory_diagnostics::ObservedProcess;
use ash_memory_diagnostics::ProcessResourceDemand;
use ash_memory_diagnostics::ProcessResourceMetrics;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_memory_diagnostics::ProcessResourceUsage;
use ash_memory_diagnostics::ProcessResourcesReading;
use ash_memory_diagnostics::ProcessTreeResourceUsage;
use std::time::Instant;

const MIB: u64 = 1024 * 1024;

#[test]
fn model_aggregates_local_processes_and_exposes_resource_view() {
    let started = Instant::now();
    let mut model = ProcessResourcesModel::new(AppServerProcess::Local(42));
    model.apply_request(detailed_request());
    model.apply(reading(500 * MIB, Some(20 * MIB), Some(25), started));

    assert_eq!(
        model.view(),
        ProcessResourcesView {
            local: ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(520 * MIB),
                cpu: ProcessCpuCurrent::Available(50),
            },
            tui: ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(500 * MIB),
                cpu: ProcessCpuCurrent::Available(25),
            },
            app_server: AppServerResourcesView::Local(super::AppServerProcessResourcesView {
                total: ProcessUsageView {
                    memory: ProcessMemoryCurrent::Available(20 * MIB),
                    cpu: ProcessCpuCurrent::Available(25),
                },
                process: ProcessUsageView {
                    memory: ProcessMemoryCurrent::Available(20 * MIB),
                    cpu: ProcessCpuCurrent::Available(25),
                },
                descendants: Vec::new(),
            }),
        }
    );
}

#[test]
fn unavailable_local_process_marks_the_total_unavailable() {
    let started = Instant::now();
    let mut model = ProcessResourcesModel::new(AppServerProcess::Local(42));
    model.apply_request(detailed_request());
    model.apply(reading(100 * MIB, Some(20 * MIB), Some(10), started));
    model.apply(ProcessResourcesReading {
        request: detailed_request(),
        current: Ok(usage(110 * MIB, Some(10))),
        tree: Some(Err("not readable".into())),
        sampled_at: started,
    });

    let view = model.view();
    assert_eq!(view.local.memory, ProcessMemoryCurrent::Unavailable);
    assert_eq!(view.local.cpu, ProcessCpuCurrent::Unavailable);
}

#[test]
fn model_includes_app_server_descendants_in_app_server_and_local_totals() {
    let mut model = ProcessResourcesModel::new(AppServerProcess::Local(42));
    model.apply_request(detailed_request());
    model.apply(ProcessResourcesReading {
        request: detailed_request(),
        current: Ok(usage(100 * MIB, Some(20))),
        tree: Some(Ok(ProcessTreeResourceUsage {
            root: usage(40 * MIB, Some(10)),
            descendants: vec![
                ObservedProcess {
                    process_id: 101,
                    depth: 1,
                    name: "rust-analyzer".into(),
                    usage: Ok(usage(200 * MIB, Some(30))),
                },
                ObservedProcess {
                    process_id: 102,
                    depth: 2,
                    name: "proc-macro-srv".into(),
                    usage: Ok(usage(60 * MIB, Some(5))),
                },
            ],
        })),
        sampled_at: Instant::now(),
    });

    let view = model.view();
    assert_eq!(
        view.local,
        super::ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(400 * MIB),
            cpu: ProcessCpuCurrent::Available(65),
        }
    );
    let AppServerResourcesView::Local(app_server) = view.app_server else {
        panic!("expected local App Server resources");
    };
    assert_eq!(
        app_server.total,
        super::ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(300 * MIB),
            cpu: ProcessCpuCurrent::Available(45),
        }
    );
    assert_eq!(app_server.descendants.len(), 2);
    assert_eq!(app_server.descendants[1].depth, 2);
}

#[test]
fn remote_app_server_is_explicit_and_excluded_from_local_totals() {
    let mut model = ProcessResourcesModel::new(AppServerProcess::Remote);
    model.apply_request(detailed_request());
    model.apply(ProcessResourcesReading {
        request: detailed_request(),
        current: Ok(usage(80 * MIB, Some(35))),
        tree: None,
        sampled_at: Instant::now(),
    });

    let view = model.view();
    assert_eq!(view.local, view.tui);
    assert_eq!(view.app_server, AppServerResourcesView::Remote);
}

#[test]
fn demand_changes_reset_restarted_metrics_and_reject_stale_readings() {
    let started = Instant::now();
    let mut model = ProcessResourcesModel::new(AppServerProcess::IncludedInTui);
    let detailed = detailed_request();
    model.apply_request(detailed);
    model.apply(reading(100 * MIB, None, Some(25), started));

    let disabled = ProcessResourceRequest {
        revision: 2,
        cpu_cycle: 1,
        demand: ProcessResourceDemand::Disabled,
    };
    model.apply_request(disabled);
    model.apply(reading(200 * MIB, None, Some(50), started));
    assert_eq!(
        model.view().local.memory,
        ProcessMemoryCurrent::Available(100 * MIB)
    );
    assert_eq!(model.view().local.cpu, ProcessCpuCurrent::Available(25));

    let memory = ProcessResourceRequest {
        revision: 3,
        cpu_cycle: 1,
        demand: ProcessResourceDemand::Summary(ProcessResourceMetrics::Memory),
    };
    model.apply_request(memory);
    model.apply(ProcessResourcesReading {
        request: memory,
        current: Ok(ProcessResourceUsage {
            resident_bytes: Some(80 * MIB),
            cpu_tenths_percent: None,
        }),
        tree: None,
        sampled_at: started,
    });
    assert_eq!(
        model.view().local.memory,
        ProcessMemoryCurrent::Available(80 * MIB)
    );
    assert_eq!(model.view().local.cpu, ProcessCpuCurrent::Available(25));

    model.apply_request(ProcessResourceRequest {
        revision: 4,
        cpu_cycle: 2,
        demand: ProcessResourceDemand::Summary(ProcessResourceMetrics::Cpu),
    });
    assert_eq!(model.view().local.cpu, ProcessCpuCurrent::Collecting);
}

#[test]
fn resource_values_have_full_compact_and_combined_formats() {
    assert_eq!(format_bytes(146_590_924), "139.8 MiB");
    assert_eq!(format_bytes(1_342_177_280), "1.25 GiB");
    assert_eq!(
        format_compact_process_memory(ProcessMemoryCurrent::Available(146_590_924)),
        "mem 140M"
    );
    assert_eq!(
        format_compact_process_cpu(ProcessCpuCurrent::Available(124)),
        "cpu 12%"
    );
    assert_eq!(
        format_process_usage(ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(146_590_924),
            cpu: ProcessCpuCurrent::Available(124),
        }),
        "139.8 MiB · 12.4%"
    );
    assert_eq!(
        format_process_usage(ProcessUsageView {
            memory: ProcessMemoryCurrent::Collecting,
            cpu: ProcessCpuCurrent::Collecting,
        }),
        "collecting"
    );
    assert_eq!(
        format_process_usage(ProcessUsageView {
            memory: ProcessMemoryCurrent::Unavailable,
            cpu: ProcessCpuCurrent::Unavailable,
        }),
        "unavailable"
    );
}

fn reading(
    tui_memory: u64,
    app_server_memory: Option<u64>,
    cpu: Option<u16>,
    sampled_at: Instant,
) -> ProcessResourcesReading {
    ProcessResourcesReading {
        request: detailed_request(),
        current: Ok(usage(tui_memory, cpu)),
        tree: app_server_memory.map(|memory| {
            Ok(ProcessTreeResourceUsage {
                root: usage(memory, cpu),
                descendants: Vec::new(),
            })
        }),
        sampled_at,
    }
}

fn usage(resident_bytes: u64, cpu_tenths_percent: Option<u16>) -> ProcessResourceUsage {
    ProcessResourceUsage {
        resident_bytes: Some(resident_bytes),
        cpu_tenths_percent,
    }
}

fn detailed_request() -> ProcessResourceRequest {
    ProcessResourceRequest {
        revision: 1,
        cpu_cycle: 1,
        demand: ProcessResourceDemand::Detailed,
    }
}

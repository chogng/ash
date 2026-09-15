use super::AppServerResourcesView;
use super::ProcessCpuCurrent;
use super::ProcessMemoryCurrent;
use super::ProcessResourcesModel;
use super::ProcessResourcesView;
use super::format_bytes;
use super::format_compact_process_cpu;
use super::format_compact_process_memory;
use super::format_memory_change;
use crate::AppServerProcess;
use ash_memory_diagnostics::ObservedProcess;
use ash_memory_diagnostics::ProcessResourceDemand;
use ash_memory_diagnostics::ProcessResourceMetrics;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_memory_diagnostics::ProcessResourceUsage;
use ash_memory_diagnostics::ProcessResourcesReading;
use ash_memory_diagnostics::ProcessTreeResourceUsage;
use std::time::Duration;
use std::time::Instant;

const MIB: u64 = 1024 * 1024;

#[test]
fn model_aggregates_local_processes_and_tracks_bounded_memory_history() {
    let started = Instant::now();
    let mut model = ProcessResourcesModel::new(AppServerProcess::Local(42));
    model.apply_request(detailed_request());
    for second in 0..=400 {
        model.apply(reading(
            (100 + second) * MIB,
            Some(20 * MIB),
            Some(25),
            started + Duration::from_secs(second),
        ));
    }

    assert_eq!(model.sample_count(), 301);
    assert_eq!(
        model.view(),
        ProcessResourcesView {
            local: super::ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(520 * MIB),
                cpu: ProcessCpuCurrent::Available(50),
            },
            tui: super::ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(500 * MIB),
                cpu: ProcessCpuCurrent::Available(25),
            },
            app_server: AppServerResourcesView::Local(super::AppServerProcessResourcesView {
                total: super::ProcessUsageView {
                    memory: ProcessMemoryCurrent::Available(20 * MIB),
                    cpu: ProcessCpuCurrent::Available(25),
                },
                process: super::ProcessUsageView {
                    memory: ProcessMemoryCurrent::Available(20 * MIB),
                    cpu: ProcessCpuCurrent::Available(25),
                },
                descendants: Vec::new(),
            },),
            observed_peak_bytes: Some(520 * MIB),
            one_minute_change_bytes: Some(60 * i128::from(MIB)),
            five_minute_change_bytes: Some(300 * i128::from(MIB)),
        }
    );
}

#[test]
fn unavailable_local_process_marks_the_total_unavailable_without_discarding_history() {
    let started = Instant::now();
    let mut model = ProcessResourcesModel::new(AppServerProcess::Local(42));
    model.apply_request(detailed_request());
    model.apply(reading(100 * MIB, Some(20 * MIB), Some(10), started));
    model.apply(ProcessResourcesReading {
        request: detailed_request(),
        current: Ok(usage(110 * MIB, Some(10))),
        tree: Some(Err("not readable".into())),
        sampled_at: started + Duration::from_secs(1),
    });

    let view = model.view();
    assert_eq!(view.local.memory, ProcessMemoryCurrent::Unavailable);
    assert_eq!(view.local.cpu, ProcessCpuCurrent::Unavailable);
    assert_eq!(view.observed_peak_bytes, Some(120 * MIB));
    assert_eq!(model.sample_count(), 1);
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
fn demand_changes_clear_ended_history_reset_restarted_metrics_and_reject_stale_readings() {
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
    model.apply(reading(
        200 * MIB,
        None,
        Some(50),
        started + Duration::from_secs(1),
    ));
    assert_eq!(
        model.view().local.memory,
        ProcessMemoryCurrent::Available(100 * MIB)
    );
    assert_eq!(model.view().local.cpu, ProcessCpuCurrent::Available(25));
    assert_eq!(model.view().observed_peak_bytes, None);
    assert_eq!(model.sample_count(), 0);

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
        sampled_at: started + Duration::from_secs(2),
    });
    assert_eq!(
        model.view().local.memory,
        ProcessMemoryCurrent::Available(80 * MIB)
    );
    assert_eq!(model.view().local.cpu, ProcessCpuCurrent::Available(25));
    assert_eq!(model.view().observed_peak_bytes, Some(80 * MIB));

    model.apply_request(ProcessResourceRequest {
        revision: 4,
        cpu_cycle: 2,
        demand: ProcessResourceDemand::Summary(ProcessResourceMetrics::Cpu),
    });
    assert_eq!(model.view().local.cpu, ProcessCpuCurrent::Collecting);
    assert_eq!(model.view().observed_peak_bytes, None);
}

#[test]
fn resource_values_have_full_compact_and_signed_formats() {
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
    assert_eq!(format_memory_change(Some(i128::from(3 * MIB))), "+3.0 MiB");
    assert_eq!(format_memory_change(Some(-i128::from(3 * MIB))), "-3.0 MiB");
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

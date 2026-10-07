use super::*;

fn request(id: &str) -> MemoryStart {
    MemoryStart {
        request_id: id.into(),
        product: MemoryProduct::Tui,
        duration_secs: 600,
    }
}

fn observation(value: u64) -> MemoryObservation {
    MemoryObservation {
        instance_id: "123:456".into(),
        process_id: Some(123),
        role: MemoryRole::Tui,
        phase: MemoryPhase::Idle,
        metrics: vec![MemoryMetric {
            kind: MemoryMetricKind::UiObjects,
            value: Some(value),
            unavailable: None,
        }],
    }
}

#[test]
fn start_is_idempotent_and_connections_cannot_read_stop_or_submit_to_other_owners() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("first")).unwrap();
    assert_eq!(
        service.start(1, request("first")).unwrap().session_id,
        report.session_id
    );
    assert_eq!(
        service.start(1, request("second")),
        Err(MemoryDiagnosticsError::Conflict)
    );
    assert_eq!(
        service.read(2, &report.session_id),
        Err(MemoryDiagnosticsError::NotFound)
    );
    assert_eq!(
        service.stop(2, &report.session_id),
        Err(MemoryDiagnosticsError::NotFound)
    );
    assert_eq!(
        service.submit(
            2,
            MemoryEvidence {
                session_id: report.session_id.clone(),
                sequence: 1,
                observations: vec![observation(1)]
            }
        ),
        Err(MemoryDiagnosticsError::NotFound)
    );
    let stopped = service.stop(1, &report.session_id).unwrap();
    assert_eq!(stopped, service.stop(1, &report.session_id).unwrap());
    service.close_owner(1);
    assert_eq!(
        service.read(1, &report.session_id),
        Err(MemoryDiagnosticsError::NotFound)
    );
}

#[test]
fn stale_invalid_and_stopped_evidence_cannot_change_recorded_samples() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("first")).unwrap();
    let evidence = MemoryEvidence {
        session_id: report.session_id.clone(),
        sequence: 1,
        observations: vec![observation(1)],
    };
    service.submit(1, evidence.clone()).unwrap();
    assert_eq!(
        service.submit(1, evidence.clone()),
        Err(MemoryDiagnosticsError::Stale)
    );
    let mut invalid = evidence.clone();
    invalid.sequence = 2;
    invalid.observations[0].metrics[0].unavailable = Some(MemoryUnavailable::ReadFailed);
    assert_eq!(
        service.submit(1, invalid),
        Err(MemoryDiagnosticsError::Invalid)
    );
    let snapshot = service.stop(1, &report.session_id).unwrap();
    assert_eq!(
        snapshot
            .targets
            .iter()
            .find(|target| target.origin == MemoryOrigin::ClientHost)
            .unwrap()
            .samples,
        1
    );
    assert_eq!(
        service.submit(1, evidence),
        Err(MemoryDiagnosticsError::Stopped)
    );
}

#[test]
fn process_restarts_have_separate_series_and_export_preserves_metric_units() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("first")).unwrap();
    let old = observation(10);
    let mut new = observation(1);
    new.instance_id = "123:789".into();
    service
        .submit(
            1,
            MemoryEvidence {
                session_id: report.session_id.clone(),
                sequence: 1,
                observations: vec![old, new],
            },
        )
        .unwrap();
    let bytes = service.export(1, &report.session_id).unwrap();
    let export: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let clients = export["report"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| target["origin"] == "clientHost")
        .count();
    assert_eq!(clients, 2);
    assert_eq!(export["report"]["version"], 1);
    assert!(String::from_utf8(bytes).unwrap().contains("uiObjects"));
}

fn samples(value: impl Fn(u64) -> u64) -> VecDeque<MemorySample> {
    (0..=120)
        .map(|n| MemorySample {
            elapsed_ms: n * 5000,
            phase: MemoryPhase::Idle,
            metrics: vec![MemoryMetric {
                kind: MemoryMetricKind::UiObjects,
                value: Some(value(n)),
                unavailable: None,
            }],
        })
        .collect()
}

#[test]
fn trends_distinguish_sustained_idle_growth_cache_warmup_and_missing_evidence() {
    let growing = samples(|n| n + 1);
    assert_eq!(
        trend(&growing, MemoryMetricKind::UiObjects, 0).finding,
        MemoryFinding::IdleBaselineGrowth
    );
    let warmed = samples(|n| n.min(10) + 1);
    assert_eq!(
        trend(&warmed, MemoryMetricKind::UiObjects, 0).finding,
        MemoryFinding::NoSustainedGrowthObserved
    );
    assert_eq!(
        trend(&growing, MemoryMetricKind::UiObjects, 1).finding,
        MemoryFinding::InsufficientEvidence
    );
    assert_eq!(
        trend(&growing, MemoryMetricKind::ResidentBytes, 0).finding,
        MemoryFinding::InsufficientEvidence
    );
    let mut gap = growing.clone();
    gap.drain(20..30);
    assert_eq!(
        trend(&gap, MemoryMetricKind::UiObjects, 0).finding,
        MemoryFinding::InsufficientEvidence
    );
}

#[test]
fn history_is_bounded_and_owner_close_reclaims_all_recordings() {
    let service = MemoryDiagnostics::default();
    for cycle in 0..12 {
        let report = service.start(1, request(&cycle.to_string())).unwrap();
        for sequence in 1..=400 {
            service
                .submit(
                    1,
                    MemoryEvidence {
                        session_id: report.session_id.clone(),
                        sequence,
                        observations: vec![observation(sequence)],
                    },
                )
                .unwrap();
        }
        let report = service.read(1, &report.session_id).unwrap();
        let target = report
            .targets
            .iter()
            .find(|target| target.origin == MemoryOrigin::ClientHost)
            .unwrap();
        assert_eq!(target.samples, MAX_SAMPLES as u32);
        assert_eq!(target.discarded_samples, 40);
        service.close_owner(1);
        assert!(service.shared.state.lock().unwrap().sessions.is_empty());
    }
}

#[test]
fn duration_and_retention_expire_without_frontend_activity() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("first")).unwrap();
    let mut state = service.shared.state.lock().unwrap();
    let session = state.sessions.get_mut(&report.session_id).unwrap();
    session.started -= Duration::from_secs(601);
    state.prune(Instant::now());
    assert_eq!(
        state.sessions[&report.session_id].status,
        MemoryStatus::BudgetExpired
    );
    state.prune(Instant::now() + RETENTION);
    assert!(state.sessions.is_empty());
}

#[test]
fn disappearing_targets_are_marked_exited_once_and_restart_cannot_reuse_an_identity() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("first")).unwrap();
    service
        .submit(
            1,
            MemoryEvidence {
                session_id: report.session_id.clone(),
                sequence: 1,
                observations: vec![observation(1)],
            },
        )
        .unwrap();
    let mut replacement = observation(2);
    replacement.instance_id = "123:new-start".into();
    service
        .submit(
            1,
            MemoryEvidence {
                session_id: report.session_id.clone(),
                sequence: 2,
                observations: vec![replacement.clone()],
            },
        )
        .unwrap();
    service
        .submit(
            1,
            MemoryEvidence {
                session_id: report.session_id.clone(),
                sequence: 3,
                observations: vec![replacement],
            },
        )
        .unwrap();
    let report = service.read(1, &report.session_id).unwrap();
    let old = report
        .targets
        .iter()
        .find(|target| target.origin == MemoryOrigin::ClientHost && target.instance_id == "123:456")
        .unwrap();
    assert_eq!(old.samples, 2);
    assert_eq!(
        old.latest.metrics[0].unavailable,
        Some(MemoryUnavailable::Exited)
    );
}

#[test]
fn a_silent_collector_is_reported_as_missing_evidence() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("silent")).unwrap();
    service
        .submit(
            1,
            MemoryEvidence {
                session_id: report.session_id.clone(),
                sequence: 1,
                observations: vec![observation(1)],
            },
        )
        .unwrap();
    let mut state = service.shared.state.lock().unwrap();
    let session = state.sessions.get_mut(&report.session_id).unwrap();
    session.started -= Duration::from_secs(20);
    let report = session.report();
    assert!(report.evidence_gaps > 0);
    assert!(
        report
            .targets
            .iter()
            .flat_map(|target| &target.trends)
            .all(|trend| trend.finding == MemoryFinding::InsufficientEvidence)
    );
}

#[test]
fn repeated_stop_does_not_extend_report_retention() {
    let service = MemoryDiagnostics::default();
    let report = service.start(1, request("retention")).unwrap();
    service.stop(1, &report.session_id).unwrap();
    let now = Instant::now();
    {
        let mut state = service.shared.state.lock().unwrap();
        let session = state.sessions.get_mut(&report.session_id).unwrap();
        session.started = now - RETENTION;
        session.ended = Some(now - RETENTION + Duration::from_secs(10));
    }
    service.stop(1, &report.session_id).unwrap();
    let mut state = service.shared.state.lock().unwrap();
    assert_eq!(state.retention_delay(now), Duration::from_secs(10));
    state.prune(now + Duration::from_secs(10));
    assert!(state.sessions.is_empty());
}

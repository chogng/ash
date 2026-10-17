use super::*;

#[test]
fn requests_cannot_supply_a_user_or_add_an_unrecognized_operation() {
    for request in [
        r#"{"operation":"status","ownerSid":"S-1-5-18"}"#,
        r#"{"operation":"run","command":"cmd.exe"}"#,
        r#"{"operation":"remove","approved":"abc","root":"C:\\other"}"#,
    ] {
        assert!(serde_json::from_str::<Request>(request).is_err());
    }
}

#[test]
fn approval_and_runner_identity_survive_the_wire() {
    let message = Message {
        version: PROTOCOL_VERSION,
        request: Request::Setup {
            runner: PathBuf::from("C:/Ash/bin/ash-windows-sandbox.exe"),
            slots: 2,
            approved: "approved-plan-digest".into(),
        },
    };
    let bytes = serde_json::to_vec(&message).unwrap();
    let decoded: Message = serde_json::from_slice(&bytes).unwrap();
    match decoded.request {
        Request::Setup {
            runner,
            slots,
            approved,
        } => {
            assert_eq!(runner, PathBuf::from("C:/Ash/bin/ash-windows-sandbox.exe"));
            assert_eq!(slots, 2);
            assert_eq!(approved, "approved-plan-digest");
        }
        _ => panic!("request changed during serialization"),
    }
}

#[test]
fn production_setup_metrics_count_results_without_approval_paths_or_error_text() {
    let metrics = diagnostics::Metrics::default();
    let request = Request::Setup {
        runner: PathBuf::from("C:/private/runner.exe"),
        slots: 2,
        approved: "secret-digest".into(),
    };
    measure(operation(&request), &metrics, || Ok(())).unwrap();
    measure::<()>(operation(&request), &metrics, || {
        Err("private account and path".into())
    })
    .unwrap_err();
    assert!(operation(&Request::Metrics {}).is_none());
    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot
            .iter()
            .filter(|s| s.name == "ash.windows_sandbox.setup")
            .map(|s| s.count)
            .sum::<u64>(),
        2
    );
    assert!(
        snapshot
            .iter()
            .any(|s| s.name == "ash.windows_sandbox.setup.error"
                && s.tags["error_type"] == "provisioning")
    );
    let json = serde_json::to_string(&snapshot).unwrap();
    for private in ["private", "runner", "secret-digest"] {
        assert!(!json.contains(private));
    }
    let decoded: Request = serde_json::from_str(r#"{"operation":"metrics"}"#).unwrap();
    assert!(matches!(decoded, Request::Metrics {}));
}

#[cfg(windows)]
#[test]
fn actual_provisioning_dispatch_exports_failed_setup_to_metrics_request() {
    let metrics = diagnostics::Metrics::default();
    let root = tempfile::tempdir().unwrap();
    let response = dispatch(
        Message {
            version: PROTOCOL_VERSION,
            request: Request::Setup {
                runner: root.path().join("missing-private-runner.exe"),
                slots: 1,
                approved: "private-digest".into(),
            },
        },
        &metrics,
    );
    assert!(matches!(response, Response::Rejected { .. }));
    let response = dispatch(
        Message {
            version: PROTOCOL_VERSION,
            request: Request::Metrics {},
        },
        &metrics,
    );
    let Response::Completed { data } = response else {
        panic!("metric read failed")
    };
    let series: Vec<diagnostics::MetricSeries> = serde_json::from_value(data).unwrap();
    assert!(series.iter().any(|s| s.name == "ash.windows_sandbox.setup"
        && s.count == 1
        && s.tags["status"] == "failed"));
    assert!(!serde_json::to_string(&series).unwrap().contains("private"));
}

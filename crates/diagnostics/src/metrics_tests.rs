use super::*;

#[test]
fn sdk_snapshots_are_cumulative_sanitized_and_isolated() {
    let metrics = Metrics::default();
    metrics
        .start(
            MetricOperation::McpCall,
            &[("server", "test server!"), ("tool", "工具/read")],
        )
        .finish(MetricOutcome::Succeeded, None);
    metrics
        .start(
            MetricOperation::McpCall,
            &[("server", "test server!"), ("tool", "工具/read")],
        )
        .finish(MetricOutcome::Failed, Some("tool_result"));
    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot
            .iter()
            .filter(|s| s.name == "ash.mcp.call")
            .map(|s| s.count)
            .sum::<u64>(),
        2
    );
    assert!(
        snapshot
            .iter()
            .any(|s| s.name == "ash.mcp.call.error" && s.tags["error_type"] == "tool_result")
    );
    assert!(
        snapshot
            .iter()
            .all(|s| s.tags["server"] == "test_server" && s.tags["tool"] == "/read")
    );
    assert_eq!(snapshot, metrics.snapshot());
    for series in snapshot.iter().filter(|s| s.kind == MetricKind::Histogram) {
        let distribution = series.distribution.as_ref().unwrap();
        assert_eq!(
            distribution.bucket_counts.len(),
            distribution.bounds.len() + 1
        );
        assert_eq!(distribution.bucket_counts.iter().sum::<u64>(), series.count);
        assert!(distribution.min <= distribution.max);
    }
    assert!(Metrics::default().snapshot().is_empty());
}

#[test]
fn dropped_operations_and_cardinality_overflow_keep_totals() {
    let metrics = Metrics::default();
    for id in 0..300 {
        drop(metrics.start(
            MetricOperation::McpCall,
            &[("server", &format!("server-{id}"))],
        ));
    }
    let snapshot = metrics.snapshot();
    let counts: Vec<_> = snapshot
        .iter()
        .filter(|s| s.name == "ash.mcp.call")
        .collect();
    assert!(counts.len() <= 129);
    assert_eq!(counts.iter().map(|s| s.count).sum::<u64>(), 300);
}

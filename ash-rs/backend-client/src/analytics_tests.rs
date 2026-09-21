use super::*;
use serde_json::json;

#[test]
fn every_analytics_report_uses_its_route_query_and_typed_response() {
    let token = CancellationSource::new().token();
    for (style, prefix) in [
        (RouteStyle::Codex, "api/codex"),
        (RouteStyle::ChatGpt, "wham"),
    ] {
        let target = target("https://example.test/backend-api");
        let reports = [
            (
                AnalyticsReport::Usage,
                "usage/daily-token-usage-breakdown",
                r#"{"data":[],"units":"tokens"}"#,
            ),
            (
                AnalyticsReport::EnterpriseTokens,
                "usage/daily-workspace-user-token-usage-breakdown",
                r#"{"data":[]}"#,
            ),
            (
                AnalyticsReport::WorkspaceCredits,
                "usage/daily-workspace-user-token-usage-breakdown",
                r#"{"data":[]}"#,
            ),
            (
                AnalyticsReport::Credits,
                "usage/credit-usage-events",
                r#"{"data":[]}"#,
            ),
            (
                AnalyticsReport::EnterpriseCredits {
                    breakdown: "model / surface",
                },
                "usage/daily-workspace-user-credit-usage",
                r#"{"breakdown":"model","data":[],"series":[]}"#,
            ),
            (
                AnalyticsReport::Messages,
                "analytics/daily-workspace-usage-counts",
                r#"{"data":[]}"#,
            ),
            (
                AnalyticsReport::Plugins { limit: 12 },
                "analytics/daily-plugin-usage-metrics",
                r#"{"data":[]}"#,
            ),
            (
                AnalyticsReport::Skills { limit: 15 },
                "analytics/daily-skill-usage-metrics",
                r#"{"data":[]}"#,
            ),
        ];
        for (report, path, body) in reports {
            let client = Client::response(200, body);
            let backend = BackendClient::new(&client, &target, style).unwrap();
            let response = backend
                .read_analytics(report, "2026-09-01", "2026-09-22", &token)
                .unwrap();
            assert!(matches!(
                (report, response),
                (
                    AnalyticsReport::Usage
                        | AnalyticsReport::EnterpriseTokens
                        | AnalyticsReport::WorkspaceCredits,
                    AnalyticsResponse::Usage(_)
                ) | (AnalyticsReport::Credits, AnalyticsResponse::Credits(_))
                    | (
                        AnalyticsReport::EnterpriseCredits { .. },
                        AnalyticsResponse::EnterpriseCredits(_)
                    )
                    | (AnalyticsReport::Messages, AnalyticsResponse::Messages(_))
                    | (
                        AnalyticsReport::Plugins { .. },
                        AnalyticsResponse::Plugins(_)
                    )
                    | (AnalyticsReport::Skills { .. }, AnalyticsResponse::Skills(_))
            ));
            let requests = client.requests.lock().unwrap();
            let request = &requests[0];
            assert_eq!(request.method(), HttpMethod::Get);
            assert_eq!(request.headers(), target.headers);
            let url = url::Url::parse(request.url()).unwrap();
            assert_eq!(url.path(), format!("/backend-api/{prefix}/{path}"));
            let pairs: Vec<_> = url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            let mut expected = Vec::new();
            if report != AnalyticsReport::Credits {
                expected.extend([
                    ("start_date".into(), "2026-09-01".into()),
                    ("end_date".into(), "2026-09-22".into()),
                ]);
                if matches!(report, AnalyticsReport::EnterpriseCredits { .. }) {
                    expected.push(("breakdown".into(), "model / surface".into()));
                } else {
                    expected.push(("group_by".into(), "day".into()));
                }
            }
            match report {
                AnalyticsReport::EnterpriseTokens => expected.extend([
                    ("breakdown_by".into(), "model".into()),
                    ("modes".into(), "codex".into()),
                    ("modes".into(), "work".into()),
                ]),
                AnalyticsReport::Messages => {
                    expected.push(("workspace_user".into(), "true".into()))
                }
                AnalyticsReport::Plugins { .. } => expected.extend([
                    ("workspace_user".into(), "true".into()),
                    ("top_plugin_limit".into(), "12".into()),
                ]),
                AnalyticsReport::Skills { .. } => expected.extend([
                    ("workspace_user".into(), "true".into()),
                    ("top_skill_limit".into(), "15".into()),
                ]),
                _ => {}
            }
            assert_eq!(pairs, expected);
            drop(requests);
            let cancelled = CancellationSource::new();
            cancelled.cancel();
            assert_eq!(
                backend.read_analytics(report, "2026-09-01", "2026-09-22", &cancelled.token()),
                Err(RequestError::Cancelled)
            );
            assert_eq!(client.requests.lock().unwrap().len(), 1);
            for (status, body, expected) in [
                (
                    200,
                    "private malformed response",
                    RequestError::InvalidResponse,
                ),
                (
                    403,
                    "private billing response",
                    RequestError::HttpStatus(403),
                ),
            ] {
                let client = Client::response(status, body);
                let backend = BackendClient::new(&client, &target, style).unwrap();
                assert_eq!(
                    backend.read_analytics(report, "2026-09-01", "2026-09-22", &token),
                    Err(expected)
                );
            }
        }
    }
}

#[test]
fn analytics_preserves_attribution_units_unknown_dimensions_and_missing_amounts() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let client = Client::response(200, &json!({
        "units":"credits", "data_freshness_ts":"2026-09-22T12:00:00Z", "breakdown_by":["future"],
        "data":[{"date":"2026-09-21","product_surface_usage_values":{"codex":12.5},
            "attribution":[{"thread_source":"cli","turn_trigger":"user","model":"future-model","surface":"codex","value":12.5}],
            "groups":[{"dimensions":{"future":"value"},"credits":12.5}],
            "models":[{"model":"future-model","credits":12.5,"text_output_tokens":123}]}]
    }).to_string());
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let AnalyticsResponse::Usage(report) = backend
        .read_analytics(AnalyticsReport::Usage, "2026-09-21", "2026-09-22", &token)
        .unwrap()
    else {
        panic!("usage report");
    };
    assert_eq!(report.units.as_deref(), Some("credits"));
    assert_eq!(
        report.data[0].attribution.as_ref().unwrap()[0].thread_source,
        "cli"
    );
    assert_eq!(
        report.data[0].groups.as_ref().unwrap()[0].dimensions["future"],
        "value"
    );
    assert_eq!(report.data[0].models.as_ref().unwrap()[0].cost_usd, None);
    assert_eq!(
        report.data[0].models.as_ref().unwrap()[0].text_output_tokens,
        Some(123)
    );
}

#[test]
fn analytics_rejects_invalid_dates_ranges_and_limits_before_network() {
    let client = Client::response(200, r#"{"data":[]}"#);
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    for (start, end) in [
        ("2026-02-29", "2026-03-01"),
        ("2026-13-01", "2026-13-01"),
        ("2026-09-02", "2026-09-01"),
        ("bad", "bad"),
        ("0000-01-01", "2026-09-22"),
    ] {
        assert_eq!(
            backend.read_analytics(AnalyticsReport::Usage, start, end, &token),
            Err(RequestError::InvalidRequest)
        );
    }
    for report in [
        AnalyticsReport::Plugins { limit: 0 },
        AnalyticsReport::Skills { limit: 0 },
        AnalyticsReport::EnterpriseCredits { breakdown: "" },
    ] {
        assert_eq!(
            backend.read_analytics(report, "2026-09-01", "2026-09-22", &token),
            Err(RequestError::InvalidRequest)
        );
    }
    assert!(client.requests.lock().unwrap().is_empty());
    backend
        .read_analytics(AnalyticsReport::Usage, "2024-02-29", "2024-03-01", &token)
        .unwrap();
}

#[test]
fn plan_history_distinguishes_unavailable_from_failure_and_incomplete_accounting() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let body = json!({"coverage_complete":false,"periods":[{
        "id":"period-1","window_minutes":10080,"plan_type":"old-plan","starts_at":"2026-09-01","ends_at":"2026-09-08","accounting_complete":false,
        "used_basis_points":null,"breakdowns":[{"dimension":"future","rows":[{"key":"test","basis_points":12.5}]}]
    }]});
    let client = Client::response(200, &body.to_string());
    let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
    let history = backend.read_plan_limit_history(&token).unwrap().unwrap();
    assert_eq!(history.approximate, None);
    assert!(!history.coverage_complete);
    assert_eq!(history.periods[0].used_basis_points, None);
    assert_eq!(
        history.periods[0].breakdowns.as_ref().unwrap()[0].dimension,
        "future"
    );
    assert!(
        client.requests.lock().unwrap()[0]
            .url()
            .ends_with("/usage/plan_limit_history?days=7")
    );
    for status in [404, 401, 500] {
        let client = Client::response(status, "private data");
        let backend = BackendClient::new(&client, &target, RouteStyle::ChatGpt).unwrap();
        let result = backend.read_plan_limit_history(&token);
        if status == 404 {
            assert_eq!(result, Ok(None));
        } else {
            assert_eq!(result, Err(RequestError::HttpStatus(status)));
        }
    }
}

use crate::test_support::Client;
use crate::test_support::target;
use crate::*;
use async_utils::CancellationSource;
use http_client::HttpMethod;
use serde_json::json;

#[test]
fn credit_reports_preserve_signed_events_and_enterprise_series() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let client = Client::response(
        200,
        r#"{"data":[{"date":"2026-09-20","product_surface":"future","credit_amount":-0.004,"usage_id":"refund"},{"date":"2026-09-21","product_surface":"codex","credit_amount":0}]}"#,
    );
    let AnalyticsResponse::Credits(report) =
        BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_analytics(AnalyticsReport::Credits, "", "", &token)
            .unwrap()
    else {
        panic!("expected credit events")
    };
    assert_eq!(report.data.len(), 2);
    assert_eq!(
        report.data[0],
        CreditUsageEventBySurface {
            date: "2026-09-20".into(),
            product_surface: "future".into(),
            credit_amount: -0.004,
            usage_id: Some("refund".into())
        }
    );
    assert_eq!(report.data[1].credit_amount, 0.0);
    assert_eq!(report.data[1].usage_id, None);

    let client = Client::response(
        200,
        r#"{"breakdown":"future","data":[{"date":"2026-09-21","values":{"model/a":1.25,"refund":-0.004}}],"series":[{"key":"model/a","label":"Model A","total":1.25}],"unit":"credits","data_freshness_ts":"2026-09-22T00:00:00Z"}"#,
    );
    let AnalyticsResponse::EnterpriseCredits(report) =
        BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_analytics(
                AnalyticsReport::EnterpriseCredits {
                    breakdown: "future",
                },
                "2026-09-20",
                "2026-09-21",
                &token,
            )
            .unwrap()
    else {
        panic!("expected enterprise credits")
    };
    assert_eq!(report.breakdown, "future");
    assert_eq!(report.unit.as_deref(), Some("credits"));
    assert_eq!(
        report.data_freshness_ts.as_deref(),
        Some("2026-09-22T00:00:00Z")
    );
    assert_eq!(report.data[0].values["refund"], -0.004);
    assert_eq!(report.data[0].values["model/a"], 1.25);
    assert_eq!(
        report.series,
        vec![CurrentUserCreditUsageSeries {
            key: "model/a".into(),
            label: "Model A".into(),
            total: 1.25
        }]
    );
}

#[test]
fn workspace_report_preserves_activity_models_and_grouped_costs() {
    let body = json!({
        "balance_unit":"credits","group_by":"day","breakdown_by":["model"],
        "active_users_summary":{"total_users":3,"clients":[{"client_id":"future","users":2}],"models":[{"model":"m","users":3,"threads":4,"turns":5}]},
        "data":[{"date":"2026-09-21","totals":{"users":3,"threads":4,"turns":5,"credits":1.25,"cost_usd":"0.0000000000001","text_total_tokens":99},
        "clients":[{"client_id":"future","users":2,"threads":3,"turns":4,"credits":0.0}],
        "models":[{"model":"m","speed":"fast","credits":1.25,"on_demand_credits":0.25,"text_total_tokens":99}],
        "groups":[{"dimensions":{"model":"m","new-dimension":"new"},"is_other":false,"users":3,"turns":5,"cost_usd":"0.0000000000001"}]}]
    });
    let client = Client::response(200, &body.to_string());
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let AnalyticsResponse::Messages(report) =
        BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_analytics(
                AnalyticsReport::Messages,
                "2026-09-20",
                "2026-09-21",
                &CancellationSource::new().token(),
            )
            .unwrap()
    else {
        panic!("expected workspace usage")
    };
    let active = report.active_users_summary.unwrap();
    assert_eq!(active.total_users, 3);
    assert_eq!(
        active.clients[0],
        ClientActiveUsersCount {
            client_id: "future".into(),
            users: 2
        }
    );
    assert_eq!(
        active.models.unwrap()[0],
        ModelActivitySummary {
            model: "m".into(),
            users: 3,
            threads: 4,
            turns: 5
        }
    );
    assert_eq!(report.balance_unit.as_deref(), Some("credits"));
    let day = &report.data[0];
    assert_eq!(day.date, "2026-09-21");
    assert_eq!(
        (day.totals.users, day.totals.threads, day.totals.turns),
        (3, 4, 5)
    );
    assert_eq!(day.totals.cost_usd.as_deref(), Some("0.0000000000001"));
    assert_eq!(day.totals.text_total_tokens, Some(99));
    assert_eq!(day.clients[0].cost_usd, None);
    assert_eq!(day.clients[0].credits, 0.0);
    let model = &day.models.as_ref().unwrap()[0];
    assert_eq!(model.speed.as_deref(), Some("fast"));
    assert_eq!(model.on_demand_credits, Some(0.25));
    assert_eq!(model.text_total_tokens, Some(99));
    let group = &day.groups.as_ref().unwrap()[0];
    assert_eq!(group.dimensions["new-dimension"], "new");
    assert_eq!(group.is_other, Some(false));
    assert_eq!(group.cost_usd.as_deref(), Some("0.0000000000001"));
}

#[test]
fn invocation_reports_preserve_plugin_and_skill_identity_and_counts() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let token = CancellationSource::new().token();
    let client = Client::response(
        200,
        r#"{"data":[{"date":"2026-09-21","plugin_usage_overviews":[{"plugin_id":"p","plugin_name":"review","display_name":"Review","marketplace":"company","invocation_counts":7}]}],"data_freshness_ts":"2026-09-22","group_by":"day"}"#,
    );
    let AnalyticsResponse::Plugins(report) =
        BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_analytics(
                AnalyticsReport::Plugins { limit: 10 },
                "2026-09-20",
                "2026-09-21",
                &token,
            )
            .unwrap()
    else {
        panic!("expected plugin usage")
    };
    assert_eq!(report.data_freshness_ts.as_deref(), Some("2026-09-22"));
    assert_eq!(
        report.data[0].plugin_usage_overviews,
        vec![PluginUsageOverview {
            plugin_id: Some("p".into()),
            plugin_name: "review".into(),
            display_name: "Review".into(),
            marketplace: Some("company".into()),
            invocation_counts: 7
        }]
    );
    let client = Client::response(
        200,
        r#"{"data":[{"date":"2026-09-21","skill_usage_overviews":[{"skill_name":"test","display_name":"Test","skill_ids":["local/test","plugin/test"],"invocation_counts":9}]}],"group_by":"day"}"#,
    );
    let AnalyticsResponse::Skills(report) =
        BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_analytics(
                AnalyticsReport::Skills { limit: 10 },
                "2026-09-20",
                "2026-09-21",
                &token,
            )
            .unwrap()
    else {
        panic!("expected skill usage")
    };
    assert_eq!(report.data_freshness_ts, None);
    assert_eq!(
        report.data[0].skill_usage_overviews,
        vec![SkillUsageOverview {
            skill_name: "test".into(),
            display_name: "Test".into(),
            skill_ids: vec!["local/test".into(), "plugin/test".into()],
            invocation_counts: 9
        }]
    );
}

#[test]
fn reports_reject_another_report_shape_without_exposing_body() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    let client = Client::response(
        200,
        r#"{"data":[{"date":"2026-09-21","product_surface":"private-surface","credit_amount":1}]}"#,
    );
    for report in [
        AnalyticsReport::Messages,
        AnalyticsReport::Usage,
        AnalyticsReport::Plugins { limit: 5 },
        AnalyticsReport::Skills { limit: 5 },
    ] {
        let error = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_analytics(
                report,
                "2026-09-20",
                "2026-09-21",
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, RequestError::InvalidResponse);
        assert!(!format!("{error:?} {error}").contains("private-surface"));
    }
}

#[test]
fn plan_history_preserves_approximation_freshness_and_fractional_breakdowns() {
    let target = target(CHATGPT_BACKEND_BASE_URL);
    for approximate in [json!(null), json!(false), json!(true)] {
        let client = Client::response(200, &json!({"data_as_of":"2026-09-21","coverage_start":null,"coverage_complete":true,"approximate":approximate,"boundary_tolerance_seconds":300,
            "periods":[{"id":"p","window_minutes":300,"plan_type":"plus","starts_at":"2026-09-20","ends_at":"2026-09-21","accounting_complete":true,"used_basis_points":12.75,"breakdowns":[{"dimension":"model","rows":[{"key":"m","basis_points":12.75}]}]}]}).to_string());
        let history = BackendClient::new(&client, &target, RouteStyle::ChatGpt)
            .unwrap()
            .read_plan_limit_history(&CancellationSource::new().token())
            .unwrap()
            .unwrap();
        assert_eq!(history.approximate, approximate.as_bool());
        assert_eq!(history.data_as_of.as_deref(), Some("2026-09-21"));
        assert_eq!(history.coverage_start, None);
        assert_eq!(history.boundary_tolerance_seconds, Some(300));
        assert!(history.coverage_complete);
        assert!(history.periods[0].accounting_complete);
        assert_eq!(history.periods[0].used_basis_points, Some(12.75));
        assert_eq!(
            history.periods[0].breakdowns.as_ref().unwrap()[0].rows[0],
            PlanLimitValue {
                key: "m".into(),
                basis_points: 12.75
            }
        );
    }
}

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

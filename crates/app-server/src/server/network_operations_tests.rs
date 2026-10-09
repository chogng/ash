use super::TestLoginDriver;
use super::call;
use super::initialize;
use super::server;
use ash_app_server_protocol::protocol::diagnostics::NetworkDiagnosticsRunResult;
use ash_app_server_protocol::protocol::diagnostics::NetworkReadResult;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpClientError;
use ash_http_client::HttpConnectionFailure;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_http_client::ReqwestHttpClient;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;

struct ScriptedHttp(Mutex<Vec<HttpRequest>>);
impl HttpClient for ScriptedHttp {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.0.lock().unwrap().push(request.clone());
        if request.url().contains("tls.example.test") {
            return Err(HttpClientError::Connection(HttpConnectionFailure::Tls));
        }
        if request.url().contains("large.example.test") {
            return Err(HttpClientError::ResponseTooLarge);
        }
        if request.url().contains("redirect.example.test") {
            return Err(HttpClientError::RedirectLimitExceeded);
        }
        Ok(HttpResponse::new(
            401,
            Vec::new(),
            b"secret response body".to_vec(),
        ))
    }
}

fn fixture(
    http: Arc<dyn HttpClient>,
    network: OutboundNetworkSnapshot,
    services: Vec<(String, String)>,
) -> (tempfile::TempDir, crate::AppServer) {
    let root = tempfile::tempdir().unwrap();
    let registry = model_provider_info::ProviderConfigRegistry::builtin();
    let server = server()
        .with_config_store(Arc::new(
            ash_config::ConfigStore::open(root.path().join("state.sqlite")).unwrap(),
        ))
        .with_provider_credentials(Arc::new(
            ash_model_provider::ProviderCredentialService::new(
                registry.clone(),
                Arc::new(ash_secrets::MemorySecretStore::default()),
            ),
        ))
        .with_provider_runtime(Arc::new(ash_model_provider::ModelProviderRuntime::new(
            registry,
        )))
        .with_login_service(Arc::new(
            ash_login::LoginService::new(Arc::new(TestLoginDriver::default())).unwrap(),
        ))
        .with_network_diagnostics(network, http, services);
    (root, server)
}

#[test]
fn network_diagnostics_preserves_routes_status_and_separates_each_failure_without_secrets() {
    let network = OutboundNetworkSnapshot::new(HttpClientConfig::new().with_proxy_policy(
        ProxyPolicy::Explicit("http://proxy-user:proxy-secret@proxy.example.test:8080".into()),
    ))
    .unwrap();
    let http = Arc::new(ScriptedHttp(Mutex::new(Vec::new())));
    let (_root, server) = fixture(
        http.clone(),
        network,
        vec![
            (
                "first".into(),
                "https://ok.example.test/private/path?api-key=secret-query".into(),
            ),
            ("second".into(), "https://tls.example.test/".into()),
            ("third".into(), "https://large.example.test/".into()),
            ("fourth".into(), "https://redirect.example.test/".into()),
        ],
    );
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let read = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"network/read","params":{}}),
    );
    let targets: NetworkReadResult = serde_json::from_value(read["result"].clone()).unwrap();
    assert_eq!(targets.targets.len(), 4);
    assert_eq!(
        targets.targets[0].route,
        ash_app_server_protocol::protocol::diagnostics::NetworkRouteDto::Proxy {
            host: "proxy.example.test".into(),
            port: 8080
        }
    );
    assert!(
        http.0.lock().unwrap().is_empty(),
        "domain listing must not make network requests"
    );
    let run = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":3,"method":"network/diagnostics/run","params":{}}),
    );
    let report: NetworkDiagnosticsRunResult =
        serde_json::from_value(run["result"].clone()).unwrap();
    assert_eq!(report.checks.len(), 4);
    for (connection, outcome) in [
        ("first", json!({"type":"reachable","httpStatus":401})),
        ("second", json!({"type":"failed","failure":"tls"})),
        ("third", json!({"type":"failed","failure":"request"})),
        ("fourth", json!({"type":"failed","failure":"request"})),
    ] {
        let check = run["result"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["connection"] == connection)
            .unwrap();
        assert_eq!(check["outcome"], outcome);
    }
    let requests = http.0.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].url(), "https://ok.example.test/");
    assert!(
        requests
            .iter()
            .all(|request| request.headers().is_empty() && request.body().is_empty())
    );
    for forbidden in [
        "proxy-user",
        "proxy-secret",
        "secret-query",
        "secret response body",
        "private/path",
    ] {
        assert!(!read.to_string().contains(forbidden));
        assert!(!run.to_string().contains(forbidden));
    }
}

#[test]
fn network_diagnostics_runs_the_production_transport_against_a_local_service() {
    use std::io::Read;
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 2048];
        let size = socket.read(&mut request).unwrap();
        assert!(
            std::str::from_utf8(&request[..size])
                .unwrap()
                .starts_with("GET / HTTP/1.1")
        );
        socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let http = Arc::new(ReqwestHttpClient::with_network(network.clone()).unwrap());
    let (_root, server) = fixture(http, network, Vec::new());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let configured = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"provider/configure","params":{
            "commandId":"configure-local","expectedRevision":0,"config":{
                "connection":"custom-local","provider":"custom-local","baseUrl":format!("{endpoint}v1"),
                "custom":{"name":"Local service","protocol":"responses"}
            }
        }}),
    );
    assert!(configured.get("error").is_none(), "{configured}");
    let run = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":3,"method":"network/diagnostics/run","params":{}}),
    );
    assert_eq!(
        run["result"]["network"]["targets"][0]["displayName"],
        "Local service"
    );
    assert_eq!(run["result"]["network"]["targets"][0]["purpose"], "model");
    assert_eq!(
        run["result"]["checks"][0]["outcome"],
        json!({"type":"reachable","httpStatus":404})
    );
    worker.join().unwrap();
}

#[test]
fn network_diagnostics_keeps_http_evidence_when_a_ready_accounts_usage_cannot_be_read() {
    use ash_login::AccountRef;
    use ash_login::AccountSnapshot;
    use ash_login::AccountStatus;
    use ash_login::LoginService;
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let http = Arc::new(ScriptedHttp(Mutex::new(Vec::new())));
    let (_root, server) = fixture(http.clone(), network, Vec::new());
    let server = server.with_login_service(Arc::new(
        LoginService::new(Arc::new(TestLoginDriver {
            account: Mutex::new(Some(AccountSnapshot {
                account: AccountRef {
                    provider: "chatgpt-subscription".into(),
                    account_id: "private-account".into(),
                },
                email: Some("private-email@example.test".into()),
                display_name: None,
                organization: None,
                plan: None,
                status: AccountStatus::Ready,
                credential_revision: 1,
            })),
        }))
        .unwrap(),
    ));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let run = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"network/diagnostics/run","params":{}}),
    );
    let report: NetworkDiagnosticsRunResult =
        serde_json::from_value(run["result"].clone()).unwrap();
    let hosts: std::collections::BTreeSet<_> = report
        .network
        .targets
        .iter()
        .map(|target| target.host.as_str())
        .collect();
    assert_eq!(
        hosts,
        std::collections::BTreeSet::from(["auth.openai.com", "chatgpt.com"])
    );
    assert_eq!(
        http.0.lock().unwrap().len(),
        3,
        "model, sign-in and usage routes are checked separately"
    );
    assert_eq!(report.checks.len(), 4);
    assert!(report.checks[..3].iter().all(|check| matches!(
        check.outcome,
        ash_app_server_protocol::protocol::diagnostics::NetworkCheckOutcomeDto::Reachable {
            http_status: 401
        }
    )));
    assert_eq!(
        run["result"]["checks"][3],
        json!({
            "connection":"chatgpt-subscription","targetId":null,"outcome":{"type":"failed","failure":"accountOperation"}
        })
    );
    assert!(!run.to_string().contains("private-account"));
    assert!(!run.to_string().contains("private-email"));
}

#[test]
fn http_compatibility_configuration_updates_the_live_transport_and_preserves_newer_mode_on_replay()
{
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let (_root, server) = fixture(
        Arc::new(ScriptedHttp(Mutex::new(Vec::new()))),
        network.clone(),
        Vec::new(),
    );
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let read = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"network/read","params":{}}),
    );
    assert_eq!(read["result"]["httpMode"], "http2");
    let first = json!({"jsonrpc":"2.0","id":3,"method":"network/http/configure","params":{
        "commandId":"http1","expectedRevision":read["result"]["revision"],"httpMode":"http1"
    }});
    let saved = call(&server, &mut connection, first.clone());
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(
        network.http_compatibility_mode(),
        ash_http_client::HttpCompatibilityMode::Http1
    );
    let stale = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":4,"method":"network/http/configure","params":{
            "commandId":"stale","expectedRevision":read["result"]["revision"],"httpMode":"http2"
        }}),
    );
    assert_eq!(stale["error"]["message"], "ConfigRevisionConflict");
    let next = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":5,"method":"network/http/configure","params":{
            "commandId":"http2","expectedRevision":saved["result"]["revision"],"httpMode":"http2"
        }}),
    );
    assert!(next.get("error").is_none(), "{next}");
    let mut replay_request = first;
    replay_request["id"] = json!(6);
    let replay = call(&server, &mut connection, replay_request);
    assert!(replay.get("error").is_none(), "{replay}");
    assert_eq!(replay["result"]["disposition"], "replayed");
    assert_eq!(
        network.http_compatibility_mode(),
        ash_http_client::HttpCompatibilityMode::Http2
    );
    let invalid = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":7,"method":"network/http/configure","params":{
            "commandId":"invalid","expectedRevision":next["result"]["revision"],"httpMode":"http3"
        }}),
    );
    assert!(invalid.get("error").is_some());
    let final_read = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":8,"method":"network/read","params":{}}),
    );
    assert_eq!(final_read["result"]["httpMode"], "http2");
    assert_eq!(final_read["result"]["revision"], next["result"]["revision"]);
}

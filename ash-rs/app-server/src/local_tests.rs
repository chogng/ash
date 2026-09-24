use super::*;
use crate::ConnectionState;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::DirConfigScope;
use ash_config::DirConfigStore;
use ash_config::PreferencesUpdate;
use ash_config::ResolvedConfig;
use ash_config::UserConfigCommand;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_file_access::Dir;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelId;
use ash_model_provider::ModelInvoker;
use ash_model_provider::ModelProviderError;
use ash_model_provider::ProviderId;
use ash_model_provider_config::ApiProfile;
use ash_model_provider_config::EndpointPolicy;
use ash_model_provider_config::ModelCatalogPolicy;
use ash_model_provider_config::ModelContextConfig;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderAdapter;
use ash_model_provider_config::ProviderDefinition;
use ash_plugin::LocalPluginPackage;
use ash_protocol::CommandId;
use ash_protocol::ImageDetail;
use ash_protocol::ModelImageInputLimits;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::Patch;
use ash_protocol::ReasoningEffort;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;
use ash_secrets::MemorySecretStore;
use ash_web_search_extension::WebSearchBackend;
use ash_web_search_extension::WebSearchError;
use ash_web_search_extension::WebSearchRequest;
use ash_web_search_extension::WebSearchResponse;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::Condvar;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

fn config_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ash-app-server-{label}-{}-{}.authority.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn dir_config_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ash-app-server-dir-{label}-{}-{}.toml",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn connector_plugin(root: &Path) -> LocalPluginPackage {
    std::fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    std::fs::create_dir_all(root.join("mcp")).unwrap();
    std::fs::write(
        root.join(".ash-plugin/plugin.json"),
        r#"{
            "schemaVersion": 1,
            "id": "acme/live",
            "version": "1.0.0",
            "displayName": "Live Plugin",
            "compatibility": {"ash": ">=0.1.0"},
            "contributions": {
                "mcpServers": [{"id": "live", "definition": "mcp/live.json"}],
                "connectors": [{
                    "id": "account",
                    "displayName": "Live account",
                    "description": "A live activation test connector.",
                    "mcpServer": "live"
                }]
            },
            "permissions": [{"type": "network", "hosts": ["example.com"]}],
            "credentialSlots": [{
                "name": "token",
                "kind": "secretText",
                "requiredFor": ["connector:account", "mcp:live"]
            }]
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("mcp/live.json"),
        r#"{"transport":{"type":"streamableHttp","url":"https://example.com/mcp"}}"#,
    )
    .unwrap();
    LocalPluginPackage::load(root).unwrap()
}

fn plugin_request(
    authority: &PluginActivationAuthority,
    command_id: &str,
    command: PluginAuthorityCommand,
) -> PluginAuthorityCommandRequest {
    PluginAuthorityCommandRequest {
        command_id: PluginAuthorityCommandId::new(command_id).unwrap(),
        expected_revision: authority.snapshot().revision(),
        command,
    }
}

fn connector_count(server: &AppServer, connection: &mut ConnectionState, request_id: u64) -> usize {
    let response: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "connector/list",
                "params": {}
            })
            .to_string(),
        ),
    )
    .unwrap();
    response["result"]["connectors"].as_array().unwrap().len()
}

fn local_call(
    server: &AppServer,
    connection: &mut ConnectionState,
    request: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}

fn wait_for_connector_count(
    server: &AppServer,
    connection: &mut ConnectionState,
    expected: usize,
    request_id: &mut u64,
) {
    for _ in 0..100 {
        *request_id += 1;
        if connector_count(server, connection, *request_id) == expected {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("Connector projection did not reach {expected} entries");
}

fn run_local_git(root: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "user.name=Ash App Server Test",
            "-c",
            "user.email=ash-app-server@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

#[test]
fn local_composition_reads_empty_subscription_accounts_before_sign_in() {
    let profile = tempfile::tempdir().unwrap();
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .with_codex_home(profile.path().join("codex"))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral),
    )
    .unwrap();
    let mut connection = server.connection();
    let initialized = server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#,
    );
    assert!(initialized.contains("\"result\""));

    let account = server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}"#,
    );
    let account: serde_json::Value = serde_json::from_str(&account).unwrap();
    assert_eq!(account["result"]["accounts"], serde_json::json!([]));
}

#[test]
fn local_composition_reads_existing_grok_login_without_importing_it() {
    let profile = tempfile::tempdir().unwrap();
    let grok_auth = profile.path().join("grok-auth.json");
    let contents = serde_json::to_vec(&serde_json::json!({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
            "key": "existing-grok-access",
            "refresh_token": "grok-owned-refresh",
            "auth_mode": "oidc",
            "user_id": "user-a",
            "principal_id": "principal-a",
            "team_id": "team-a",
            "email": "person@example.test",
            "expires_at": "2099-01-01T00:00:00Z"
        }
    }))
    .unwrap();
    std::fs::write(&grok_auth, &contents).unwrap();
    let client = Arc::new(AccountUsageClient {
        response: Mutex::new((
            200,
            serde_json::json!({
                "userId": "user-a",
                "principalId": "principal-a",
                "teamId": "team-a",
                "email": "person@example.test",
                "subscriptionTier": "SuperGrokPro"
            }),
        )),
        requests: Mutex::new(Vec::new()),
        during_request: Mutex::new(None),
    });
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .with_grok_auth_file(&grok_auth)
            .with_codex_home(profile.path().join("codex"))
            .with_model_operation_client(client.clone())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral),
    )
    .unwrap();
    let mut connection = server.connection();
    server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#,
    );
    let account: serde_json::Value = serde_json::from_str(&server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}"#,
    ))
    .unwrap();
    let xai = account["result"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["provider"] == "xai-subscription")
        .expect("xAI account missing");
    assert_eq!(xai["status"], "ready");
    assert_eq!(xai["email"], "person@example.test");
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    assert_eq!(std::fs::read(&grok_auth).unwrap(), contents);
}

struct AccountUsageClient {
    response: Mutex<(u16, serde_json::Value)>,
    requests: Mutex<Vec<ClientRequest>>,
    during_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl OperationClient for AccountUsageClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some(action) = self.during_request.lock().unwrap().take() {
            action();
        }
        let (status, body) = self.response.lock().unwrap().clone();
        Ok(ClientResponse::new(
            status,
            Vec::new(),
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}

#[test]
fn local_account_rate_limits_use_the_signed_in_account_and_redact_failures() {
    use base64::Engine;
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let jwt = |value: serde_json::Value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    let auth = serde_json::to_vec(&serde_json::json!({
        "auth_mode":"chatgpt", "tokens": {
            "id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1","chatgpt_plan_type":"plus"}})),
            "access_token":jwt(serde_json::json!({"exp":4_000_000_000_u64})),
            "refresh_token":"never-used", "account_id":"account-1"
        }, "last_refresh":"2026-09-01T00:00:00Z"
    })).unwrap();
    std::fs::write(home.path().join("auth.json"), &auth).unwrap();
    let client = Arc::new(AccountUsageClient {
        response: Mutex::new((
            200,
            serde_json::json!({"plan_type":"plus",
                "rate_limit":{"allowed":true,"limit_reached":false,
                    "primary_window":{"used_percent":35,"limit_window_seconds":18000,"reset_at":2000000000}},
                "credits":{"has_credits":false,"unlimited":false,"balance":null}
            }),
        )),
        requests: Mutex::new(Vec::new()),
        during_request: Mutex::new(None),
    });
    let server = Arc::new(
        open_local_app_server(
            LocalAppServerOptions::new(profile.path())
                .with_codex_home(home.path())
                .with_model_operation_client(client.clone())
                .without_built_in_skills()
                .with_session_state_mode(SessionStateMode::Ephemeral),
        )
        .unwrap(),
    );
    let mut connection = server.connection();
    local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"usage-test","version":"1"},"capabilities":{}}
        }),
    );
    let mut next_id = 2;
    let mut read = |connection: &mut ConnectionState, provider: &str, account: &str| {
        let id = next_id;
        next_id += 1;
        local_call(
            &server,
            connection,
            serde_json::json!({
            "jsonrpc":"2.0","id":id,"method":"account/rateLimits/read",
                "params":{"provider":provider,"accountId":account}
            }),
        )
    };
    assert_eq!(
        read(&mut connection, "kimi", "account-1")["error"]["message"],
        "AccountRateLimitsUnavailable"
    );
    assert_eq!(
        read(&mut connection, "openai-chatgpt", "account-2")["error"]["message"],
        "AccountChanged"
    );
    assert_eq!(
        read(&mut connection, "openai-chatgpt", "")["error"]["message"],
        "InvalidParams"
    );
    assert!(client.requests.lock().unwrap().is_empty());
    let result = read(&mut connection, "openai-chatgpt", "account-1");
    assert_eq!(
        result["result"],
        serde_json::json!({
            "provider":"openai-chatgpt","accountId":"account-1","plan":"plus",
            "limits":[{"id":"codex","name":null,"model":null,"allowed":true,"limitReached":false,
                "primary":{"usedPercent":35,"windowSeconds":18000,"resetsAt":2000000000},"secondary":null}],
            "credits":{"hasCredits":false,"unlimited":false,"balance":null}
        })
    );
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url(),
        "https://chatgpt.com/backend-api/wham/usage"
    );
    assert!(
        requests[0]
            .headers()
            .iter()
            .any(|header| header.name() == "ChatGPT-Account-ID" && header.value() == "account-1")
    );
    drop(requests);
    for status in [200, 403, 429, 503] {
        *client.response.lock().unwrap() = (
            status,
            serde_json::json!({"private":"sensitive-upstream-body"}),
        );
        let failed = read(&mut connection, "openai-chatgpt", "account-1");
        assert_eq!(failed["error"]["message"], "AccountOperationFailed");
        assert!(!failed.to_string().contains("sensitive-upstream-body"));
    }
    assert_eq!(std::fs::read(home.path().join("auth.json")).unwrap(), auth);
    let mut closing = server.connection();
    local_call(
        &server,
        &mut closing,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"closing-usage-test","version":"1"},"capabilities":{}}
        }),
    );
    let closed = closing.clone();
    let host = Arc::clone(&server);
    *client.during_request.lock().unwrap() = Some(Box::new(move || host.close_connection(closed)));
    let cancelled = read(&mut closing, "openai-chatgpt", "account-1");
    assert_eq!(cancelled["error"]["message"], "RequestCancelled");
    assert_eq!(cancelled["error"]["code"], -32800);
    std::fs::remove_file(home.path().join("auth.json")).unwrap();
    assert_eq!(
        read(&mut connection, "openai-chatgpt", "account-1")["error"]["message"],
        "AccountUnavailable"
    );
    assert_eq!(client.requests.lock().unwrap().len(), 6);
}

#[test]
fn local_codex_account_reconnects_without_oauth_and_observes_external_logout() {
    use base64::Engine;
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let jwt = |value: serde_json::Value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    let auth = serde_json::to_vec(&serde_json::json!({
        "auth_mode":"chatgpt", "OPENAI_API_KEY":null,
        "tokens": {"id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1","chatgpt_plan_type":"pro"}})),"access_token":jwt(serde_json::json!({"exp":4_000_000_000_u64})),"refresh_token":"never-used","account_id":"account-1"},
        "last_refresh":"2026-09-07T00:00:00Z"
    })).unwrap();
    std::fs::write(home.path().join("auth.json"), &auth).unwrap();
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .with_codex_home(home.path())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral),
    )
    .unwrap();
    let mut connection = server.connection();
    let mut call = |id: u64, method: &str, params: serde_json::Value| -> serde_json::Value {
        serde_json::from_str(
            &server.handle_json(
                &mut connection,
                &serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                    .to_string(),
            ),
        )
        .unwrap()
    };
    call(
        1,
        "initialize",
        serde_json::json!({"clientInfo":{"name":"auth-test","version":"1"},"capabilities":{}}),
    );
    assert_eq!(
        call(2, "account/read", serde_json::json!({}))["result"]["accounts"][0]["plan"],
        "pro"
    );
    assert_eq!(
        call(
            3,
            "account/logout",
            serde_json::json!({"provider":"openai-chatgpt"})
        )["result"]["status"],
        "loggedOut"
    );
    assert_eq!(
        call(4, "account/read", serde_json::json!({}))["result"]["accounts"],
        serde_json::json!([])
    );
    assert_eq!(
        call(
            5,
            "account/login/start",
            serde_json::json!({"method":{"type":"openAiChatGptDeviceCode"}})
        )["result"]["type"],
        "connected"
    );
    assert_eq!(
        call(6, "account/read", serde_json::json!({}))["result"]["accounts"][0]["status"],
        "ready"
    );
    assert!(auth == std::fs::read(home.path().join("auth.json")).unwrap());
    std::fs::remove_file(home.path().join("auth.json")).unwrap();
    assert_eq!(
        call(7, "account/read", serde_json::json!({}))["result"]["accounts"],
        serde_json::json!([])
    );
}

#[test]
fn local_codex_expiration_reports_external_login_and_reconnects_after_renewal() {
    use base64::Engine;
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let jwt = |value: serde_json::Value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    let mut document = serde_json::json!({"auth_mode":"chatgpt","tokens":{
        "id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{
            "chatgpt_user_id":"user-1","chatgpt_account_id":"account-1"
        }})),"access_token":jwt(serde_json::json!({"exp":1})),"refresh_token":"private-refresh","account_id":"account-1"
    }});
    let path = home.path().join("auth.json");
    let original = serde_json::to_vec(&document).unwrap();
    std::fs::write(&path, &original).unwrap();
    let client = Arc::new(AccountUsageClient {
        response: Mutex::new((500, serde_json::json!({}))),
        requests: Mutex::new(Vec::new()),
        during_request: Mutex::new(None),
    });
    let auth = ash_chatgpt::ChatGptOAuth::with_client(
        home.path().into(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        ash_chatgpt::ChatGptAuthManagement::Codex,
    );
    let login = Arc::new(ash_login::LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&login).unwrap();
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .with_codex_home(home.path())
            .with_model_operation_client(client.clone())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral),
    )
    .unwrap()
    .with_login_service(login);
    let mut connection = server.connection();
    local_call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"clientInfo":{"name":"login-test","version":"1"},"capabilities":{}}}),
    );
    let start = |id| {
        serde_json::json!({"jsonrpc":"2.0","id":id,"method":"account/login/start",
        "params":{"method":{"type":"openAiChatGptDeviceCode"}}})
    };
    let failure = local_call(&server, &mut connection, start(2));
    assert_eq!(
        failure["error"],
        serde_json::json!({"code":-32030,
        "message":"AccountExternalLoginRequired","data":{"kind":"AccountExternalLoginRequired"}})
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(client.requests.lock().unwrap().is_empty());
    document["tokens"]["access_token"] = jwt(serde_json::json!({"exp":4_000_000_000_u64})).into();
    std::fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    assert_eq!(
        local_call(&server, &mut connection, start(3))["result"]["type"],
        "connected"
    );
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn local_git_turn_changes_seal_and_commit_a_shell_turn_through_rpc() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    run_local_git(dir.path(), &["init", "--quiet", "--initial-branch=main"]);
    run_local_git(dir.path(), &["config", "user.name", "Ash App Server Test"]);
    run_local_git(
        dir.path(),
        &["config", "user.email", "ash-app-server@example.invalid"],
    );
    std::fs::write(dir.path().join("README.md"), "initial\n").unwrap();
    run_local_git(dir.path(), &["add", "."]);
    run_local_git(dir.path(), &["commit", "--quiet", "-m", "initial"]);
    let initial_head = run_local_git(dir.path(), &["rev-parse", "HEAD"]);
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(dir.path()),
    )
    .unwrap();
    let mut connection = server.connection();
    let initialized = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"turn-changes-test","version":"1"},"capabilities":{}}
        }),
    );
    assert!(initialized["result"].is_object());
    let shell_rule = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1000,"method":"execPolicy/rule/upsert",
            "params":{
                "commandId":"allow-shell-turn","expectedRevision":0,
                "rule":{
                    "id":"allow-shell-turn",
                    "selector":{
                        "type":"source",
                        "source":"built_in_tool",
                        "sourceId":"shell-command"
                    },
                    "effect":{"type":"allowUnsandboxed"},
                    "justification":"test authorizes the isolated temporary repository"
                }
            }
        }),
    );
    assert_eq!(shell_rule["result"]["revision"], 1);
    let session = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"session/create",
            "params":{"commandId":"create-session","title":"Turn changes"}
        }),
    );
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"session/request",
            "params":{
                "commandId":"create-thread","sessionId":session_id,"expectedSequence":1,
                "request":{"type":"createThread","title":"root"}
            }
        }),
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let write_command = if cfg!(windows) {
        "echo sealed turn contents>turn.txt"
    } else {
        "printf 'sealed turn contents\\n' > turn.txt"
    };
    let started = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/request",
            "params":{
                "commandId":"write-turn-file","sessionId":session_id,
                "request":{
                    "type":"startShellTurn","threadId":thread_id,
                    "expectedSequence":1,"approvalMode":"bypassPermissions",
                    "command":write_command,"workingDirectory":"."
                }
            }
        }),
    );
    assert!(started["result"]["value"]["turnId"].is_string());
    let thread_id_typed = ash_protocol::ThreadId::new(thread_id).unwrap();
    for _ in 0..200 {
        let completed = server
            .threads()
            .read_thread(&thread_id_typed)
            .unwrap()
            .turns
            .last()
            .is_some_and(|turn| turn.status == ash_protocol::TurnStatus::Completed);
        if completed {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    let mut request_id = 6;
    let change_set = loop {
        let listed = local_call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0","id":request_id,"method":"turnChanges/list",
                "params":{"sessionId":session_id,"threadId":thread_id}
            }),
        );
        if listed["result"]["changeSets"][0]["captureState"] == "sealed" {
            break listed["result"]["changeSets"][0].clone();
        }
        request_id += 1;
        assert!(
            request_id < 206,
            "ChangeSet did not seal: {listed}; thread: {:#?}",
            server.threads().read_thread(&thread_id_typed).unwrap()
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(
        change_set["statistics"]["files"],
        1,
        "unexpected ChangeSet: {change_set}; thread: {:#?}",
        server.threads().read_thread(&thread_id_typed).unwrap()
    );
    assert_eq!(change_set["messageState"], "unconfigured");
    let change_set_id = change_set["changeSetId"].as_str().unwrap();
    request_id += 1;
    let drafted = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":request_id,"method":"turnChanges/updateDraft",
            "params":{
                "commandId":"draft-turn-message","sessionId":session_id,"threadId":thread_id,
                "changeSetId":change_set_id,"expectedRevision":change_set["revision"],
                "message":"test(turn-changes): commit sealed shell turn"
            }
        }),
    );
    let drafted_revision = drafted["result"]["changeSets"][0]["revision"]
        .as_u64()
        .unwrap();
    request_id += 1;
    let queued = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":request_id,"method":"turnChanges/commit",
            "params":{
                "commandId":"commit-shell-turn","sessionId":session_id,"threadId":thread_id,
                "changeSetIds":[change_set_id],"expectedRevision":drafted_revision
            }
        }),
    );
    assert_eq!(queued["result"]["changeSets"][0]["commitState"], "queued");
    loop {
        request_id += 1;
        let listed = local_call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0","id":request_id,"method":"turnChanges/list",
                "params":{"sessionId":session_id,"threadId":thread_id}
            }),
        );
        let state = &listed["result"]["changeSets"][0]["commitState"];
        if state == "committed" {
            break;
        }
        assert!(
            state == "queued" || state == "committing",
            "commit failed: {listed}"
        );
        assert!(request_id < 406, "commit did not finish: {listed}");
        std::thread::sleep(Duration::from_millis(10));
    }

    assert_ne!(
        run_local_git(dir.path(), &["rev-parse", "HEAD"]),
        initial_head
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("turn.txt"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["sealed turn contents"]
    );
    assert_eq!(
        run_local_git(dir.path(), &["show", "-s", "--format=%s", "HEAD"]),
        "test(turn-changes): commit sealed shell turn"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn managed_network_approval_resumes_the_same_shell_process_through_rpc() {
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::time::Instant;
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    origin.set_nonblocking(true).unwrap();
    let port = origin.local_addr().unwrap().port();
    let denied_origin = TcpListener::bind("127.0.0.1:0").unwrap();
    denied_origin.set_nonblocking(true).unwrap();
    let denied_port = denied_origin.local_addr().unwrap().port();
    let upstream = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut stream = loop {
            match origin.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("approved request did not reach origin: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut buffer = [0; 4096];
        assert!(stream.read(&mut buffer).unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\napproved")
            .unwrap();
    });
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(dir.path()),
    )
    .unwrap();
    let mut connection = server.connection();
    let initialized = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"network-test","version":"1"},"capabilities":{"agentInteractions":{"version":1,"kinds":["approval"]}}}
        }),
    );
    assert!(initialized["result"].is_object(), "{initialized}");
    let configured = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"execPolicy/rule/upsert","params":{
                "commandId":"ask-network","expectedRevision":0,
                "rule":{"id":"ask-network","selector":{"type":"network","protocol":"http","host":{"type":"exact","value":"127.0.0.1"},"port":port},"effect":{"type":"requireApproval"}}
            }
        }),
    );
    assert_eq!(configured["result"]["revision"], 1, "{configured}");
    let shell_grant = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"execPolicy/rule/upsert","params":{
                "commandId":"allow-shell-process","expectedRevision":1,
                "rule":{"id":"allow-shell-process","selector":{"type":"all","selectors":[
                    {"type":"source","source":"built_in_tool","sourceId":"shell-command"},
                    {"type":"actionKind","actionKind":"localProcess"}
                ]},"effect":{"type":"allowUnsandboxed"}}
            }
        }),
    );
    assert_eq!(shell_grant["result"]["revision"], 2, "{shell_grant}");
    let denied_rule = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"execPolicy/rule/upsert","params":{
                "commandId":"deny-network","expectedRevision":2,
                "rule":{"id":"deny-network","selector":{"type":"network","host":{"type":"exact","value":"127.0.0.1"},"port":denied_port},"effect":{"type":"deny","reason":"host must stay blocked"}}
            }
        }),
    );
    assert_eq!(denied_rule["result"]["revision"], 3, "{denied_rule}");
    let session = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"session/create","params":{"commandId":"network-session","title":"Network"}
        }),
    );
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request","params":{"commandId":"network-thread","sessionId":session_id,"expectedSequence":1,"request":{"type":"createThread","title":"Network"}}
        }),
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let thread_id_typed = ash_protocol::ThreadId::new(thread_id).unwrap();
    let mut digests = Vec::new();
    let subscribed = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/thread/subscribe","params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}
        }),
    );
    assert!(subscribed["result"].is_object(), "{subscribed}");
    for (index, decision, expected_status) in [(0, "approveOnce", 0), (1, "decline", 22)] {
        let before = server.threads().read_thread(&thread_id_typed).unwrap();
        let started = local_call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0","id":10+index,"method":"session/request","params":{
                    "commandId":format!("network-turn-{index}"),"sessionId":session_id,
                    "request":{"type":"startShellTurn","threadId":thread_id,"expectedSequence":before.sequence,
                        "approvalMode":"askPermissions","command":format!("printf run >> attempts-{index}.txt; /usr/bin/curl -fsS --max-time 10 http://127.0.0.1:{port}/; printf '|status=%s|attempts=' $?; cat attempts-{index}.txt; /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:{denied_port}/; printf '|denied=%s' $?"),"workingDirectory":"."}
                }
            }),
        );
        let turn_id = started["result"]["value"]["turnId"]
            .as_str()
            .unwrap_or_else(|| panic!("{started}"));
        let deadline = Instant::now() + Duration::from_secs(8);
        let pending = loop {
            let snapshot = server.threads().read_thread(&thread_id_typed).unwrap();
            if let Some(pending) = snapshot.turns.last().unwrap().pending_interaction.clone() {
                break (snapshot.sequence, pending);
            }
            assert!(
                Instant::now() < deadline,
                "network approval missing: {snapshot:#?}"
            );
            thread::sleep(Duration::from_millis(5));
        };
        let ash_protocol::AgentRequest::Approval { request } = &pending.1.request else {
            panic!("expected network approval");
        };
        assert_eq!(request.capabilities.len(), 1);
        assert_eq!(
            request.capabilities[0].kind,
            ash_protocol::ActionApprovalCapabilityKind::Network
        );
        assert_eq!(
            request.capabilities[0].scope,
            format!("http://127.0.0.1:{port}")
        );
        assert!(request.sandbox_denial.is_none());
        digests.push(request.action_digest.clone());
        assert!(
            server
                .drain_notifications(&mut connection)
                .iter()
                .any(|notification| notification.contains("agent/request"))
        );
        let resolved = local_call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0","id":20+index,"method":"session/request","params":{"commandId":format!("network-approval-{index}"),"sessionId":session_id,
                    "request":{"type":"resolveInteraction","threadId":thread_id,"turnId":turn_id,"expectedSequence":pending.0,"requestId":pending.1.request_id,"response":{"type":"approval","response":{"decision":decision}}}}
            }),
        );
        assert!(resolved["result"].is_object(), "{resolved}");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = server.threads().read_thread(&thread_id_typed).unwrap();
            if snapshot.turns.last().unwrap().status == ash_protocol::TurnStatus::Completed {
                assert!(snapshot.items.iter().any(|item| matches!(item, ash_protocol::ThreadItem::ToolResult { text, .. } if text.contains(&format!("status={expected_status}|attempts=run")) && !text.contains("attempts=runrun"))), "{snapshot:#?}");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "approved shell did not complete: {snapshot:#?}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    assert_ne!(digests[0], digests[1]);
    assert_eq!(
        denied_origin.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    upstream.join().unwrap();
}

#[test]
fn non_git_turns_keep_their_isolated_dir_without_creating_change_sets() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("README.md"), "plain directory\n").unwrap();
    let server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(dir.path()),
    )
    .unwrap();
    let mut connection = server.connection();
    local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"non-git-turn-test","version":"1"},"capabilities":{}}
        }),
    );
    let shell_rule = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"execPolicy/rule/upsert",
            "params":{
                "commandId":"allow-non-git-shell","expectedRevision":0,
                "rule":{
                    "id":"allow-non-git-shell",
                    "selector":{
                        "type":"source",
                        "source":"built_in_tool",
                        "sourceId":"shell-command"
                    },
                    "effect":{"type":"allowUnsandboxed"},
                    "justification":"test authorizes the isolated temporary directory"
                }
            }
        }),
    );
    assert_eq!(shell_rule["result"]["revision"], 1);
    let session = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"session/create",
            "params":{"commandId":"create-non-git-session","title":"Plain directory"}
        }),
    );
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"create-non-git-thread","sessionId":session_id,"expectedSequence":1,
                "request":{"type":"createThread","title":"root"}
            }
        }),
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let write_command = if cfg!(windows) {
        "echo plain turn contents>turn.txt"
    } else {
        "printf 'plain turn contents\\n' > turn.txt"
    };
    local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/request",
            "params":{
                "commandId":"write-non-git-turn","sessionId":session_id,
                "request":{
                    "type":"startShellTurn","threadId":thread_id,
                    "expectedSequence":1,"approvalMode":"bypassPermissions",
                    "command":write_command,"workingDirectory":"."
                }
            }
        }),
    );
    let thread_id_typed = ash_protocol::ThreadId::new(thread_id).unwrap();
    for _ in 0..200 {
        if server
            .threads()
            .read_thread(&thread_id_typed)
            .unwrap()
            .turns
            .last()
            .is_some_and(|turn| turn.status == ash_protocol::TurnStatus::Completed)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let listed = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"turnChanges/list",
            "params":{"sessionId":session_id,"threadId":thread_id}
        }),
    );
    assert_eq!(listed["result"]["changeSets"], serde_json::json!([]));
    assert_eq!(
        listed["result"]["dir"]["repositories"],
        serde_json::json!([])
    );
    assert_eq!(
        listed["result"]["dir"]["baselineSummary"],
        "isolated non-Git directory copy"
    );
}

#[test]
fn shared_profile_runtime_shares_sessions_across_env_hosts() {
    let profile = tempfile::tempdir().unwrap();
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    let open = |dir: &Path| {
        open_local_app_server(
            LocalAppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::clone(&runtime))
                .with_dir_root(dir)
                .without_built_in_skills(),
        )
        .unwrap()
    };
    let first = open(first_dir.path());
    let second = open(second_dir.path());
    let mut first_connection = first.connection();
    let mut second_connection = second.connection();
    for (server, connection) in [
        (&first, &mut first_connection),
        (&second, &mut second_connection),
    ] {
        let initialized = server.handle_json(
            connection,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#,
        );
        assert!(initialized.contains("\"result\""));
    }

    let created: serde_json::Value = serde_json::from_str(&first.handle_json(
        &mut first_connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"create-shared","title":"Shared task"}}"#,
    ))
    .unwrap();
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    assert!(created["result"]["session"].get("workspace").is_none());

    let listed: serde_json::Value = serde_json::from_str(&second.handle_json(
        &mut second_connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}"#,
    ))
    .unwrap();
    assert_eq!(listed["result"]["sessions"][0]["sessionId"], session_id);
    let subscribed = second.handle_json(
        &mut second_connection,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/subscribe",
            "params": {"sessionId": session_id, "afterSequence": 1}
        })
        .to_string(),
    );
    assert!(subscribed.contains("\"result\""));
    let created_thread = first.handle_json(
        &mut first_connection,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/request",
            "params": {
                "commandId": "create-thread",
                "sessionId": session_id,
                "expectedSequence": 1,
                "request": {"type": "createThread", "title": "Shared thread"}
            }
        })
        .to_string(),
    );
    assert!(created_thread.contains("\"result\""));
    let notifications = second.drain_notifications(&mut second_connection);
    assert!(
        notifications
            .iter()
            .any(|notification| notification.contains("session/changed"))
    );
    let completed: serde_json::Value = serde_json::from_str(
        &second.handle_json(
            &mut second_connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "session/request",
                "params": {
                    "commandId": "archive-shared",
                    "sessionId": session_id,
                    "request": {"type": "archive"}
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(
        completed["result"]["value"]["session"]["status"],
        "archived"
    );
}

#[test]
fn user_network_config_is_loaded_before_start_and_reconciled_on_edit() {
    let profile = tempfile::tempdir().unwrap();
    let config_path = profile.path().join("config.toml");
    std::fs::write(
        &config_path,
        format!(
            "schemaVersion = {}\n[network]\nallowedHosts = ['api.example.com']\n",
            ash_config::CONFIG_FILE_SCHEMA_VERSION
        ),
    )
    .unwrap();
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    assert!(
        runtime
            .network_policy
            .check_url("https://api.example.com/v1")
            .is_ok()
    );
    assert!(
        runtime
            .network_policy
            .check_url("https://other.example.com/v1")
            .is_err()
    );
    let _server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .with_profile_runtime(Arc::clone(&runtime))
            .without_built_in_skills(),
    )
    .unwrap();
    std::fs::write(
        &config_path,
        format!(
            "schemaVersion = {}\n[network]\nallowedHosts = []\n",
            ash_config::CONFIG_FILE_SCHEMA_VERSION
        ),
    )
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while runtime
        .network_policy
        .check_url("https://api.example.com/v1")
        .is_ok()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "network policy did not update"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn shared_profile_runtime_reuses_one_durable_secret_store_across_env_hosts() {
    let profile = tempfile::tempdir().unwrap();
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    let open = |dir: &Path| {
        open_local_app_server(
            LocalAppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::clone(&runtime))
                .with_dir_root(dir)
                .without_built_in_skills(),
        )
        .unwrap()
    };
    let first = open(first_dir.path());
    let second = open(second_dir.path());
    let mut first_connection = first.connection();
    let mut second_connection = second.connection();
    for (server, connection) in [
        (&first, &mut first_connection),
        (&second, &mut second_connection),
    ] {
        let initialized = server.handle_json(
            connection,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#,
        );
        assert!(initialized.contains("\"result\""));
    }

    let saved: serde_json::Value = serde_json::from_str(&first.handle_json(
        &mut first_connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"provider/apiKey/set","params":{"provider":"openai","apiKey":"shared-secret"}}"#,
    ))
    .unwrap();
    assert_eq!(saved["result"]["apiKeyConfigured"], true);
    assert!(!saved.to_string().contains("shared-secret"));

    let listed: serde_json::Value = serde_json::from_str(&second.handle_json(
        &mut second_connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"provider/list","params":{}}"#,
    ))
    .unwrap();
    assert!(
        listed["result"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |provider| provider["provider"] == "openai" && provider["apiKeyConfigured"] == true
            )
    );
    assert_eq!(
        std::fs::read_dir(profile.path().join("secrets/values"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn shared_profile_runtime_rejects_a_second_secret_store_authority() {
    let profile = tempfile::tempdir().unwrap();
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    let authority = PluginActivationAuthority::open(profile.path().join("plugins")).unwrap();
    let options = LocalAppServerOptions::new(profile.path())
        .with_profile_runtime(runtime)
        .without_built_in_skills()
        .with_plugin_authority(authority, Arc::new(MemorySecretStore::default()))
        .unwrap();

    let error = match open_local_app_server(options) {
        Ok(_) => panic!("a second profile SecretStore authority must be rejected"),
        Err(error) => error,
    };
    assert_eq!(
        error.0,
        "shared profile runtime and Connector runtime use different SecretStore authorities"
    );
}

#[test]
fn shared_profile_runtime_owns_exactly_one_marketplace_authority() {
    let profile = tempfile::tempdir().unwrap();
    let runtime = LocalProfileRuntime::open(profile.path()).unwrap();
    let first_config = ash_core_plugins::RemoteMarketplaceConfig::new(
        "https://marketplace.example/metadata/".parse().unwrap(),
        "https://marketplace.example/targets/".parse().unwrap(),
        vec![1],
        profile.path().join("cache-a"),
    )
    .unwrap();
    let vendor = ash_core_plugins::RemoteMarketplaceConfig::new(
        "https://vendor.example/metadata/".parse().unwrap(),
        "https://vendor.example/targets/".parse().unwrap(),
        vec![3],
        profile.path().join("vendor-cache"),
    )
    .unwrap();
    let first_config = BTreeMap::from([
        (
            ash_plugin::MarketplaceName::new("ash").unwrap(),
            first_config,
        ),
        (ash_plugin::MarketplaceName::new("vendor").unwrap(), vendor),
    ]);
    let first = runtime.plugins_manager(first_config.clone()).unwrap();
    let reused = runtime.plugins_manager(first_config).unwrap();
    assert!(Arc::ptr_eq(&first, &reused));
    assert!(!profile.path().join("vendor-cache").exists());

    let second_config = ash_core_plugins::RemoteMarketplaceConfig::new(
        "https://other.example/metadata/".parse().unwrap(),
        "https://other.example/targets/".parse().unwrap(),
        vec![2],
        profile.path().join("cache-b"),
    )
    .unwrap();
    let second_config = BTreeMap::from([(
        ash_plugin::MarketplaceName::new("ash").unwrap(),
        second_config,
    )]);
    let error = match runtime.plugins_manager(second_config) {
        Ok(_) => panic!("a second Marketplace authority must be rejected"),
        Err(error) => error,
    };
    assert_eq!(
        error.0,
        "one profile runtime cannot use multiple Marketplace authorities"
    );
}

#[test]
fn live_plugin_authority_reconciles_connector_projection() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let plugin_root = profile.path().join("plugins");
    let store = PluginPackageStore::open(&plugin_root).unwrap();
    let installed = store
        .install_local(&connector_plugin(source.path()))
        .unwrap();
    let authority = PluginActivationAuthority::open(&plugin_root).unwrap();
    authority
        .apply(plugin_request(
            &authority,
            "install-live",
            PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        ))
        .unwrap();
    let options = LocalAppServerOptions::new(profile.path())
        .without_built_in_skills()
        .with_session_state_mode(SessionStateMode::Ephemeral)
        .with_plugin_authority(authority.clone(), Arc::new(MemorySecretStore::default()))
        .unwrap();
    let server = open_local_app_server(options).unwrap();
    let mut connection = server.connection();
    let initialize = server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#,
    );
    assert!(initialize.contains("\"result\""));
    let mut request_id = 1;
    wait_for_connector_count(&server, &mut connection, 0, &mut request_id);

    authority
        .apply(plugin_request(
            &authority,
            "grant-live",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(plugin_request(
            &authority,
            "enable-live",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        ))
        .unwrap();
    wait_for_connector_count(&server, &mut connection, 1, &mut request_id);

    authority
        .apply(plugin_request(
            &authority,
            "disable-live",
            PluginAuthorityCommand::Disable { package: installed },
        ))
        .unwrap();
    wait_for_connector_count(&server, &mut connection, 0, &mut request_id);
}

struct LocalSemanticEmbedding;

impl EmbeddingInvoker for LocalSemanticEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|_| EmbeddingVector::new(vec![1.0, 0.0]))
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

#[test]
fn local_composition_installs_models_before_dir_activation() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    std::fs::write(dir.path().join("lib.rs"), "pub fn indexed() {}\n").unwrap();
    let models = CodebaseModels::new(
        ash_codebase::EmbeddingIndexKey::new("local-test-v1").unwrap(),
        Arc::new(LocalSemanticEmbedding),
    );
    let options = LocalAppServerOptions::new(profile.path())
        .with_dir_root(dir.path())
        .without_built_in_skills()
        .with_session_state_mode(SessionStateMode::Ephemeral);

    let server = open_local_app_server_with_codebase_providers(
        options,
        LocalCodebaseProviders::new().with_models(models),
    )
    .unwrap();

    assert!(server.codebase_semantic_service().is_some());
}

#[test]
fn local_composition_restores_codebase_generation_after_reopen() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    std::fs::write(
        dir.path().join("lib.rs"),
        "pub fn restored_after_reopen() -> bool { true }\n",
    )
    .unwrap();
    let open = || {
        open_local_app_server(
            LocalAppServerOptions::new(profile.path())
                .with_dir_root(dir.path())
                .without_built_in_skills()
                .with_session_state_mode(SessionStateMode::Ephemeral),
        )
        .unwrap()
    };

    let server = open();
    let mut connection = server.connection();
    let initialized = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"state-reopen-test","version":"1"},"capabilities":{}}
        }),
    );
    assert_eq!(initialized["result"]["capabilities"]["codebase"], true);
    let rebuilt = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"codebase/rebuild","params":{}
        }),
    );
    let generation = rebuilt["result"]["generation"].as_u64().unwrap();
    assert!(generation > 0);
    assert_eq!(rebuilt["result"]["state"], "ready");
    drop(connection);
    drop(server);

    {
        let dir_root = ash_file_access::Dir::open_local(dir.path()).unwrap();
        let state = ash_state::StateRuntime::open(profile.path()).unwrap();
        let store = ash_codebase_store::CodebaseStore::open(&state, &dir_root.id()).unwrap();
        let restored = store
            .open_codebase(dir_root, ash_codebase::CodebaseLimits::default())
            .unwrap()
            .snapshot()
            .unwrap();
        assert_eq!(restored.generation, generation);
    }

    let reopened = open();
    let mut reopened_connection = reopened.connection();
    local_call(
        &reopened,
        &mut reopened_connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"state-reopen-test","version":"1"},"capabilities":{}}
        }),
    );
    let mut request_id = 2;
    let status = loop {
        let status = local_call(
            &reopened,
            &mut reopened_connection,
            serde_json::json!({
                "jsonrpc":"2.0","id":request_id,"method":"codebase/status","params":{}
            }),
        );
        if status["result"]["state"] == "ready" {
            break status;
        }
        assert_eq!(status["result"]["state"], "indexing");
        request_id += 1;
        assert!(request_id < 102, "restored codebase did not become ready");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status["result"]["state"], "ready");
    assert!(status["result"]["generation"].as_u64().unwrap() >= generation);
    let search = local_call(
        &reopened,
        &mut reopened_connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":request_id + 1,"method":"codebase/search",
            "params":{"query":"restored_after_reopen","maxResults":10}
        }),
    );
    assert_eq!(search["result"]["hits"][0]["path"], "lib.rs");
}

#[test]
fn initial_dir_without_permissions_remains_restricted() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("readable.txt"), "restricted\n").unwrap();
    let options = LocalAppServerOptions::new(profile.path())
        .with_user_config_dir_root(dir.path())
        .without_built_in_skills()
        .with_session_state_mode(SessionStateMode::Ephemeral);

    let server = open_local_app_server(options).unwrap();

    assert!(!server.selected_dir_allows(ash_file_access::Permission::ExecuteCommands));
}

struct UnusedSearchBackend;

impl WebSearchBackend for UnusedSearchBackend {
    fn service_name(&self) -> &str {
        "test search"
    }

    fn network_scopes(&self) -> Vec<String> {
        vec!["search.example.com".into()]
    }

    fn credential_reference(&self) -> Option<String> {
        None
    }

    fn search(
        &self,
        _: &WebSearchRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<WebSearchResponse, WebSearchError> {
        panic!("composition test does not execute search")
    }
}

#[test]
fn local_web_search_is_absent_by_default_and_registered_when_injected() {
    let profile = tempfile::tempdir().unwrap();
    let default_server = open_local_app_server(
        LocalAppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral),
    )
    .unwrap();
    assert!(
        default_server
            .local_env_tool_ports()
            .unwrap()
            .definitions()
            .iter()
            .all(|definition| definition.name.as_str() != "web_search")
    );

    let injected_profile = tempfile::tempdir().unwrap();
    let injected_server = open_local_app_server(
        LocalAppServerOptions::new(injected_profile.path())
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_web_search_backend(Arc::new(UnusedSearchBackend)),
    )
    .unwrap();
    assert!(
        injected_server
            .local_env_tool_ports()
            .unwrap()
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "web_search")
    );
}

fn remove_config_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("toml"));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
}

fn model_ref(model: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new("test").unwrap(),
        ModelId::new(model).unwrap(),
    )
}

#[test]
fn configured_model_context_enables_core_managed_compaction() {
    let provider = ProviderId::new("openai").unwrap();
    let model = ModelId::new("gpt-5.6").unwrap();
    let mut provider_config = ModelProviderConfig::new(provider.clone());
    provider_config.max_output_tokens = Some(2_048);
    provider_config.model_context = BTreeMap::from([(
        model.clone(),
        ModelContextConfig {
            context_window: 20_000,
            auto_compact_token_limit: Some(15_000),
        },
    )]);
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.json")).unwrap());
    let configured = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-context").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: provider.clone(),
                config: provider_config,
            },
        })
        .unwrap();
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-context-model").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                model: Patch::Value(ModelRef::new(provider.clone(), model.clone())),
                ..Default::default()
            }),
        })
        .unwrap();
    let provider_configs = ProviderConfigRegistry::builtin();
    let catalog_provider = Arc::new(ModelProviderRuntime::new(provider_configs.clone()));
    let service = ConfigBackedModelService {
        config,
        dir_config: None,
        provider_configs,
        models_manager: catalog_provider.models_manager(),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver {
            gate: Arc::new(ResponseGate::default()),
        }),
    };
    assert_eq!(
        service
            .context_budget(ModelSelection::ConfiguredDefault)
            .unwrap(),
        ContextBudget::core_managed(
            ContextTokenCount::new(20_000),
            ContextTokenCount::new(2_048),
            ContextTokenCount::new(MODEL_CONTEXT_SAFETY_MARGIN_TOKENS),
            ContextCompactionLimit::Tokens(ContextTokenCount::new(15_000)),
        )
    );
    let models = service.list().unwrap();
    let entry = models
        .iter()
        .find(|entry| entry.model == ModelRef::new(provider.clone(), model.clone()))
        .unwrap();
    assert_eq!(entry.context_window, Some(20_000));
    assert_eq!(entry.auto_compact_token_limit, Some(15_000));
    assert_eq!(entry.available_context_window, Some(11_928));
    let serialized = serde_json::to_value(entry).unwrap();
    assert_eq!(serialized["contextWindow"], 20_000);
    assert_eq!(serialized["autoCompactTokenLimit"], 15_000);
    assert_eq!(serialized["availableContextWindow"], 11_928);
}

#[test]
fn config_backed_model_service_resolves_model_reasoning_effort() {
    let provider = ProviderId::new("openai").unwrap();
    let model = ModelId::new("gpt-5.6").unwrap();
    let provider_config = ModelProviderConfig::new(provider.clone());
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.json")).unwrap());
    let configured = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-provider").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: provider.clone(),
                config: provider_config,
            },
        })
        .unwrap();
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-model-with-effort").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                time_context: ash_protocol::Patch::Missing,
                model: Patch::Value(ModelRef::new(provider.clone(), model.clone())),
                model_reasoning_effort: Patch::Value(ReasoningEffort::High),
                ..Default::default()
            }),
        })
        .unwrap();
    let provider_configs = ProviderConfigRegistry::builtin();
    let catalog_provider = Arc::new(ModelProviderRuntime::new(provider_configs.clone()));
    let service = ConfigBackedModelService {
        config,
        dir_config: None,
        provider_configs,
        models_manager: catalog_provider.models_manager(),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver {
            gate: Arc::new(ResponseGate::default()),
        }),
    };
    assert_eq!(
        service
            .reasoning_config(ModelSelection::ConfiguredDefault)
            .unwrap(),
        Some(ash_protocol::ReasoningConfig {
            effort: ReasoningEffort::High,
            summary: false,
        })
    );
}

fn configure_test_provider(config: &ConfigStore, revision: ConfigRevision) -> ConfigRevision {
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new(format!("configure-test-{}", revision.get())).unwrap(),
            expected_revision: revision,
            command: UserConfigCommand::ConfigureProvider {
                provider: ProviderId::new("test").unwrap(),
                config: ModelProviderConfig::new(ProviderId::new("test").unwrap()),
            },
        })
        .unwrap()
        .revision
}

fn select_model(
    config: &ConfigStore,
    command_id: &str,
    revision: ConfigRevision,
    model: &str,
) -> ConfigRevision {
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new(command_id).unwrap(),
            expected_revision: revision,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                advisor: Default::default(),
                time_context: ash_protocol::Patch::Missing,
                features: Default::default(),
                model: Patch::Value(model_ref(model)),
                model_reasoning_effort: Patch::Missing,
                approval_review_model: Patch::Missing,
                commit_message_model: Patch::Missing,
                tool_mode: Patch::Missing,
                grep_backend: Patch::Missing,
                git: Patch::Missing,
                gui: Patch::Missing,
                tui: Patch::Missing,
            }),
        })
        .unwrap()
        .revision
}

#[derive(Default)]
struct GateState {
    entered: bool,
    released: bool,
}

#[derive(Default)]
struct ResponseGate {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl ResponseGate {
    fn wait_until_entered(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.entered {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn wait_until_released(&self) {
        let mut state = self.state.lock().unwrap();
        state.entered = true;
        self.changed.notify_all();
        while !state.released {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.released = true;
        self.changed.notify_all();
    }
}

struct RecordingSnapshotResolver {
    gate: Arc<ResponseGate>,
}

#[derive(Default)]
struct RecordingModelProvider {
    request: Mutex<Option<ModelRuntimeRequest>>,
}

impl ModelProvider for RecordingModelProvider {
    fn runtime(
        &self,
        request: ModelRuntimeRequest,
    ) -> Result<Arc<dyn ModelInvoker>, ModelProviderError> {
        *self.request.lock().unwrap() = Some(request);
        Ok(Arc::new(UnavailableModel::new("recorded")))
    }
}

#[test]
fn configured_provider_resolves_default_model_with_its_saved_endpoint() {
    let path = config_path("provider-default-runtime");
    let store = ConfigStore::open(&path).unwrap();
    let mut config = ModelProviderConfig::new(ProviderId::new("openai").unwrap());
    config.base_url = Some("https://proxy.example.test/v1".into());
    store
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-default").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: config.provider.clone(),
                config: config.clone(),
            },
        })
        .unwrap();
    let provider = Arc::new(RecordingModelProvider::default());
    let resolver = ModelProviderSnapshotResolver {
        model_provider: provider.clone(),
    };
    let _ = resolver.resolve(&store.read_snapshot().unwrap().values);
    let request = provider.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        request.model,
        ModelRef::new(
            ProviderId::new("openai").unwrap(),
            ModelId::new("gpt-6-astra").unwrap(),
        )
    );
    assert_eq!(request.config, config);
    drop(store);
    remove_config_files(&path);
}

#[test]
fn subscription_model_resolution_does_not_require_an_api_key_provider_config() {
    let provider = Arc::new(RecordingModelProvider::default());
    let resolver = ModelProviderSnapshotResolver {
        model_provider: provider.clone(),
    };
    let config = ResolvedConfig {
        model: Some(ModelRef::new(
            ProviderId::new("openai").unwrap(),
            ModelId::new("gpt-5.6-sol").unwrap(),
        )),
        ..ResolvedConfig::default()
    };

    let _ = resolver.resolve(&config);

    let request = provider.request.lock().unwrap().clone().unwrap();
    assert_eq!(request.model, config.model.unwrap());
    assert_eq!(request.config.provider.as_str(), "openai");
    assert_eq!(request.config.base_url, None);
}

impl ModelSnapshotResolver for RecordingSnapshotResolver {
    fn resolve(&self, config: &ResolvedConfig) -> Arc<dyn ModelInvoker> {
        Arc::new(SnapshotModel {
            model: config
                .model
                .as_ref()
                .map(|model| model.model.as_str().to_owned())
                .unwrap_or_else(|| "unconfigured".into()),
            gate: self.gate.clone(),
        })
    }
}

struct SnapshotModel {
    model: String,
    gate: Arc<ResponseGate>,
}

impl ModelInvoker for SnapshotModel {
    fn image_input_policy(&self) -> ModelImageInputPolicy {
        let dimension = if self.model == "before-update" {
            800
        } else {
            1_200
        };
        let limits = ModelImageInputLimits::new(dimension, 1_000);
        ModelImageInputPolicy::new(limits, limits, limits, limits)
    }

    fn output_transport(&self) -> ash_protocol::ModelOutputTransport {
        ash_protocol::ModelOutputTransport::Unary
    }

    fn stream_with_cancellation(
        &self,
        _: &ModelRequest,
        _: &ash_async_utils::CancellationToken,
        _: &mut dyn ash_model_provider::ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        self.gate.wait_until_released();
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(self.model.clone())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

#[test]
fn model_invocations_and_image_limits_keep_an_in_flight_snapshot() {
    let path = config_path("model-snapshot");
    let config = Arc::new(ConfigStore::open(&path).unwrap());
    let configured = configure_test_provider(&config, ConfigRevision::INITIAL);
    let before_update = select_model(&config, "select-before", configured, "before-update");
    let gate = Arc::new(ResponseGate::default());
    let provider_configs = test_provider_registry();
    let catalog_provider = Arc::new(ModelProviderRuntime::new(provider_configs.clone()));
    let model = Arc::new(ConfigBackedModelService {
        config: config.clone(),
        dir_config: None,
        provider_configs: provider_configs.clone(),
        models_manager: ModelsManager::new(provider_configs),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver { gate: gate.clone() }),
    });
    let frozen = model
        .snapshot(ModelSelection::ConfiguredDefault)
        .unwrap()
        .unwrap();
    let in_flight_model = model.clone();
    let in_flight = thread::spawn(move || invoke_text(in_flight_model.as_ref(), "first"));
    gate.wait_until_entered();
    assert_eq!(
        model
            .image_input_policy(ModelSelection::ConfiguredDefault)
            .unwrap()
            .limits_for(ImageDetail::Auto),
        ModelImageInputLimits::new(800, 1_000)
    );
    select_model(&config, "select-after", before_update, "after-update");
    gate.release();

    assert_eq!(in_flight.join().unwrap(), "before-update");
    assert_eq!(
        invoke_text(frozen.as_ref(), "advisor evidence"),
        "before-update"
    );
    assert_eq!(invoke_text(model.as_ref(), "second"), "after-update");
    assert_eq!(
        frozen
            .image_input_policy(ModelSelection::ConfiguredDefault)
            .unwrap()
            .limits_for(ImageDetail::Auto),
        ModelImageInputLimits::new(800, 1_000)
    );
    assert_eq!(
        model
            .image_input_policy(ModelSelection::ConfiguredDefault)
            .unwrap()
            .limits_for(ImageDetail::Auto),
        ModelImageInputLimits::new(1_200, 1_000)
    );
    remove_config_files(&path);
}

#[test]
fn local_model_resolution_applies_dir_model_at_the_next_safe_point() {
    let config_path = config_path("dir-model");
    let config = Arc::new(ConfigStore::open(&config_path).unwrap());
    let configured = configure_test_provider(&config, ConfigRevision::INITIAL);
    select_model(&config, "select-user", configured, "user-model");

    let path = dir_config_path("dir-model");
    std::fs::write(
        &path,
        r#"
[agent.model]
provider = "test"
model = "dir-model"
"#,
    )
    .unwrap();
    let dir = Arc::new(DirConfigTracker::new(DirConfigStore::open(
        &path,
        DirConfigScope::new(Dir::open_local(path.parent().unwrap()).unwrap().id()),
    )));
    let provider_configs = test_provider_registry();
    let catalog_provider = Arc::new(ModelProviderRuntime::new(provider_configs.clone()));
    let model = ConfigBackedModelService {
        config: config.clone(),
        dir_config: Some(dir.clone()),
        provider_configs: provider_configs.clone(),
        models_manager: ModelsManager::new(provider_configs),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver {
            gate: Arc::new(ResponseGate::default()),
        }),
    };

    let user = config.read_snapshot().unwrap();
    assert_eq!(
        model
            .resolve_config(&user)
            .unwrap()
            .model
            .unwrap()
            .model
            .as_str(),
        "dir-model"
    );
    let (_, initial_revision) = dir.read().unwrap();
    std::fs::write(&path, "").unwrap();
    let (_, changed_revision) = dir.read().unwrap();
    assert_eq!(changed_revision.get(), initial_revision.get() + 1);

    remove_config_files(&config_path);
    let _ = std::fs::remove_file(path);
}

#[test]
fn local_catalog_projects_static_models_without_runtime_availability() {
    let path = config_path("models-manager-catalog");
    let config = Arc::new(ConfigStore::open(&path).unwrap());
    let configured = configure_test_provider(&config, ConfigRevision::INITIAL);
    select_model(&config, "select-custom", configured, "custom-model");
    let provider_configs = test_provider_registry();
    let catalog_provider = Arc::new(ModelProviderRuntime::new(provider_configs.clone()));
    let model = ConfigBackedModelService {
        config,
        dir_config: None,
        provider_configs: provider_configs.clone(),
        models_manager: ModelsManager::new(provider_configs),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver {
            gate: Arc::new(ResponseGate::default()),
        }),
    };

    let models = model.list().unwrap();

    let api_models = models
        .iter()
        .filter(|entry| {
            entry.model.provider.as_str() == "openai"
                && entry.access == ash_protocol::ModelAccess::ApiKey
        })
        .map(|entry| entry.model.model.as_str())
        .collect::<Vec<_>>();
    assert_eq!(api_models, ["gpt-6-astra", "gpt-5.6"]);

    let custom = models
        .iter()
        .find(|entry| entry.model == model_ref("custom-model"))
        .unwrap();
    assert_eq!(custom.display_name, "custom-model");
    assert_eq!(custom.access, ash_protocol::ModelAccess::Unknown);
    assert_eq!(custom.context_window, None);
    assert_eq!(
        custom.capabilities,
        ash_protocol::ModelCapabilities::UNKNOWN
    );
    let openai = models
        .iter()
        .find(|entry| {
            entry.model.provider.as_str() == "openai" && entry.model.model.as_str() == "gpt-5.6"
        })
        .unwrap();
    assert_eq!(openai.access, ash_protocol::ModelAccess::ApiKey);
    assert_eq!(openai.context_window, None);
    assert_eq!(
        openai.capabilities.image_detail_original,
        ash_protocol::CapabilitySupport::Supported
    );
    remove_config_files(&path);
}

struct OllamaCatalogClient;

#[test]
fn custom_provider_discovery_preserves_configured_model_choices() {
    struct Client {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl OperationClient for Client {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            assert_eq!(request.url(), "https://example.test/v1/models");
            match self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                1 => return Ok(ClientResponse::new(200, vec![], br#"{"data":[]}"#.to_vec())),
                2 => {
                    return Ok(ClientResponse::new(
                        401,
                        vec![],
                        b"secret-response".to_vec(),
                    ));
                }
                _ => {}
            }
            Ok(ClientResponse::new(
                200,
                vec![],
                br#"{"data":[{"id":"custom-model"}]}"#.to_vec(),
            ))
        }
    }
    let path = config_path("custom-model-catalog");
    let config = Arc::new(ConfigStore::open(&path).unwrap());
    let provider = ProviderId::new("custom-example").unwrap();
    let mut connection = ModelProviderConfig::new(provider.clone());
    connection.base_url = Some("https://example.test/v1".into());
    connection.custom = Some(ash_model_provider_config::CustomProviderConfig {
        context_window: 272_000,
        order: 0,
        model: None,
        name: "Example".into(),
        protocol: ash_model_provider_config::CustomProviderProtocol::Responses,
    });
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("create-custom").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: provider.clone(),
                config: connection,
            },
        })
        .unwrap();
    let client = Arc::new(Client {
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let provider_configs = ProviderConfigRegistry::builtin();
    let catalog_provider = Arc::new(ModelProviderRuntime::with_client(
        provider_configs.clone(),
        client.clone(),
    ));
    let model = ConfigBackedModelService {
        config,
        dir_config: None,
        provider_configs,
        models_manager: catalog_provider.models_manager(),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver {
            gate: Arc::new(ResponseGate::default()),
        }),
    };
    let configured = model.config.read_snapshot().unwrap();
    let initial = model.list().unwrap();
    assert_eq!(
        initial
            .iter()
            .filter(|entry| entry.model.provider == provider)
            .map(|entry| entry.model.model.as_str())
            .collect::<Vec<_>>(),
        ["gpt-5.6", "gpt-6-astra", "grok-4.5"]
    );
    assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    let fetched = model.refresh(&provider).unwrap();
    assert_eq!(
        fetched
            .iter()
            .map(|entry| entry.model.clone())
            .collect::<Vec<_>>(),
        [ModelRef::new(
            provider.clone(),
            ModelId::new("custom-model").unwrap(),
        )]
    );
    assert_eq!(model.list().unwrap(), initial);
    assert_eq!(model.config.read_snapshot().unwrap(), configured);
    assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(model.refresh(&provider).unwrap().is_empty());
    assert_eq!(model.list().unwrap(), initial);
    assert_eq!(model.config.read_snapshot().unwrap(), configured);
    assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(
        model.refresh(&provider),
        Err(crate::model_catalog::ModelCatalogRefreshError::Authentication)
    );
    assert_eq!(model.list().unwrap(), initial);
    assert_eq!(model.config.read_snapshot().unwrap(), configured);
    assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(model.refresh(&provider).unwrap(), fetched);
    assert_eq!(model.list().unwrap(), initial);
    assert_eq!(model.config.read_snapshot().unwrap(), configured);
    assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 4);

    let mut connection = configured.values.providers[&provider].clone();
    connection.custom.as_mut().unwrap().model = Some(fetched[0].model.model.clone());
    model
        .config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-discovered-model").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::ConfigureProvider {
                provider: provider.clone(),
                config: connection,
            },
        })
        .unwrap();
    assert_eq!(
        model
            .list()
            .unwrap()
            .into_iter()
            .filter(|entry| entry.model.provider == provider)
            .collect::<Vec<_>>(),
        fetched
    );
    assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 4);
    drop(model);
    remove_config_files(&path);
}

impl OperationClient for OllamaCatalogClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        let body = match request.url() {
            "http://localhost:11434/api/tags" => br#"{"models":[{"name":"qwen3:8b"}]}"#.to_vec(),
            "http://localhost:11434/api/show" => {
                br#"{"capabilities":["completion","tools"]}"#.to_vec()
            }
            endpoint => panic!("unexpected Ollama endpoint: {endpoint}"),
        };
        Ok(ClientResponse::new(200, Vec::new(), body))
    }
}

#[test]
fn local_catalog_includes_models_installed_in_configured_ollama() {
    let path = config_path("ollama-model-catalog");
    let config = Arc::new(ConfigStore::open(&path).unwrap());
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-ollama").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: ProviderId::new("ollama").unwrap(),
                config: ModelProviderConfig::new(ProviderId::new("ollama").unwrap()),
            },
        })
        .unwrap();
    let provider_configs = ProviderConfigRegistry::builtin();
    let catalog_provider = Arc::new(ModelProviderRuntime::with_client(
        provider_configs.clone(),
        Arc::new(OllamaCatalogClient),
    ));
    let model = ConfigBackedModelService {
        config,
        dir_config: None,
        provider_configs,
        models_manager: catalog_provider.models_manager(),
        catalog_provider,
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(RecordingSnapshotResolver {
            gate: Arc::new(ResponseGate::default()),
        }),
    };

    let models = model.list().unwrap();

    assert!(models.iter().any(|entry| {
        entry.model.provider.as_str() == "ollama" && entry.model.model.as_str() == "qwen3:8b"
    }));
    remove_config_files(&path);
}

fn invoke_text(model: &dyn ModelService, prompt: &str) -> String {
    model
        .invoke(
            core_api::ModelSelection::ConfiguredDefault,
            &ModelRequest::text(prompt),
            &CancellationSource::new().token(),
        )
        .unwrap()
        .text()
}

fn test_provider_registry() -> ProviderConfigRegistry {
    let mut registry = ProviderConfigRegistry::builtin();
    registry
        .register(ProviderDefinition::new(
            ProviderId::new("test").unwrap(),
            "Test",
            ProviderAdapter::OpenAiCompatible,
            ApiProfile::OpenAiChatCompletions,
            EndpointPolicy::ConfiguredOnly,
            ModelCatalogPolicy::AllowUnlisted,
        ))
        .unwrap();
    registry
}

#[test]
fn missing_model_or_provider_is_a_configuration_failure_before_invocation() {
    let provider = Arc::new(RecordingModelProvider::default());
    let resolver = ModelProviderSnapshotResolver {
        model_provider: provider.clone(),
    };
    for config in [
        ResolvedConfig::default(),
        ResolvedConfig {
            model: Some(ModelRef::new(
                ProviderId::new("openai-compatible").unwrap(),
                ModelId::new("missing").unwrap(),
            )),
            ..ResolvedConfig::default()
        },
    ] {
        let model = resolver.resolve(&config);
        assert_eq!(
            model.invoke(&ash_protocol::ModelRequest::text("hello")),
            Err(ModelProviderError::ConfigurationMissing)
        );
        assert!(provider.request.lock().unwrap().is_none());
    }
}

#[test]
fn message_restore_points_preserve_git_versions_after_restart() {
    let profile = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    run_local_git(repo.path(), &["init", "--quiet", "--initial-branch=main"]);
    // Content assertions compare checkout bytes, so pin the test repository
    // away from the machine's core.autocrlf setting.
    run_local_git(repo.path(), &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.path().join("tracked.txt"), "initial\n").unwrap();
    run_local_git(repo.path(), &["add", "."]);
    run_local_git(repo.path(), &["commit", "--quiet", "-m", "initial"]);
    let options = || {
        LocalAppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_dir_root(repo.path())
    };
    let server = open_local_app_server(options()).unwrap();
    let mut connection = server.connection();
    let initialize_request = || serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"message-checkpoints","version":"1"},"capabilities":{}}});
    local_call(&server, &mut connection, initialize_request());
    let policy = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"execPolicy/rule/upsert",
            "params":{"commandId":"allow-shell","expectedRevision":0,"rule":{"id":"allow-shell","selector":{"type":"source","source":"built_in_tool","sourceId":"shell-command"},"effect":{"type":"allowUnsandboxed"},"justification":"test owns this temporary repository"}}
        }),
    );
    assert!(policy.get("error").is_none(), "{policy}");
    let session = local_call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/create","params":{"commandId":"root","title":"Restore messages"}}),
    );
    let session_id = session["result"]["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let thread_id = session["result"]["session"]["threads"][0]["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    let command = if cfg!(windows) {
        "echo changed>tracked.txt"
    } else {
        "printf 'changed\\n' > tracked.txt"
    };
    let started = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request","params":{"commandId":"write","sessionId":session_id,
            "request":{"type":"startShellTurn","threadId":thread_id,"expectedSequence":1,"approvalMode":"bypassPermissions","command":command,"workingDirectory":"."}}
        }),
    );
    assert!(started.get("error").is_none(), "{started}");
    let mut request_id = 10;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        request_id += 1;
        let changes = local_call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":request_id,"method":"turnChanges/list","params":{"sessionId":session_id,"threadId":thread_id}}),
        );
        if changes["result"]["changeSets"][0]["captureState"] == "sealed" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "shell Turn did not seal: {changes}; snapshot: {:?}",
            server
                .threads()
                .read_thread(&ash_protocol::ThreadId::new(thread_id.clone()).unwrap())
                .unwrap()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    request_id += 1;
    let checkpoints = local_call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":request_id,"method":"session/thread/checkpoints","params":{"sessionId":session_id,"threadId":thread_id}}),
    );
    let points = checkpoints["result"]["checkpoints"].as_array().unwrap();
    assert_eq!(points.len(), 2, "{checkpoints}");
    assert!(
        points
            .iter()
            .all(|point| point["workspace"]["type"] == "git"),
        "{checkpoints}"
    );
    let before_item = points[0]["itemId"].as_str().unwrap().to_string();
    let after_item = points[1]["itemId"].as_str().unwrap().to_string();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let worktrees =
        worktree::WorktreeManager::new(worktree::WorktreeSettings::defaults(profile.path()));
    for (id, item, boundary, expected) in [
        ("before", &before_item, "before", "initial"),
        ("after", &after_item, "after", "changed"),
    ] {
        request_id += 1;
        let restored = local_call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":request_id,"method":"session/request","params":{"commandId":id,"sessionId":session_id,
            "request":{"type":"restoreMessage","threadId":thread_id,"itemId":item,"boundary":boundary,"title":id}}}),
        );
        assert!(restored.get("error").is_none(), "{restored}");
        let restored_id = restored["result"]["value"]["threadId"].as_str().unwrap();
        let directories = runtime.block_on(worktrees.list(repo.path())).unwrap();
        let directory = directories
            .iter()
            .find(|directory| directory.owner_thread_id() == Some(restored_id))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.dir().join("tracked.txt"))
                .unwrap()
                .trim(),
            expected
        );
    }
    assert_eq!(
        std::fs::read_to_string(repo.path().join("tracked.txt")).unwrap(),
        "initial\n"
    );
    assert!(
        !run_local_git(repo.path(), &["for-each-ref", "refs/ash/messages/"])
            .trim()
            .is_empty()
    );
    drop(connection);
    drop(server);
    // Remove test-owned linked directories, leaving only retained message refs and history.
    // Recovery must not consult an old Thread binding or a surviving checkout.
    for owner in [&thread_id, "restore:after"] {
        let directories = runtime.block_on(worktrees.list(repo.path())).unwrap();
        let directory = directories
            .iter()
            .find(|directory| directory.owner_thread_id() == Some(owner))
            .unwrap();
        let path = directory.checkout_root().to_str().unwrap();
        run_local_git(repo.path(), &["worktree", "unlock", path]);
        run_local_git(repo.path(), &["worktree", "remove", "--force", path]);
    }
    run_local_git(repo.path(), &["gc", "--prune=now"]);
    let reopened = open_local_app_server(options()).unwrap();
    let mut connection = reopened.connection();
    local_call(&reopened, &mut connection, initialize_request());
    let restored = local_call(
        &reopened,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/request","params":{"commandId":"after-restart","sessionId":session_id,
        "request":{"type":"restoreMessage","threadId":"restore:after","itemId":before_item,"boundary":"before","title":"after restart"}}}),
    );
    assert!(restored.get("error").is_none(), "{restored}");
    let directories = runtime.block_on(worktrees.list(repo.path())).unwrap();
    let directory = directories
        .iter()
        .find(|directory| directory.owner_thread_id() == Some("restore:after-restart"))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(directory.dir().join("tracked.txt")).unwrap(),
        "initial\n"
    );
    let deleted = local_call(
        &reopened,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/request","params":{"commandId":"delete","sessionId":session_id,"request":{"type":"delete"}}}),
    );
    assert!(deleted.get("error").is_none(), "{deleted}");
    let remaining = run_local_git(repo.path(), &["for-each-ref", "refs/ash/messages/"]);
    assert!(
        remaining.trim().is_empty(),
        "message refs survived: {remaining}"
    );
}

#[test]
fn xai_subscription_catalog_drives_model_selection_context_and_invocation() {
    use ash_secrets::SecretStore;
    struct Proxy;
    impl OperationClient for Proxy {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            assert_eq!(
                request.url(),
                "https://cli-chat-proxy.grok.com/v1/models-v2"
            );
            Ok(ClientResponse::new(200, vec![], br#"{"data":[{"model":"grok-test","apiBackend":"responses","contextWindow":500000,"reasoningEfforts":["high"],"reasoningEffort":"high"}]}"#.to_vec()))
        }
        fn execute_streaming(
            &self,
            request: &ClientRequest,
            sink: &mut dyn ash_client::OperationStreamSink,
        ) -> Result<ClientResponse, ClientError> {
            assert_eq!(
                request.url(),
                "https://cli-chat-proxy.grok.com/v1/responses"
            );
            let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
            assert_eq!(body["model"], "grok-test");
            sink.emit(b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}}\n\n")?;
            Ok(ClientResponse::new(200, vec![], vec![]))
        }
    }
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.json")).unwrap());
    let secrets = Arc::new(MemorySecretStore::default());
    secrets.store(&ash_secrets::SecretKey::new("provider/xai/current/oauth").unwrap(), &ash_secrets::SecretValue::new(br#"{"access_token":"fixture","refresh_token":"fixture-refresh","token_type":"Bearer","scope":"","expires_at":4102444800,"account_id":"a","credential_revision":1}"#.to_vec())).unwrap();
    let client = Arc::new(Proxy);
    let auth = xai::XaiOAuth::with_client(secrets, client.clone(), profile.path().join("xai.lock"));
    let registry = ProviderConfigRegistry::builtin();
    let runtime =
        Arc::new(ModelProviderRuntime::with_client(registry.clone(), client).with_xai_oauth(auth));
    let service = ConfigBackedModelService {
        config: config.clone(),
        dir_config: None,
        provider_configs: registry,
        models_manager: runtime.models_manager(),
        catalog_provider: runtime.clone(),
        catalog_runtime: Arc::new(tokio::runtime::Runtime::new().unwrap()),
        resolver: Arc::new(ModelProviderSnapshotResolver {
            model_provider: runtime,
        }),
    };
    let entries = service.list().unwrap();
    let model = ModelRef::new(
        ProviderId::new("xai-subscription").unwrap(),
        ModelId::new("grok-test").unwrap(),
    );
    let entry = entries.iter().find(|entry| entry.model == model).unwrap();
    assert_eq!(entry.access, ModelAccess::Subscription);
    assert_eq!(entry.context_window, Some(500000));
    let configured = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("configure-xai").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureProvider {
                provider: model.provider.clone(),
                config: ModelProviderConfig::new(model.provider.clone()),
            },
        })
        .unwrap();
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("select-xai").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                model: Patch::Value(model),
                ..Default::default()
            }),
        })
        .unwrap();

    assert_eq!(
        service
            .billing_scope(ModelSelection::ConfiguredDefault)
            .unwrap(),
        ModelBillingScope::SubscriptionPlan
    );
    assert!(matches!(
        service
            .context_budget(ModelSelection::ConfiguredDefault)
            .unwrap()
            .resolve()
            .unwrap(),
        ResolvedContextBudget::CoreManaged(_)
    ));
    assert_eq!(
        service
            .reasoning_config(ModelSelection::ConfiguredDefault)
            .unwrap()
            .unwrap()
            .effort,
        ReasoningEffort::High
    );
    assert_eq!(invoke_text(&service, "hi"), "hello");
}

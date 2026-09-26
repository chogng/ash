#[path = "audio_tests.rs"]
mod audio_tests;

use super::*;

#[cfg(target_os = "macos")]
#[path = "sleep_tests.rs"]
mod sleep_tests;

#[path = "checkpoint_live_tests.rs"]
mod checkpoint_live_tests;

#[path = "memories_live_tests.rs"]
mod memories_live_tests;

#[path = "automation_tests.rs"]
mod automation_tests;
#[path = "infrastructure_tests.rs"]
mod infrastructure_tests;
#[path = "memory_tests.rs"]
mod memory_tests;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ProcessInvocationKind;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandArgumentModeDto;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandDefinition;
use ash_async_utils::CancellationToken;
use ash_config::ConfigStore;
use ash_core::InMemoryThreadStore;
use ash_core::RequestTurnInteraction;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::ToolAuthorization;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::GrantSource;
use ash_file_access::Permission as DirPermission;
use ash_file_access::Permissions;
use ash_file_system::LocalFileSystem;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::AccountStatus;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::CompleteLogin;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginCompletionOutcome;
use ash_login::LoginError;
use ash_login::LoginId;
use ash_login::LoginService;
use ash_model_provider::EchoModel;
use ash_protocol::ActionApprovalCapability;
use ash_protocol::ActionApprovalCapabilityKind;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::AgentRequest;
use ash_protocol::CommandId;
use ash_protocol::ContentPart;
use ash_protocol::InputItem;
use ash_protocol::InteractionDeadline;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ProviderId;
use ash_protocol::RequestId;
use ash_protocol::RequestUserInput;
use ash_protocol::ResponseItem;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::StopReason;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretStore;
use ash_uds::UnixStream;
use base64::Engine;
use core_api::ActionPolicyService;
use core_api::CoreError;
use core_api::ModelService;
use std::io::Cursor;
use std::io::Write;
use std::net::Shutdown;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[test]
fn xai_account_and_usage_rpc_use_the_subscription_backend_and_observe_logout() {
    use ash_client::ClientError;
    use ash_client::ClientRequest;
    use ash_client::ClientResponse;
    use ash_client::OperationClient;
    use ash_secrets::SecretStore;
    struct Proxy {
        requests: Mutex<Vec<String>>,
        status: AtomicUsize,
    }
    impl OperationClient for Proxy {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.url().to_owned());
            let status = self.status.load(Ordering::SeqCst) as u16;
            let body = match request
                .url()
                .strip_prefix("https://cli-chat-proxy.grok.com/v1/")
                .unwrap()
            {
                "user?include=subscription" => {
                    r#"{"userId":"user-a","email":"ada@example.test","firstName":"Ada","subscriptionTier":"SuperGrokPro"}"#
                }
                "settings" => {
                    r#"{"subscription_tier_display":"SuperGrok Heavy","allow_access":true,"on_demand_enabled":false}"#
                }
                "billing?format=credits" => {
                    r#"{"config":{"creditUsagePercent":12.125,"prepaidBalance":{"val":"9007199254740993"},"onDemandUsed":{},"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-09-28T00:00:00Z"}}}"#
                }
                _ => panic!("unexpected route"),
            };
            if !request.url().contains("/user?") {
                assert!(
                    request
                        .headers()
                        .iter()
                        .any(|header| header.name() == "x-userid" && header.value() == "user-a")
                );
            }
            Ok(ClientResponse::new(
                status,
                vec![],
                body.as_bytes().to_vec(),
            ))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    secrets.store(&ash_secrets::SecretKey::new("provider/xai/current/oauth").unwrap(), &ash_secrets::SecretValue::new(br#"{"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer","scope":"","expires_at":4102444800,"account_id":"login-a","credential_revision":1}"#.to_vec())).unwrap();
    let proxy = Arc::new(Proxy {
        requests: Mutex::new(Vec::new()),
        status: AtomicUsize::new(200),
    });
    let auth = xai::XaiOAuth::with_client(secrets, proxy.clone(), dir.path().join("lock"));
    let login = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&login).unwrap();
    let server = server().with_login_service(login).with_xai_account(auth);
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let account = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}),
    );
    assert_eq!(
        account["result"]["accounts"][0]["email"],
        "ada@example.test"
    );
    assert_eq!(account["result"]["accounts"][0]["displayName"], "Ada");
    assert_eq!(account["result"]["accounts"][0]["plan"], "SuperGrok Heavy");
    let read = |connection: &mut ConnectionState, request_id: u64, account_id: &str| {
        call(
            &server,
            connection,
            serde_json::json!({"jsonrpc":"2.0","id":request_id,"method":"account/rateLimits/read","params":{"provider":"xai-subscription","accountId":account_id}}),
        )
    };
    let result = read(&mut connection, 3, "login-a");
    assert_eq!(result["result"]["plan"], "SuperGrok Heavy");
    assert_eq!(result["result"]["xai"]["usedPercent"], 12.125);
    assert_eq!(result["result"]["xai"]["prepaidCents"], "9007199254740993");
    assert_eq!(result["result"]["xai"]["onDemandUsedCents"], "0");
    assert!(result["result"]["xai"]["onDemandCapCents"].is_null());
    assert_eq!(proxy.requests.lock().unwrap().len(), 5);
    assert_eq!(
        read(&mut connection, 4, "other")["error"]["message"],
        "AccountChanged"
    );
    assert_eq!(proxy.requests.lock().unwrap().len(), 5);
    proxy.status.store(429, Ordering::SeqCst);
    assert_eq!(
        read(&mut connection, 5, "login-a")["error"]["message"],
        "AccountOperationFailed"
    );
    assert_eq!(proxy.requests.lock().unwrap().len(), 6);
    call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"account/logout","params":{"provider":"xai-subscription"}}),
    );
    assert_eq!(
        read(&mut connection, 7, "login-a")["error"]["message"],
        "AccountChanged"
    );
    assert_eq!(proxy.requests.lock().unwrap().len(), 6);
    assert!(
        !format!(
            "{account}{result}{:?}",
            server.drain_notifications(&mut connection)
        )
        .contains("fixture-access")
    );
}

fn server_with_model(model: Arc<dyn ModelService>) -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(threads, model).with_ephemeral_env_state()
}

fn server() -> AppServer {
    server_with_model(Arc::new(crate::local::ProviderModelService::new(Arc::new(
        EchoModel,
    ))))
}

#[derive(Clone)]
struct CapturingWriter {
    output: Arc<(Mutex<Vec<u8>>, Condvar)>,
}

struct BlockingWriter {
    started: Option<Sender<()>>,
    release: Receiver<()>,
    released: bool,
}

#[derive(Default)]
struct TestLoginDriver {
    account: Mutex<Option<AccountSnapshot>>,
}

impl InteractiveLoginDriver for TestLoginDriver {
    fn provider_id(&self) -> &'static str {
        "chatgpt-subscription"
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Ok(self.account.lock().unwrap().clone())
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        Ok(BeginLogin::Browser {
            login_id: request.login_id,
            authorization_url: "https://auth.example.test/start".into(),
        })
    }

    fn cancel(&self, _: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        Ok(CancelLoginOutcome::Cancelled)
    }

    fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
        Ok(())
    }
}

impl Write for CapturingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let (output, changed) = self.output.as_ref();
        output
            .lock()
            .map_err(|_| std::io::Error::other("capture lock poisoned"))?
            .extend_from_slice(bytes);
        changed.notify_all();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Write for BlockingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if !self.released {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            self.release
                .recv()
                .map_err(|_| std::io::Error::other("blocking writer release channel closed"))?;
            self.released = true;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn wait_for_captured(output: &Arc<(Mutex<Vec<u8>>, Condvar)>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    let (bytes, changed) = output.as_ref();
    let mut bytes = bytes.lock().unwrap();
    loop {
        if String::from_utf8_lossy(&bytes).contains(needle) {
            return;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for {needle}");
        let (next, _) = changed.wait_timeout(bytes, remaining).unwrap();
        bytes = next;
    }
}

#[derive(Clone)]
struct FixedModelCatalog {
    models: Vec<ash_app_server_protocol::protocol::model::ModelCatalogEntry>,
    default: ModelRef,
}

impl crate::model_catalog::ModelCatalog for FixedModelCatalog {
    fn list(
        &self,
        _: ash_app_server_protocol::protocol::model::ModelListView,
    ) -> Result<Vec<ash_app_server_protocol::protocol::model::ModelCatalogEntry>, CoreError> {
        Ok(self.models.clone())
    }

    fn current_access(&self, model: &ModelRef) -> Result<ash_protocol::ModelAccess, CoreError> {
        Ok(self
            .models
            .iter()
            .find(|entry| &entry.model == model)
            .map_or(ash_protocol::ModelAccess::Unknown, |entry| entry.access))
    }

    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
        Ok(Some(self.default.clone()))
    }
}

fn model_ref(model: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new(model).unwrap(),
    )
}

#[test]
fn provider_rpc_lists_the_backend_catalog_and_stores_api_keys_without_projecting_values() {
    let secrets = Arc::new(MemorySecretStore::default());
    let server = server().with_provider_credentials(Arc::new(
        ash_model_provider::ProviderCredentialService::new(
            ash_model_provider_config::ProviderConfigRegistry::builtin(),
            secrets,
        ),
    ));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let initial = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"provider/list","params":{}
        }),
    );
    assert_eq!(
        initial["result"]["providers"].as_array().unwrap().len(),
        ash_model_provider_config::ProviderConfigRegistry::builtin()
            .providers()
            .count()
    );

    let saved = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"provider/apiKey/set",
            "params":{"provider":"openai","apiKey":"secret-provider-key"}
        }),
    );
    assert_eq!(saved["result"]["provider"], "openai");
    assert!(!saved.to_string().contains("secret-provider-key"));

    let updated = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"provider/list","params":{}
        }),
    );
    assert!(
        updated["result"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |provider| provider["provider"] == "openai" && provider["apiKeyConfigured"] == true
            )
    );
}

#[test]
fn provider_models_rpc_distinguishes_models_empty_and_classified_failure() {
    use crate::model_catalog::ModelCatalogRefreshError;
    use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
    struct Catalog(Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError>);
    impl crate::model_catalog::ModelCatalog for Catalog {
        fn refresh(
            &self,
            provider: &ProviderId,
        ) -> Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError> {
            assert_eq!(provider.as_str(), "openai");
            self.0.clone()
        }
        fn list(
            &self,
            _: ash_app_server_protocol::protocol::model::ModelListView,
        ) -> Result<Vec<ModelCatalogEntry>, CoreError> {
            Ok(vec![])
        }
        fn current_access(&self, _: &ModelRef) -> Result<ash_protocol::ModelAccess, CoreError> {
            Ok(ash_protocol::ModelAccess::Unknown)
        }
        fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
            Ok(None)
        }
    }
    let model = model_ref("example");
    let entry = ModelCatalogEntry::from_info(
        model.clone(),
        &ash_protocol::ModelInfo::new(model.model, "Example"),
        ash_protocol::ModelOutputTransport::Unary,
    );
    for (value, expected) in [
        (
            Ok(vec![entry.clone()]),
            serde_json::json!({"type":"models","models":[entry]}),
        ),
        (Ok(vec![]), serde_json::json!({"type":"empty"})),
        (
            Err(ModelCatalogRefreshError::Authentication),
            serde_json::json!({"type":"failed","failure":{"code":"authentication"}}),
        ),
        (
            Err(ModelCatalogRefreshError::Unsupported),
            serde_json::json!({"type":"failed","failure":{"code":"unsupported"}}),
        ),
        (
            Err(ModelCatalogRefreshError::Unreachable),
            serde_json::json!({"type":"failed","failure":{"code":"unreachable"}}),
        ),
    ] {
        let server = server().with_model_catalog(Arc::new(Catalog(value)));
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let reply = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":2,"method":"provider/models/list","params":{"provider":"openai"}}),
        );
        assert_eq!(reply["result"], expected);
        assert!(reply.get("error").is_none());
    }
}

#[test]
fn custom_provider_rpc_round_trips_protocol_and_stores_a_separate_key() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(ConfigStore::open(directory.path().join("config.sqlite3")).unwrap());
    let server = server()
        .with_config_store(store)
        .with_provider_credentials(Arc::new(
            ash_model_provider::ProviderCredentialService::new(
                ash_model_provider_config::ProviderConfigRegistry::builtin(),
                Arc::new(MemorySecretStore::default()),
            ),
        ));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let configured = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"provider/configure","params":{
                "commandId":"create-custom","expectedRevision":0,"config":{
                    "provider":"custom-example","custom":{"name":"Example","protocol":"responses"},"baseUrl":"https://example.test/v1","modelContext":{}
                }
            }
        }),
    );
    assert!(configured.get("error").is_none(), "{configured}");
    let saved = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"provider/apiKey/set","params":{"provider":"custom-example","apiKey":"test-key"}}),
    );
    assert_eq!(saved["result"]["apiKeyConfigured"], true);
    let catalog = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"provider/list","params":{}}),
    );
    let providers = catalog["result"]["providers"].as_array().unwrap();
    assert!(
        providers
            .iter()
            .any(|provider| provider["provider"] == "custom-example"
                && provider["displayName"] == "Example"
                && provider["apiKeyConfigured"] == true)
    );
    assert!(
        providers
            .iter()
            .any(|provider| provider["provider"] == "openai"
                && provider["apiKeyConfigured"] == false)
    );
    assert!(!catalog.to_string().contains("test-key"));
    let config = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"config/read","params":{}}),
    );
    assert_eq!(
        config["result"]["providers"]["custom-example"]["custom"]["protocol"],
        "responses"
    );
    assert!(!config.to_string().contains("test-key"));
}

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    request: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}

fn initialize(server: &AppServer, connection: &mut ConnectionState) {
    initialize_with_capabilities(server, connection, serde_json::json!({}));
}

fn initialize_with_capabilities(
    server: &AppServer,
    connection: &mut ConnectionState,
    capabilities: serde_json::Value,
) {
    let response = call(
        server,
        connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{"clientInfo":{"name":"test","version":"1"},"capabilities":capabilities}
        }),
    );
    assert_eq!(response["result"]["capabilities"]["sessions"], true);
    assert_eq!(response["result"]["capabilities"]["codebase"], false);
    assert_eq!(response["result"]["capabilities"]["typst"], true);
    assert_eq!(response["result"]["capabilities"]["updateReplay"], true);
}

#[test]
fn attachment_upload_is_chunked_connection_owned_and_returns_an_attachment_reference() {
    let server = server();
    let mut owner = server.connection();
    let mut other = server.connection();
    initialize(&server, &mut owner);
    initialize(&server, &mut other);
    let image = image::DynamicImage::new_rgba8(2, 1);
    let mut encoded = Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let bytes = encoded.into_inner();

    let started = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":10,
            "method":"attachment/upload/start",
            "params":{"mediaType":"png","encodedBytes":bytes.len(),"detail":"auto"}
        }),
    );
    let upload_id = started["result"]["uploadId"].as_str().unwrap();
    let rejected = call(
        &server,
        &mut other,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":11,
            "method":"attachment/upload/write",
            "params":{"uploadId":upload_id,"offset":0,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}
        }),
    );
    assert_eq!(rejected["error"]["message"], "InvalidParams");

    let written = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":12,
            "method":"attachment/upload/write",
            "params":{"uploadId":upload_id,"offset":0,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}
        }),
    );
    assert_eq!(written["result"]["nextOffset"], bytes.len());
    let finished = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":13,
            "method":"attachment/upload/finish",
            "params":{"uploadId":upload_id}
        }),
    );
    let attachment = &finished["result"]["attachment"];
    assert_eq!(attachment["mediaType"], "png");
    assert_eq!(attachment["width"], 2);
    assert_eq!(attachment["height"], 1);
    assert!(
        attachment["contentDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(!finished.to_string().contains("data:image/"));
}

#[test]
fn attachment_upload_rejects_a_mismatched_image_format() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 1)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let bytes = encoded.into_inner();
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":10, "method":"attachment/upload/start",
            "params":{"mediaType":"jpeg","encodedBytes":bytes.len(),"detail":"auto"}
        }),
    );
    let upload_id = started["result"]["uploadId"].as_str().unwrap();
    let written = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":11, "method":"attachment/upload/write",
            "params":{"uploadId":upload_id,"offset":0,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}
        }),
    );
    assert_eq!(written["result"]["nextOffset"], bytes.len());
    let finished = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":12, "method":"attachment/upload/finish",
            "params":{"uploadId":upload_id}
        }),
    );
    assert_eq!(finished["error"]["message"], "InvalidParams");
    assert!(finished["result"].is_null());
}

#[test]
fn document_collaboration_orders_updates_and_returns_rebase_history() {
    let server = server();
    let mut first = server.connection();
    let mut second = server.connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    let document = collaboration_document("initial");
    let opened = call(
        &server,
        &mut first,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"document/collaboration/open",
            "params":{"clientId":"client-a","schemaId":"stanza-document-v1","document":document}
        }),
    );
    let room_id = opened["result"]["snapshot"]["roomId"]
        .as_str()
        .expect("opening a room must return its identifier")
        .to_string();
    assert_eq!(room_id.len(), "document-".len() + 32);
    assert!(room_id.starts_with("document-"));
    assert!(
        room_id["document-".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
    assert_eq!(opened["result"]["snapshot"]["version"], 0);
    let joined = call(
        &server,
        &mut second,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"document/collaboration/open",
            "params":{"roomId":room_id,"clientId":"client-b","schemaId":"stanza-document-v1","document":"{}"}
        }),
    );
    assert_eq!(joined["result"]["snapshot"]["document"], document);
    let presence = call(
        &server,
        &mut first,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"document/collaboration/presence/publish",
            "params":{"roomId":room_id,"clientId":"client-a","selection":"{\"kind\":\"text\",\"anchor\":{\"nodeId\":\"text-1\",\"offset\":0},\"head\":{\"nodeId\":\"text-1\",\"offset\":1}}"}
        }),
    );
    assert_eq!(presence["result"]["generation"], 1);
    assert_eq!(presence["result"]["presences"][0]["clientId"], "client-a");
    let notifications = server.drain_notifications(&mut second);
    assert!(
        notifications
            .iter()
            .any(|notification| notification.contains("document/collaboration/presence"))
    );
    let read_presence = call(
        &server,
        &mut second,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"document/collaboration/presence/read",
            "params":{"roomId":room_id}
        }),
    );
    assert_eq!(
        read_presence["result"]["presences"][0]["clientId"],
        "client-a"
    );
    let accepted = call(
        &server,
        &mut first,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"document/collaboration/submit",
            "params":{"roomId":room_id,"clientId":"client-a","sequence":1,"baseVersion":0,"transaction":collaboration_transaction(),"document":collaboration_document("first")}
        }),
    );
    assert_eq!(accepted["result"]["status"], "accepted");
    assert_eq!(accepted["result"]["update"]["version"], 1);
    let notifications = server.drain_notifications(&mut second);
    assert!(
        notifications
            .iter()
            .any(|notification| notification.contains("document/collaboration/update"))
    );
    let conflict = call(
        &server,
        &mut second,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"document/collaboration/submit",
            "params":{"roomId":room_id,"clientId":"client-b","sequence":1,"baseVersion":0,"transaction":collaboration_transaction(),"document":"{}"}
        }),
    );
    assert_eq!(conflict["result"]["status"], "conflict");
    assert_eq!(conflict["result"]["updates"][0]["clientId"], "client-a");
    assert_eq!(conflict["result"]["updates"][0]["version"], 1);
}

fn collaboration_document(value: &str) -> String {
    format!(
        r#"{{"format":"ash.document","version":1,"document":{{"id":"document-1","type":"doc","attrs":{{}},"marks":[],"content":[{{"id":"text-1","type":"text","attrs":{{}},"marks":[],"content":[],"text":"{value}"}}]}}}}"#
    )
}

fn collaboration_transaction() -> String {
    r#"{"format":"ash.document.transaction","version":1,"transaction":{"steps":[],"addToHistory":true,"selectionSet":false,"storedMarksSet":false,"metadata":[]}}"#.into()
}

fn create_session(
    server: &AppServer,
    connection: &mut ConnectionState,
    request_id: u64,
    command_id: &str,
) -> serde_json::Value {
    call(
        server,
        connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":request_id,
            "method":"session/create",
            "params":{"commandId":command_id,"title":"task"}
        }),
    )
}

fn create_thread(
    server: &AppServer,
    connection: &mut ConnectionState,
    request_id: u64,
    command_id: &str,
    session_id: &str,
    _expected_sequence: u64,
) -> serde_json::Value {
    call(
        server,
        connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":request_id,
            "method":"session/request",
            "params":{
                "commandId":command_id,
                "sessionId":session_id,
                "request":{"type":"createThread","title":"root"}
            }
        }),
    )
}

fn wait_for_latest_turn(server: &AppServer, thread_id: &str, expected: TurnStatus) {
    let thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = server.threads().read_thread(&thread_id).unwrap();
        if snapshot
            .turns
            .last()
            .is_some_and(|turn| turn.status == expected)
        {
            return;
        }
        assert!(Instant::now() < deadline, "Turn did not reach {expected:?}");
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn thread_goal_rpc_round_trips_and_publishes_scoped_updates() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "goal-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "goal-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":1}
        }),
    );
    server.drain_notifications(&mut connection);

    let set = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"thread/goal/set",
            "params":{"threadId":thread_id,"objective":"finish the implementation","tokenBudget":100}
        }),
    );
    assert_eq!(set["result"]["goal"]["status"], "active");
    assert_eq!(set["result"]["goal"]["tokensUsed"], 0);
    assert_eq!(set["result"]["goal"]["tokenBudget"], 100);
    let updates = server.drain_notifications(&mut connection);
    assert!(updates.iter().any(|notification| {
        notification.contains("\"method\":\"thread/goal/updated\"")
            && notification.contains("finish the implementation")
    }));
    assert!(updates.iter().any(|notification| {
        notification.contains("\"type\":\"userGoalChanged\"")
            && notification.contains("finish the implementation")
    }));

    let get = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"thread/goal/get",
            "params":{"threadId":thread_id}
        }),
    );
    assert_eq!(
        get["result"]["goal"]["goalId"],
        set["result"]["goal"]["goalId"]
    );

    let reaffirmed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":61,
            "method":"thread/goal/set",
            "params":{"threadId":thread_id,"objective":"finish the implementation"}
        }),
    );
    assert_eq!(reaffirmed["result"]["goal"], set["result"]["goal"]);
    let updates = server.drain_notifications(&mut connection);
    assert!(
        updates
            .iter()
            .any(|notification| notification.contains("\"type\":\"userGoalChanged\""))
    );
    assert!(
        !updates
            .iter()
            .any(|notification| notification.contains("\"method\":\"thread/goal/updated\""))
    );

    let clear = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":7,
            "method":"thread/goal/clear",
            "params":{"threadId":thread_id}
        }),
    );
    assert_eq!(clear["result"]["cleared"], true);
    let updates = server.drain_notifications(&mut connection);
    assert!(
        updates
            .iter()
            .any(|notification| notification.contains("\"method\":\"thread/goal/cleared\""))
    );
    assert!(updates.iter().any(
        |notification| notification.contains("\"type\":\"userGoalChanged\"")
            && notification.contains("\"type\":\"clear\"")
    ));

    let missing = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":8,
            "method":"thread/goal/get",
            "params":{"threadId":thread_id}
        }),
    );
    assert!(missing["result"]["goal"].is_null());
}

#[test]
fn initialize_is_required_and_request_ids_are_connection_unique() {
    let server = server();
    let mut connection = server.connection();
    let gated = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"session/list","params":{}}),
    );
    assert_eq!(gated["error"]["message"], "NotInitialized");

    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let duplicate = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"session/list","params":{}}),
    );
    assert_eq!(duplicate["error"]["message"], "InvalidRequest");
}

#[test]
fn closed_connections_reject_future_requests() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    server.close_connection(connection.clone());

    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}),
    );
    assert_eq!(rejected["error"]["message"], "RequestCancelled");
}

#[test]
fn language_cancel_uses_the_declared_operation_identity() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let requested = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"language/cancel",
            "params":{"operationId":"hover-1"}
        }),
    );
    assert_eq!(requested["result"]["status"], "requested");

    let cancelled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"language/hover",
            "params":{"operationId":"hover-1","request":{}}
        }),
    );
    assert_eq!(cancelled["error"]["message"], "RequestCancelled");

    let completed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"language/cancel",
            "params":{"operationId":"hover-1"}
        }),
    );
    assert_eq!(completed["result"]["status"], "completed");
    assert!(server.drain_notifications(&mut connection).is_empty());
}

#[test]
fn cancellable_language_request_requires_an_operation_identity() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"language/hover","params":{"request":{}}
        }),
    );

    assert_eq!(rejected["error"]["message"], "InvalidParams");

    let invalid_cancel = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"language/cancel","params":{"operationId":""}
        }),
    );
    assert_eq!(invalid_cancel["error"]["message"], "InvalidParams");
}

#[test]
fn dynamic_interaction_capability_requires_exact_hosted_tool_names() {
    let server = server();
    let mut connection = server.connection();
    let missing_names = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{
                "clientInfo":{"name":"test","version":"1"},
                "capabilities":{
                    "agentInteractions":{"version":1,"kinds":["dynamicTool"]}
                }
            }
        }),
    );
    assert_eq!(missing_names["error"]["message"], "InvalidParams");

    let mut connection = server.connection();
    let accepted = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{
                "clientInfo":{"name":"test","version":"1"},
                "capabilities":{
                    "agentInteractions":{
                        "version":1,
                        "kinds":["dynamicTool"],
                        "dynamicTools":["client_lookup"]
                    }
                }
            }
        }),
    );
    assert_eq!(
        accepted["result"]["capabilities"]["agentInteractions"],
        true
    );
}

#[test]
fn content_search_requires_an_installed_backend() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"grep/search/start",
            "params":{
                "query":"needle",
                "patternKind":"literal",
                "caseSensitivity":"smart",
                "includePatterns":[],
                "excludePatterns":[],
                "maxResults":100
            }
        }),
    );

    assert_eq!(response["error"]["message"], "SearchUnavailable");
}

#[test]
fn terminal_requires_an_installed_backend() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/create",
            "params":{"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}}
        }),
    );

    assert_eq!(response["error"]["message"], "TerminalUnavailable");
}

#[test]
fn terminal_profiles_are_server_owned_and_reject_unknown_ids() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-terminal-profiles-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let server = server()
        .with_terminal_root(dir_authorization(&root, DirPermission::ExecuteCommands))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let profiles = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/profile/list",
            "params":{}
        }),
    );
    let profiles = profiles["result"]["profiles"].as_array().unwrap();
    assert!(!profiles.is_empty());
    assert_eq!(
        profiles
            .iter()
            .filter(|profile| profile["isDefault"] == true)
            .count(),
        1
    );
    assert!(
        profiles
            .iter()
            .all(|profile| profile.get("program").is_none())
    );

    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"terminal/create",
            "params":{
                "rows":24,
                "cols":80,
                "profile":{"type":"profile","profileId":"client-program"},
                "lifecycle":{"type":"connectionOwned"}
            }
        }),
    );
    assert_eq!(rejected["error"]["message"], "InvalidParams");

    let environment_injection = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"terminal/create",
            "params":{
                "rows":24,
                "cols":80,
                "profile":{"type":"default"},
                "lifecycle":{"type":"connectionOwned"},
                "environment":{"OPENAI_API_KEY":"injected"}
            }
        }),
    );
    assert_eq!(environment_injection["error"]["message"], "InvalidParams");

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn terminal_rpc_drives_a_dir_rooted_pty_to_exit() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-terminal-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let server = server()
        .with_terminal_root(dir_authorization(&root, DirPermission::ExecuteCommands))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/create",
            "params":{"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}}
        }),
    );
    let terminal_id = created["result"]["terminalId"].as_str().unwrap();
    #[cfg(windows)]
    let input = "echo ash-terminal-ready\r\nexit\r\n";
    #[cfg(not(windows))]
    let input = "printf 'ash-terminal-ready\\n\\377'\nexit\n";
    let written = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"terminal/write",
            "params":{"terminalId":terminal_id,"data":input}
        }),
    );
    assert!(written["error"].is_null());

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut request_id = 4;
    let mut after_sequence = 0;
    let mut after_command_sequence = 0;
    let mut output = Vec::new();
    #[cfg(windows)]
    let mut command_statuses = Vec::new();
    let exit_code = loop {
        let read = call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0",
                "id":request_id,
                "method":"terminal/read",
                "params":{
                    "terminalId":terminal_id,
                    "afterSequence":after_sequence,
                    "afterCommandSequence":after_command_sequence,
                    "maxChunks":128
                }
            }),
        );
        request_id += 1;
        after_sequence = read["result"]["nextSequence"].as_u64().unwrap();
        after_command_sequence = read["result"]["nextCommandSequence"].as_u64().unwrap();
        for chunk in read["result"]["chunks"].as_array().unwrap() {
            output.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk["dataBase64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        #[cfg(windows)]
        for event in read["result"]["commandEvents"].as_array().unwrap() {
            command_statuses.push(event["status"].as_str().unwrap().to_owned());
        }
        if read["result"]["exited"] == true {
            break read["result"]["exitCode"].as_i64().unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "terminal did not exit; output={:?}; exit_code={:?}",
            String::from_utf8_lossy(&output),
            read["result"]["exitCode"]
        );
        thread::sleep(Duration::from_millis(10));
    };

    assert_eq!(exit_code, 0);
    assert!(String::from_utf8_lossy(&output).contains("ash-terminal-ready"));
    #[cfg(not(windows))]
    assert!(
        output.contains(&0xff),
        "RPC must preserve non-UTF-8 PTY bytes"
    );
    #[cfg(windows)]
    {
        assert!(command_statuses.iter().any(|status| status == "running"));
        assert!(
            command_statuses
                .iter()
                .any(|status| matches!(status.as_str(), "completed" | "succeeded"))
        );
    }
    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn terminal_rpc_enforces_connection_ownership_and_close() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-terminal-owner-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let server = server()
        .with_terminal_root(dir_authorization(&root, DirPermission::ExecuteCommands))
        .unwrap();
    let mut owner = server.connection();
    let mut other = server.connection();
    initialize(&server, &mut owner);
    initialize(&server, &mut other);
    let created = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/create",
            "params":{"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}}
        }),
    );
    let terminal_id = created["result"]["terminalId"].as_str().unwrap();

    let rejected = call(
        &server,
        &mut other,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/read",
            "params":{
                "terminalId":terminal_id,
                "afterSequence":0,
                "afterCommandSequence":0,
                "maxChunks":1
            }
        }),
    );
    assert_eq!(rejected["error"]["message"], "TerminalNotOwner");

    let closed = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"terminal/close",
            "params":{"terminalId":terminal_id}
        }),
    );
    assert!(closed["error"].is_null());
    let missing = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"terminal/read",
            "params":{
                "terminalId":terminal_id,
                "afterSequence":0,
                "afterCommandSequence":0,
                "maxChunks":1
            }
        }),
    );
    assert_eq!(missing["error"]["message"], "TerminalNotFound");

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reconnectable_terminal_detaches_rotates_its_token_and_rejects_replay() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-terminal-attach-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let server = server()
        .with_terminal_root(dir_authorization(&root, DirPermission::ExecuteCommands))
        .unwrap();
    let mut owner = server.connection();
    initialize(&server, &mut owner);
    let created = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/create",
            "params":{"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"reconnectable"}}
        }),
    );
    let terminal_id = created["result"]["terminalId"].as_str().unwrap().to_owned();
    let first_token = created["result"]["reconnect"]["reconnectToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(first_token.len(), 64);
    assert_eq!(
        created["result"]["reconnect"]["reconnectGracePeriodMillis"],
        30_000
    );

    server.close_connection(owner);
    let mut replacement = server.connection();
    initialize(&server, &mut replacement);
    let rejected = call(
        &server,
        &mut replacement,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/attach",
            "params":{"terminalId":terminal_id,"reconnectToken":"0".repeat(64),"rows":30,"cols":100}
        }),
    );
    assert_eq!(rejected["error"]["message"], "TerminalAttachRejected");

    let attached = call(
        &server,
        &mut replacement,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"terminal/attach",
            "params":{"terminalId":terminal_id,"reconnectToken":first_token,"rows":30,"cols":100}
        }),
    );
    let second_token = attached["result"]["reconnect"]["reconnectToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(second_token, first_token);

    server.close_connection(replacement);
    let mut final_connection = server.connection();
    initialize(&server, &mut final_connection);
    let replayed = call(
        &server,
        &mut final_connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"terminal/attach",
            "params":{"terminalId":terminal_id,"reconnectToken":first_token,"rows":30,"cols":100}
        }),
    );
    assert_eq!(replayed["error"]["message"], "TerminalAttachRejected");
    let final_attach = call(
        &server,
        &mut final_connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"terminal/attach",
            "params":{"terminalId":terminal_id,"reconnectToken":second_token,"rows":30,"cols":100}
        }),
    );
    assert_eq!(final_attach["result"]["terminalId"], terminal_id);
    let closed = call(
        &server,
        &mut final_connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"terminal/close",
            "params":{"terminalId":terminal_id}
        }),
    );
    assert!(closed["error"].is_null());

    server.close_connection(final_connection);
    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn debug_adapter_rpc_enforces_connection_ownership_and_connection_cleanup() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-debug-adapter-owner-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let server = server()
        .with_debug_adapter_root(
            dir_authorization(&root, DirPermission::LoadConfig),
            dir_authorization(&root, DirPermission::ExecuteCommands),
        )
        .unwrap();
    let mut owner = server.connection();
    let mut other = server.connection();
    initialize(&server, &mut owner);
    initialize(&server, &mut other);
    #[cfg(windows)]
    let (program, arguments) = (
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
        vec!["/D", "/Q", "/C", "more"],
    );
    #[cfg(not(windows))]
    let (program, arguments) = ("/bin/sh".to_owned(), vec!["-c", "cat"]);
    let started = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"debug/adapter/start",
            "params":{"program":program,"arguments":arguments}
        }),
    );
    let session_id = started["result"]["sessionId"].as_str().unwrap();

    let rejected = call(
        &server,
        &mut other,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"debug/adapter/read",
            "params":{"sessionId":session_id,"afterSequence":0,"maxMessages":1}
        }),
    );
    assert_eq!(rejected["error"]["message"], "DebugAdapterNotOwner");

    server.close_connection(owner);
    let missing = call(
        &server,
        &mut other,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"debug/adapter/read",
            "params":{"sessionId":session_id,"afterSequence":0,"maxMessages":1}
        }),
    );
    assert_eq!(missing["error"]["message"], "DebugAdapterNotFound");

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn initialize_advertises_the_server_slash_command_snapshot() {
    let catalog = SlashCommandCatalog::new([SlashCommandDefinition {
        name: "diagnose".into(),
        description: "inspect the current dir".into(),
        argument_mode: SlashCommandArgumentModeDto::Optional,
        argument_hint: None,
    }])
    .unwrap();
    let server = server().with_slash_command_catalog(catalog);
    let mut connection = server.connection();

    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}
        }),
    );

    assert_eq!(
        response["result"]["slashCommands"],
        serde_json::json!([{
            "name": "diagnose",
            "description": "inspect the current dir",
            "argumentMode": "optional"
        }])
    );
    assert_eq!(
        response["result"]["protocolVersion"],
        serde_json::json!({
            "major": ash_app_server_protocol::protocol::initialize::APP_SERVER_PROTOCOL_MAJOR,
            "revision": ash_app_server_protocol::protocol::initialize::APP_SERVER_PROTOCOL_REVISION,
        })
    );
    assert_eq!(response["result"]["capabilities"]["sessions"], true);
    assert_eq!(
        response["result"]["capabilities"]["contracts"]["sessions"]["version"],
        ash_app_server_protocol::protocol::initialize::APP_SERVER_CAPABILITY_VERSION
    );
}

#[test]
fn session_request_starts_and_replays_manual_context_compaction() {
    let backend = Arc::new(CountingStartBackend::default());
    let server = server().with_turn_backend(backend.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "compact-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "compact-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let request = |id| {
        serde_json::json!({
            "jsonrpc":"2.0","id":id,"method":"session/request",
            "params":{
                "commandId":"manual-compact",
                "sessionId":session_id,
                "request":{
                    "type":"compactContext",
                    "expectedSequence":1,
                    "threadId":thread_id,
                    "retentionPrompt":"preserve the deployment decision"
                }
            }
        })
    };

    let started = call(&server, &mut connection, request(4));
    let replayed = call(&server, &mut connection, request(5));
    let protocol_thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();

    assert_eq!(started["result"]["type"], "turn");
    assert_eq!(replayed["result"], started["result"]);
    assert_eq!(backend.starts.load(Ordering::Relaxed), 1);
    assert_eq!(snapshot.turns.len(), 1);
    assert!(matches!(
        &snapshot.commands[0].receipt.command,
        ash_protocol::ThreadCommand::CompactContext {
            retention_prompt: Some(prompt),
            ..
        } if prompt == "preserve the deployment decision"
    ));
}

#[test]
fn session_first_flow_exposes_derived_session_and_canonical_thread_models() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "create-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    assert!(session["result"]["session"].get("sequence").is_none());
    assert_eq!(session["result"]["session"]["manager"]["status"], "idle");
    assert!(
        session["result"]["session"]["manager"]["statusChangedAtUnixMs"]
            .as_u64()
            .is_some()
    );
    let thread = create_thread(&server, &mut connection, 3, "create-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    assert_eq!(
        thread["result"]["value"]["session"]["threads"][0]["status"],
        "active"
    );
    assert_eq!(
        thread["result"]["value"]["session"]["threads"][0]["usage"]["inputTokens"]["reported"],
        0
    );
    assert!(
        thread["result"]["value"]["session"]
            .get("currentThreadId")
            .is_none()
    );
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/read",
            "params":{"sessionId":session_id,"threadId":thread_id}
        }),
    );
    assert_eq!(read["result"]["thread"]["sessionId"], session_id);
    assert_eq!(read["result"]["thread"]["sequence"], 1);

    let listed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"session/list","params":{}}),
    );
    assert_eq!(
        listed["result"]["sessions"][0],
        thread["result"]["value"]["session"]
    );
}

#[test]
fn new_session_invalidates_other_connections_without_a_session_subscription() {
    let server = server();
    let mut creator = server.connection();
    let mut observer = server.connection();
    initialize(&server, &mut creator);
    initialize(&server, &mut observer);
    let listed = call(
        &server,
        &mut observer,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/catalog/subscribe","params":{}}),
    );
    assert!(listed["result"]["sessions"].as_array().unwrap().is_empty());

    let created = create_session(&server, &mut creator, 2, "create-session");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let notifications = server.drain_notifications(&mut observer);

    assert!(notifications.iter().any(|message| {
        let value: serde_json::Value = serde_json::from_str(message).unwrap();
        value["method"] == "session/changed" && value["params"]["sessionId"] == session_id
    }));

    let catalog = call(
        &server,
        &mut observer,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/catalog/read","params":{"sessionId":session_id}}),
    );
    assert_eq!(catalog["result"]["session"], created["result"]["session"]);
    let absent = call(
        &server,
        &mut observer,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"session/catalog/read","params":{"sessionId":"missing-session"}}),
    );
    assert!(absent["result"]["session"].is_null());

    let unsubscribed = call(
        &server,
        &mut observer,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"session/catalog/unsubscribe","params":{}}),
    );
    assert_eq!(unsubscribed["result"], serde_json::Value::Null);
    create_session(&server, &mut creator, 4, "another-session");
    assert!(server.drain_notifications(&mut observer).is_empty());
}

#[test]
fn session_stop_archives_the_session_and_blocks_new_turns() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "create-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "create-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let stopped = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/request",
            "params":{
                "commandId":"stop-session",
                "sessionId":session_id,
                "request":{"type":"stop"}
            }
        }),
    );
    assert_eq!(stopped["result"]["value"]["session"]["status"], "archived");
    assert_eq!(
        stopped["result"]["value"]["session"]["manager"]["status"],
        "stopped"
    );

    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"turn-after-stop",
                "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"after stop"}]}
            }
        }),
    );
    assert_eq!(rejected["error"]["message"], "CoreOperationFailed");
}

#[test]
fn session_archive_is_distinct_from_stop_in_the_manager_view() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "archive-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();

    let archived = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"session/request",
            "params":{
                "commandId":"archive-session",
                "sessionId":session_id,
                "request":{"type":"archive"}
            }
        }),
    );

    assert_eq!(
        archived["result"]["value"]["session"]["manager"]["status"],
        "completed"
    );
}

#[test]
fn session_restore_reopens_archived_conversation_and_updates_catalog() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "restore-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    for (id, operation, expected) in [
        (3, "archive", "archived"),
        (4, "restore", "active"),
        (5, "restore", "active"),
    ] {
        let response = call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0", "id":id, "method":"session/request",
                "params":{"commandId":format!("restore-test-{id}"), "sessionId":session_id, "request":{"type":operation}}
            }),
        );
        assert_eq!(
            response["result"]["value"]["session"]["status"], expected,
            "{response}"
        );
    }
    let listed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"session/list","params":{}}),
    );
    assert_eq!(listed["result"]["sessions"][0]["status"], "active");
    assert!(
        server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| notification.contains("session/changed"))
    );
}

#[test]
fn session_delete_permanently_removes_an_archived_session() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "delete-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"session/request",
            "params":{
                "commandId":"archive-before-delete",
                "sessionId":session_id,
                "request":{"type":"archive"}
            }
        }),
    );
    server.drain_notifications(&mut connection);

    let deleted = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/request",
            "params":{
                "commandId":"delete-session",
                "sessionId":session_id,
                "request":{"type":"delete"}
            }
        }),
    );
    let notifications = server.drain_notifications(&mut connection);
    let listed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"session/list","params":{}}),
    );
    let missing = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"session/read",
            "params":{"sessionId":session_id}
        }),
    );

    assert_eq!(deleted["result"]["type"], "deleted");
    assert_eq!(deleted["result"]["value"], session_id);
    assert_eq!(notifications.len(), 1);
    assert!(notifications[0].contains("\"method\":\"session/deleted\""));
    assert!(notifications[0].contains(session_id));
    assert!(listed["result"]["sessions"].as_array().unwrap().is_empty());
    assert_eq!(missing["error"]["message"], "CoreOperationFailed");
}

#[test]
fn model_catalog_is_global_and_session_views_do_not_own_model_selection() {
    let default = model_ref("gpt-default");
    let alternate = model_ref("gpt-alternate");
    let mut default_info = ash_protocol::ModelInfo::new(default.model.clone(), "Default");
    default_info.access = ash_protocol::ModelAccess::ApiKey;
    let mut alternate_info = ash_protocol::ModelInfo::new(alternate.model.clone(), "Alternate");
    alternate_info.access = ash_protocol::ModelAccess::ApiKey;
    let catalog = FixedModelCatalog {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                default.clone(),
                &default_info,
                ash_protocol::ModelOutputTransport::Unary,
            ),
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                alternate.clone(),
                &alternate_info,
                ash_protocol::ModelOutputTransport::Unary,
            ),
        ],
        default,
    };
    let server = server().with_model_catalog(Arc::new(catalog));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let listed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"model/list","params":{"view":"builtIn"}}),
    );
    assert_eq!(listed["result"]["models"].as_array().unwrap().len(), 2);
    let session = create_session(&server, &mut connection, 3, "session");
    assert!(session["result"]["session"].get("model").is_none());
}

#[test]
fn typed_commands_replay_and_reject_payload_conflicts() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let first = create_session(&server, &mut connection, 2, "same-command");
    let replayed = create_session(&server, &mut connection, 3, "same-command");
    assert_eq!(
        replayed["result"]["session"]["sessionId"],
        first["result"]["session"]["sessionId"]
    );
    let conflict = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/create",
            "params":{"commandId":"same-command","title":"different"}
        }),
    );
    assert_eq!(conflict["error"]["message"], "CommandConflict");
}

#[test]
fn fork_preserves_parent_context_without_calling_the_model() {
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let root = create_thread(&server, &mut connection, 3, "root", session_id, 1);
    let root_id = root["result"]["value"]["threadId"].as_str().unwrap();
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"parent-turn","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":root_id,"input":[{"type":"text","text":"parent prompt"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, root_id, TurnStatus::Completed);
    assert_eq!(model.requests().len(), 1);

    let fork = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"fork",
                "sessionId":session_id,
                "request":{"type":"forkThread","parentThreadId":root_id,"title":"branch"}
            }
        }),
    );
    assert_eq!(model.requests().len(), 1);

    let child_id = fork["result"]["value"]["threadId"].as_str().unwrap();
    let child_view = fork["result"]["value"]["session"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["threadId"] == child_id)
        .unwrap();
    assert!(child_view.get("parentThreadId").is_none());
    assert_eq!(child_view["forkedFromId"], root_id);
    let child = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"session/thread/read",
            "params":{"sessionId":session_id,"threadId":child_id}
        }),
    );
    assert_eq!(
        child["result"]["thread"]["turns"].as_array().unwrap().len(),
        1
    );
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"session/request",
            "params":{
                "commandId":"child-turn","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":child["result"]["thread"]["sequence"],"threadId":child_id,"input":[{"type":"text","text":"child prompt"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, child_id, TurnStatus::Completed);
    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    assert!(model_request_contains_text(&requests[1], "parent prompt"));
    assert!(model_request_contains_text(&requests[1], "done"));
    assert!(model_request_contains_text(&requests[1], "child prompt"));
    assert_eq!(requests[0].prompt_cache_key.as_deref(), Some(session_id));
    assert_eq!(requests[1].prompt_cache_key, requests[0].prompt_cache_key);
    let prefix_end = requests[1].prompt_cache_prefix_end.unwrap() as usize;
    assert!(prefix_end < requests[1].input.len() - 1);
    assert!(requests[1].input[..=prefix_end].iter().any(|item| {
        matches!(
            item,
            ash_protocol::InputItem::Message(message)
                if message.content.iter().any(|content| {
                    matches!(content, ash_protocol::ContentPart::Text(text) if text == "done")
                })
        )
    }));
}

#[test]
fn rewind_endpoint_imports_only_history_before_the_selected_turn() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let root = create_thread(&server, &mut connection, 3, "root", session_id, 1);
    let root_id = root["result"]["value"]["threadId"].as_str().unwrap();

    let first = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"turn-first","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":root_id,"input":[{"type":"text","text":"first"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, root_id, TurnStatus::Completed);
    let after_first = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/thread/read","params":{"sessionId":session_id,"threadId":root_id}
        }),
    );
    let second = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"session/request",
            "params":{
                "commandId":"turn-second","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":after_first["result"]["thread"]["sequence"],"threadId":root_id,"input":[{"type":"text","text":"second"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, root_id, TurnStatus::Completed);
    let rewound = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"session/request",
            "params":{
                "commandId":"rewind","sessionId":session_id,
                "request":{"type":"rewindThread","parentThreadId":root_id,"beforeTurnId":second["result"]["value"]["turnId"],"title":"rewound"}
            }
        }),
    );
    let child_id = rewound["result"]["value"]["threadId"].as_str().unwrap();
    let child = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":8,"method":"session/thread/read","params":{"sessionId":session_id,"threadId":child_id}
        }),
    );

    assert_eq!(
        child["result"]["thread"]["turns"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        child["result"]["thread"]["turns"][0]["turnId"],
        first["result"]["value"]["turnId"]
    );
    let child_view = rewound["result"]["value"]["session"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["threadId"] == child_id)
        .unwrap();
    assert!(child_view.get("parentThreadId").is_none());
    assert_eq!(child_view["forkedFromId"], root_id);
}

#[test]
fn rewrite_endpoint_replays_one_child_and_one_replacement_turn() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let root = create_thread(&server, &mut connection, 3, "root", session_id, 1);
    let root_id = root["result"]["value"]["threadId"].as_str().unwrap();

    let first = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"turn-first","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":root_id,"input":[{"type":"text","text":"first"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, root_id, TurnStatus::Completed);
    let root_snapshot = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/thread/read",
            "params":{"sessionId":session_id,"threadId":root_id}
        }),
    );
    let second = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"session/request",
            "params":{
                "commandId":"turn-second","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":root_snapshot["result"]["thread"]["sequence"],"threadId":root_id,"input":[{"type":"text","text":"second"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, root_id, TurnStatus::Completed);

    let rewrite_request = serde_json::json!({
        "jsonrpc":"2.0","id":7,"method":"session/request",
        "params":{
            "commandId":"rewrite-operation","sessionId":session_id,
                "request":{
                "type":"rewriteThread",
                "parentThreadId":root_id,
                "beforeTurnId":second["result"]["value"]["turnId"],
                "title":"rewritten",
                "input":[{"type":"text","text":"replacement"}]
            }
        }
    });
    let rewritten = call(&server, &mut connection, rewrite_request.clone());
    assert!(rewritten.get("error").is_none(), "{rewritten}");
    let child_id = rewritten["result"]["value"]["threadId"].as_str().unwrap();
    let replacement_turn_id = rewritten["result"]["value"]["turn"]["turnId"]
        .as_str()
        .unwrap();
    wait_for_latest_turn(&server, child_id, TurnStatus::Completed);

    let mut replay_request = rewrite_request;
    replay_request["id"] = serde_json::json!(8);
    let replayed = call(&server, &mut connection, replay_request);
    assert!(replayed.get("error").is_none(), "{replayed}");
    assert_eq!(replayed["result"]["value"]["threadId"], child_id);
    assert_eq!(
        replayed["result"]["value"]["turn"]["turnId"],
        replacement_turn_id
    );
    assert_eq!(
        replayed["result"]["value"]["session"]["threads"]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    let child = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(child_id).unwrap())
        .unwrap();
    assert_eq!(child.turns.len(), 2);
    assert_eq!(
        child.turns[0].turn_id.as_str(),
        first["result"]["value"]["turnId"]
    );
    assert_eq!(child.turns[1].turn_id.as_str(), replacement_turn_id);
    assert_eq!(
        child
            .commands
            .iter()
            .filter(|command| {
                command.receipt.command_id.as_str() == "session-rewrite/start/rewrite-operation"
            })
            .count(),
        1
    );
    let conflict = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":9,"method":"session/request",
            "params":{
                "commandId":"rewrite-operation","sessionId":session_id,
                "request":{
                    "type":"rewriteThread",
                    "parentThreadId":root_id,
                    "beforeTurnId":second["result"]["value"]["turnId"],
                    "title":"rewritten",
                    "input":[{"type":"text","text":"different replacement"}]
                }
            }
        }),
    );
    assert_eq!(conflict["error"]["message"], "CommandConflict");
}

#[test]
fn thread_read_returns_a_bounded_latest_history_window() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let root = create_thread(&server, &mut connection, 3, "root", session_id, 1);
    let thread_id = root["result"]["value"]["threadId"].as_str().unwrap();

    let first = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"turn-first","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"first"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let full_after_first = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/thread/read",
            "params":{"sessionId":session_id,"threadId":thread_id}
        }),
    );
    let second = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"session/request",
            "params":{
                "commandId":"turn-second","sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":full_after_first["result"]["thread"]["sequence"],"threadId":thread_id,"input":[{"type":"text","text":"second"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);

    let page = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"session/thread/read",
            "params":{
                "sessionId":session_id,"threadId":thread_id,
                "history":{"type":"latest","turnLimit":1}
            }
        }),
    );

    assert_eq!(
        page["result"]["thread"]["turns"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        page["result"]["thread"]["turns"][0]["turnId"],
        second["result"]["value"]["turnId"]
    );
    assert_eq!(page["result"]["history"]["hasOlderTurns"], true);
    assert_eq!(
        page["result"]["history"]["oldestTurnId"],
        second["result"]["value"]["turnId"]
    );
    assert_ne!(
        page["result"]["history"]["oldestTurnId"],
        first["result"]["value"]["turnId"]
    );

    let older_page = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7_1,"method":"session/thread/read",
            "params":{
                "sessionId":session_id,"threadId":thread_id,
                "history":{
                    "type":"before",
                    "turnId":second["result"]["value"]["turnId"],
                    "turnLimit":1
                }
            }
        }),
    );
    assert_eq!(
        older_page["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        older_page["result"]["thread"]["turns"][0]["turnId"],
        first["result"]["value"]["turnId"]
    );
    assert_eq!(older_page["result"]["history"]["hasOlderTurns"], false);

    let subscription = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":8,"method":"session/thread/subscribe",
            "params":{
                "sessionId":session_id,"threadId":thread_id,"afterSequence":0,
                "history":{"type":"latest","turnLimit":1}
            }
        }),
    );
    assert_eq!(
        subscription["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        subscription["result"]["updates"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(subscription["result"]["history"]["hasOlderTurns"], true);

    let invalid = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":9,"method":"session/thread/read",
            "params":{
                "sessionId":session_id,"threadId":thread_id,
                "history":{"type":"latest","turnLimit":0}
            }
        }),
    );
    assert_eq!(invalid["error"]["message"], "InvalidParams");
}

#[derive(Default)]
struct CountingModel {
    calls: AtomicUsize,
}

#[derive(Default)]
struct SteeringModelState {
    requests: Vec<ModelRequest>,
    first_call_started: bool,
    release_first_call: bool,
}

#[derive(Default)]
struct AppServerSteeringModel {
    state: Mutex<SteeringModelState>,
    changed: Condvar,
}

impl AppServerSteeringModel {
    fn wait_for_first_call(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut state = self.state.lock().unwrap();
        while !state.first_call_started {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "model invocation did not start");
            let (next, _) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
        }
    }

    fn release_first_call(&self) {
        let mut state = self.state.lock().unwrap();
        state.release_first_call = true;
        self.changed.notify_all();
    }

    fn requests(&self) -> Vec<ModelRequest> {
        self.state.lock().unwrap().requests.clone()
    }
}

struct ReleaseSteeringModel(Arc<AppServerSteeringModel>);

impl Drop for ReleaseSteeringModel {
    fn drop(&mut self) {
        self.0.release_first_call();
    }
}

#[derive(Default)]
struct FailingSteerBackend {
    steers: AtomicUsize,
}

#[derive(Default)]
struct CountingStartBackend {
    starts: AtomicUsize,
}

impl ash_core::TurnExecutionBackend for CountingStartBackend {
    fn start(&self, _: &ash_protocol::ThreadId, _: &ash_protocol::TurnId) -> Result<(), CoreError> {
        self.starts.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn resume(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
    ) -> Result<(), CoreError> {
        Ok(())
    }
}

impl ash_core::TurnExecutionBackend for FailingSteerBackend {
    fn start(&self, _: &ash_protocol::ThreadId, _: &ash_protocol::TurnId) -> Result<(), CoreError> {
        Ok(())
    }

    fn resume(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
    ) -> Result<(), CoreError> {
        Ok(())
    }

    fn steer(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
        _: &CommandId,
        _: &[UserInput],
    ) -> Result<(), CoreError> {
        self.steers.fetch_add(1, Ordering::Relaxed);
        Err(CoreError::Execution("backend steer failed".into()))
    }
}

struct ShellTestTool;

impl ToolService for ShellTestTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ash_protocol::ToolName::new("shell-command").unwrap(),
            description: "run a test shell command".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "program": {"type": "string"},
                    "arguments": {"type": "array"},
                    "working_directory": {"type": "string"}
                },
                "required": ["program", "arguments", "working_directory"]
            }),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(call.arguments.to_string()),
                ActionKind::LocalProcess(ProcessInvocationKind::Shell),
                "run test shell command",
                CapabilitySet::new([Capability::new(CapabilityKind::ProcessSpawn, "/bin/sh")]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
            SandboxCompatibility::Supported(shell_test_sandbox()),
            ActionPolicyRevision::new("test-shell-v1"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Ok(ToolExecutionOutput::Success(
            serde_json::json!({
                "exit_code": 0,
                "stdout": "shell output\n",
                "stderr": "",
                "stdout_truncated": false,
                "stderr_truncated": false,
            })
            .to_string(),
        ))
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        sink.emit(ToolOutputStream::Stdout, "shell output\n".into())?;
        self.execute(call, authorization, cancellation)
    }
}

struct ShellTestPolicy;

impl ActionPolicyService for ShellTestPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunSandboxed(shell_test_sandbox()))
    }
}

fn shell_test_sandbox() -> SandboxPolicy {
    SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
}

#[test]
fn shell_turn_runs_without_a_model_and_publishes_typed_output() {
    let model = Arc::new(CountingModel::default());
    let terminal_root = tempfile::tempdir().unwrap();
    let server = server_with_model(model.clone())
        .with_terminal_root(dir_authorization(
            terminal_root.path(),
            DirPermission::ExecuteCommands,
        ))
        .unwrap()
        .with_tool_service(Arc::new(ShellTestTool), Arc::new(ShellTestPolicy));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":1}
        }),
    );

    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"shell-turn",
                "sessionId":session_id,
                "request":{"type":"startShellTurn","expectedSequence":1,"threadId":thread_id,"command":"printf shell output","workingDirectory":"."}
            }
        }),
    );

    assert!(response["result"]["value"]["turnId"].is_string());
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    assert_eq!(model.calls.load(Ordering::Relaxed), 0);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    assert!(snapshot.items.iter().any(|item| {
        matches!(
            item,
            ash_protocol::ThreadItem::ToolCall {
                name,
                binding: Some(binding),
                ..
            } if name.as_str() == "shell-command" && binding.caller == ash_protocol::ToolCallCaller::Direct
        )
    }));
    assert!(snapshot.items.iter().any(|item| {
        matches!(
            item,
            ash_protocol::ThreadItem::ToolResult { text, is_error: false, .. }
                if text.contains("shell output")
        )
    }));
    assert!(
        server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| notification.contains("\"toolOutputDelta\""))
    );
}

impl ModelService for CountingModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let prompt = request
            .input
            .iter()
            .find_map(|item| match item {
                InputItem::Message(message) => message.content.iter().find_map(|content| {
                    let ContentPart::Text(text) = content else {
                        return None;
                    };
                    Some(text.as_str())
                }),
                InputItem::ToolResult(_) | InputItem::Reasoning(_) => None,
            })
            .unwrap_or_default();
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(format!("answer: {prompt}"))],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

impl ModelService for AppServerSteeringModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let mut state = self.state.lock().unwrap();
        let call = state.requests.len();
        state.requests.push(request.clone());
        if call == 0 {
            state.first_call_started = true;
            self.changed.notify_all();
            while !state.release_first_call {
                state = self.changed.wait(state).unwrap();
            }
        }
        drop(state);
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(format!("response-{call}"))],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

#[test]
fn completed_turn_replays_without_invoking_the_model_twice() {
    let model = Arc::new(CountingModel::default());
    let server = server_with_model(model.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let request = |id| {
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":id,
            "method":"session/request",
            "params":{
                "commandId":"turn",
                "sessionId":session_id,
                "request":{
                    "type":"startTurn",
                    "expectedSequence":1,
                    "threadId":thread_id,
                    "input":[{"type":"text","text":"hello"}]
                }
            }
        })
    };
    let first = call(&server, &mut connection, request(4));
    let replayed = call(&server, &mut connection, request(5));

    assert_eq!(
        first["result"]["value"]["turnId"],
        replayed["result"]["value"]["turnId"]
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    assert_eq!(model.calls.load(Ordering::Relaxed), 1);
    // Committed state becomes visible before its asynchronous notification is published.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| {
                notification.contains("\"method\":\"session/thread/update\"")
                    && notification.contains("\"agentMessage\"")
            })
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "completed Turn notification was not delivered"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[derive(Default)]
struct RecordingModel {
    requests: Mutex<Vec<ModelRequest>>,
}

impl RecordingModel {
    fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

struct EmptySkillConfig;

impl ash_skills_extension::SkillConfigSnapshotProvider for EmptySkillConfig {
    fn snapshot(&self) -> Result<ash_config::SkillsConfig, String> {
        Ok(ash_config::SkillsConfig::default())
    }
}

impl ModelService for RecordingModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("done".into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

fn model_request_contains_text(request: &ModelRequest, expected: &str) -> bool {
    request.input.iter().any(|item| {
        let InputItem::Message(message) = item else {
            return false;
        };
        message
            .content
            .iter()
            .any(|part| matches!(part, ContentPart::Text(text) if text == expected))
    })
}

#[test]
fn review_turn_freezes_review_rubric_and_renders_the_requested_target() {
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "review-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "review-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"review-turn","sessionId":session_id,
                "request":{
                    "type":"startReview","expectedSequence":1,"threadId":thread_id,
                    "target":{"type":"baseBranch","branch":"main"}
                }
            }
        }),
    );

    assert!(started["result"]["value"]["turnId"].is_string());
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]
            .instructions
            .as_deref()
            .unwrap()
            .matches("## Shared working rules")
            .count(),
        1
    );
    assert!(
        requests[0]
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("overall_correctness"))
    );
    assert!(model_request_contains_text(
        &requests[0],
        "Review the changes against base branch `main`. Determine the merge base with HEAD, then inspect the diff from that merge base."
    ));
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    let instructions = snapshot.turns[0].instructions.as_ref().unwrap();
    assert_eq!(snapshot.turns[0].kind, ash_protocol::TurnKind::Review);
    assert_eq!(instructions.owner(), "agent-roles");
    assert_eq!(instructions.id(), "reviewer");
    let roles = agent_roles::built_in_roles();
    let reviewer = roles.get("reviewer").unwrap();
    assert_eq!(instructions.revision(), reviewer.content_digest());
    assert!(
        requests[0]
            .instructions
            .as_deref()
            .unwrap()
            .contains(reviewer.role_instructions())
    );
    assert_eq!(
        instructions.shared(),
        &[ash_prompts::AGENT_INSTRUCTIONS.freeze().as_text()]
    );
}

#[test]
fn explicit_skill_flows_through_core_extension_lifecycle() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-extension-skill-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let skill_root = root.join("skill-creator");
    std::fs::create_dir_all(&skill_root).unwrap();
    std::fs::write(
        skill_root.join("SKILL.md"),
        "---\nname: skill-creator\ndescription: Create skills\n---\n\nExtension instructions.\n",
    )
    .unwrap();
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone())
        .with_skill_runtime(
            ash_skills_extension::BuiltInSkillSource::Root(root.clone()),
            Arc::new(EmptySkillConfig),
            None,
        )
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "skill-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "skill-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"skill-turn","sessionId":session_id,
                "request":{
                    "type":"startTurn","expectedSequence":1,"threadId":thread_id,
                    "input":[
                        {"type":"skill","skill":{
                            "id":{"source":"builtin:skill-source:ash-release","name":"skill-creator"},
                            "version":{"type":"followLatest"}
                        }},
                        {"type":"text","text":"create one"}
                    ]
                }
            }
        }),
    );

    assert!(started["result"]["value"]["turnId"].is_string());
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    assert_eq!(snapshot.turns[0].activated_skills.len(), 1);
    let requests = model.requests.lock().unwrap();
    assert!(
        requests[0]
            .tools
            .iter()
            .any(|tool| tool.name.as_str() == ash_skills_extension::SKILLS_READ_TOOL_NAME)
    );
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .filter(|tool| tool.name.as_str() == ash_skills_extension::SKILLS_READ_TOOL_NAME)
            .count(),
        1
    );
    assert!(requests[0].input.iter().any(|item| {
        let InputItem::Message(message) = item else {
            return false;
        };
        message.content.iter().any(|part| {
            matches!(part, ContentPart::Text(text) if text.contains("<skill-instructions") && text.contains("Extension instructions."))
        })
    }));
    assert!(requests[0].input.iter().any(|item| {
        let InputItem::Message(message) = item else {
            return false;
        };
        message.content.iter().any(|part| {
            matches!(part, ContentPart::Text(text) if text.contains("<available-skills") && text.contains("name=\"skill-creator\""))
        })
    }));
    assert!(
        requests[0]
            .tools
            .iter()
            .any(|tool| tool.name.as_str() == ash_skills_extension::SKILLS_READ_TOOL_NAME)
    );
    drop(requests);
    drop(server);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_instructions_skill_uses_normal_activation() {
    let home_root = tempfile::tempdir().unwrap();
    let home = Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(home_root.path()).unwrap(),
    ));
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone())
        .with_home(home)
        .with_skill_runtime(
            ash_skills_extension::BuiltInSkillSource::Root(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills/assets"),
            ),
            Arc::new(EmptySkillConfig),
            None,
        )
        .unwrap();
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}
        }),
    );
    assert!(
        !initialized["result"]["slashCommands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command["name"] == "create-instructions")
    );
    let session = create_session(&server, &mut connection, 2, "instructions-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(
        &server,
        &mut connection,
        3,
        "instructions-thread",
        session_id,
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"create-instructions-turn","sessionId":session_id,
                "request":{
                    "type":"startTurn","expectedSequence":1,"threadId":thread_id,
                    "input":[{"type":"skill","skill":{"id":{"source":"builtin:skill-source:ash-release","name":"create-instructions"},"version":{"type":"followLatest"}}},{"type":"text","text":"Create workspace Rust rules"}]
                }
            }
        }),
    );

    assert!(
        started["result"]["value"]["turnId"].is_string(),
        "{started}"
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    assert_eq!(snapshot.turns[0].activated_skills.len(), 1);
    assert_eq!(
        snapshot.turns[0].activated_skills[0].id.name.as_str(),
        "create-instructions"
    );
    let requests = model.requests.lock().unwrap();
    assert!(requests[0].input.iter().any(|item| matches!(item, InputItem::Message(message) if message.content.iter().any(|part| matches!(part, ContentPart::Text(text) if text.contains("# Create instructions"))))));
    assert_ne!(
        snapshot.turns[0].instructions.as_ref().unwrap().id(),
        "instructions/create"
    );
}

#[test]
fn init_command_freezes_ash_md_guidance_without_skill_activation() {
    let home_root = tempfile::tempdir().unwrap();
    let home = Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(home_root.path()).unwrap(),
    ));
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone()).with_home(home);
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "init-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "init-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"init-turn","sessionId":session_id,
                "request":{
                    "type":"startTurn","expectedSequence":1,"threadId":thread_id,
                    "input":[{"type":"text","text":"/init workspace"}]
                }
            }
        }),
    );

    assert!(
        started["result"]["value"]["turnId"].is_string(),
        "{started}"
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    let instructions = snapshot.turns[0].instructions.as_ref().unwrap();
    assert_eq!(instructions.id(), "instructions/init");
    assert!(snapshot.turns[0].activated_skills.is_empty());
    let requests = model.requests.lock().unwrap();
    assert!(
        requests[0]
            .instructions
            .as_deref()
            .unwrap()
            .contains("Create or update `ASH.md`")
    );
}

#[test]
fn session_request_routes_thread_mutations_and_freezes_turn_approval_mode() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();

    let thread = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"session/request",
            "params":{
                "commandId":"create-thread",
                "sessionId":session_id,
                "request":{"type":"createThread","title":"thread"}
            }
        }),
    );
    assert_eq!(thread["result"]["type"], "thread");
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let turn = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"start-turn",
                "sessionId":session_id,
                "request":{
                    "type":"startTurn",
                    "threadId":thread_id,
                    "expectedSequence":1,
                    "approvalMode":"autoReview",
                    "input":[{"type":"text","text":"hello"}]
                }
            }
        }),
    );
    assert_eq!(turn["result"]["type"], "turn");
    assert!(turn["result"]["value"]["turnId"].is_string());
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    assert_eq!(
        snapshot.turns.last().unwrap().approval_mode,
        ash_protocol::ApprovalMode::AutoReview
    );
}

#[test]
fn session_request_steers_a_running_turn_retry_safely_and_replans() {
    let model = Arc::new(AppServerSteeringModel::default());
    let _release_on_drop = ReleaseSteeringModel(Arc::clone(&model));
    let selected = model_ref("steering");
    let mut info = ash_protocol::ModelInfo::new(selected.model.clone(), "Steering model");
    info.access = ash_protocol::ModelAccess::Subscription;
    let server = server_with_model(model.clone()).with_model_catalog(Arc::new(FixedModelCatalog {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                selected.clone(),
                &info,
                ash_protocol::ModelOutputTransport::Unary,
            ),
        ],
        default: selected,
    }));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "steer-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "steer-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"start-steered-turn",
                "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"initial"}]}
            }
        }),
    );
    let turn_id = started["result"]["value"]["turnId"].as_str().unwrap();
    let start_sequence = started["result"]["value"]["sequence"].as_u64().unwrap();
    model.wait_for_first_call();

    let blocked = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":40,"method":"session/request",
            "params":{
                "commandId":"steer-subscription-image",
                "sessionId":session_id,
                "request":{
                    "type":"steerTurn",
                    "expectedSequence":start_sequence,
                    "threadId":thread_id,
                    "turnId":turn_id,
                    "input":[{"type":"image","url":"https://example.test/image.png"}]
                }
            }
        }),
    );
    assert_eq!(blocked["error"]["message"], "CoreOperationFailed");

    let steer_request = |id| {
        serde_json::json!({
            "jsonrpc":"2.0","id":id,"method":"session/request",
            "params":{
                "commandId":"steer-running-turn",
                "sessionId":session_id,
                "request":{
                    "type":"steerTurn",
                    "expectedSequence":start_sequence,
                    "threadId":thread_id,
                    "turnId":turn_id,
                    "input":[{"type":"text","text":"focus on the failing test"}]
                }
            }
        })
    };
    let steered = call(&server, &mut connection, steer_request(5));
    assert_eq!(steered["result"]["type"], "turnSteer");
    assert_eq!(steered["result"]["value"]["turnId"], turn_id);
    assert_eq!(
        steered["result"]["value"]["sequence"].as_u64().unwrap(),
        start_sequence + 3
    );

    let replayed = call(&server, &mut connection, steer_request(6));
    assert_eq!(replayed["result"], steered["result"]);
    let conflict = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"session/request",
            "params":{
                "commandId":"steer-running-turn",
                "sessionId":session_id,
                "request":{
                    "type":"steerTurn",
                    "expectedSequence":start_sequence,
                    "threadId":thread_id,
                    "turnId":turn_id,
                    "input":[{"type":"text","text":"different payload"}]
                }
            }
        }),
    );
    assert_eq!(conflict["error"]["message"], "CommandConflict");

    let protocol_thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();
    assert_eq!(
        snapshot
            .items
            .iter()
            .filter(|item| matches!(
                item,
                ash_protocol::ThreadItem::UserMessage { text, .. }
                    if text == "focus on the failing test"
            ))
            .count(),
        1
    );

    model.release_first_call();
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].input.iter().any(|item| {
        matches!(item, InputItem::Message(message) if message.content.iter().any(
            |part| matches!(part, ContentPart::Text(text) if text == "focus on the failing test")
        ))
    }));
    let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ash_protocol::ThreadItem::AgentMessage { text, .. } if text == "response-1"
    )));
    assert!(!snapshot.items.iter().any(|item| matches!(
        item,
        ash_protocol::ThreadItem::AgentMessage { text, .. } if text == "response-0"
    )));
}

#[derive(Default)]
struct FailingStartBackend {
    starts: AtomicUsize,
}

impl ash_core::TurnExecutionBackend for FailingStartBackend {
    fn start(&self, _: &ash_protocol::ThreadId, _: &ash_protocol::TurnId) -> Result<(), CoreError> {
        self.starts.fetch_add(1, Ordering::Relaxed);
        Err(CoreError::Execution("backend start failed".into()))
    }

    fn resume(
        &self,
        _: &ash_protocol::ThreadId,
        _: &ash_protocol::TurnId,
    ) -> Result<(), CoreError> {
        panic!("a failed start must not resume")
    }
}

#[test]
fn failed_backend_start_publishes_terminal_state_and_does_not_repeat_on_rpc_retry() {
    let backend = Arc::new(FailingStartBackend::default());
    let server = server().with_turn_backend(backend.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "failed-start-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(
        &server,
        &mut connection,
        3,
        "failed-start-thread",
        session_id,
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":1}
        }),
    );
    server.drain_notifications(&mut connection);
    let request = |id| {
        serde_json::json!({
            "jsonrpc":"2.0", "id":id, "method":"session/request",
            "params":{
                "commandId":"failed-start", "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"hello"}]}
            }
        })
    };
    assert_eq!(
        call(&server, &mut connection, request(5))["error"]["message"],
        "CoreOperationFailed"
    );
    assert_eq!(
        call(&server, &mut connection, request(6))["error"]["message"],
        "CoreOperationFailed"
    );
    assert_eq!(backend.starts.load(Ordering::Relaxed), 1);
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":7, "method":"session/thread/read",
            "params":{"sessionId":session_id,"threadId":thread_id}
        }),
    );
    assert_eq!(
        read["result"]["thread"]["turns"][0]["status"], "failed",
        "{read}"
    );
    assert!(
        server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| {
                notification.contains("\"method\":\"session/thread/update\"")
                    && notification.contains("\"turnFailed\"")
            })
    );
}

#[test]
fn failed_backend_steer_is_not_replayed_across_rpc_retry() {
    let backend = Arc::new(FailingSteerBackend::default());
    let server = server().with_turn_backend(backend.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "failed-steer-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(
        &server,
        &mut connection,
        3,
        "failed-steer-thread",
        session_id,
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"start-failed-steer-turn",
                "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"initial"}]}
            }
        }),
    );
    let turn_id = started["result"]["value"]["turnId"].as_str().unwrap();
    let sequence = started["result"]["value"]["sequence"].as_u64().unwrap();
    let request = |id| {
        serde_json::json!({
            "jsonrpc":"2.0","id":id,"method":"session/request",
            "params":{
                "commandId":"failed-backend-steer",
                "sessionId":session_id,
                "request":{
                    "type":"steerTurn",
                    "expectedSequence":sequence,
                    "threadId":thread_id,
                    "turnId":turn_id,
                    "input":[{"type":"text","text":"updated direction"}]
                }
            }
        })
    };

    let failed = call(&server, &mut connection, request(5));
    let replayed = call(&server, &mut connection, request(6));

    assert_eq!(failed["error"]["message"], "CoreOperationFailed");
    assert_eq!(replayed["error"]["message"], "CoreOperationFailed");
    assert_eq!(backend.steers.load(Ordering::Relaxed), 1);
    let snapshot = server
        .threads()
        .read_thread(&ash_protocol::ThreadId::new(thread_id).unwrap())
        .unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Failed);
    assert!(
        !snapshot
            .steer_deliveries
            .contains_key(&CommandId::new("failed-backend-steer").unwrap())
    );
}

#[test]
fn session_read_returns_the_same_agent_tree_as_subscription_without_subscribing() {
    let server = server();
    let mut writer = server.connection();
    let mut reader = server.connection();
    initialize(&server, &mut writer);
    initialize(&server, &mut reader);
    let created = create_session(&server, &mut writer, 2, "details-session");
    let id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let read = call(
        &server,
        &mut reader,
        serde_json::json!({
            "jsonrpc":"2.0", "id":3, "method":"session/read", "params":{"sessionId":id}
        }),
    );
    assert_eq!(read["result"]["agentTree"]["roots"][0]["threadId"], id);
    assert_eq!(
        read["result"]["agentTree"]["roots"][0]["executionStatus"],
        "idle"
    );
    let subscribed = call(
        &server,
        &mut writer,
        serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"session/subscribe", "params":{"sessionId":id}
        }),
    );
    assert_eq!(
        read["result"]["agentTree"],
        subscribed["result"]["agentTree"]
    );
    let fork = call(
        &server,
        &mut writer,
        serde_json::json!({
            "jsonrpc":"2.0", "id":5, "method":"session/request", "params":{
                "commandId":"details-fork", "sessionId":id,
                "request":{"type":"forkThread", "parentThreadId":id, "title":"Alternative"}
            }
        }),
    );
    assert!(fork.get("error").is_none(), "{fork}");
    assert!(server.drain_notifications(&mut reader).is_empty());
    let read = call(
        &server,
        &mut reader,
        serde_json::json!({
            "jsonrpc":"2.0", "id":6, "method":"session/read", "params":{"sessionId":id}
        }),
    );
    assert_eq!(
        read["result"]["agentTree"]["roots"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        read["result"]["agentTree"]["roots"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["forkedFromId"] == id)
    );
}

#[test]
fn updates_are_broadcast_to_other_subscribed_connections() {
    let server = server();
    let mut writer = server.connection();
    initialize(&server, &mut writer);
    let session = create_session(&server, &mut writer, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut writer, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let mut observer = server.connection();
    initialize(&server, &mut observer);
    let session_subscription = call(
        &server,
        &mut observer,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"session/subscribe",
            "params":{"sessionId":session_id,"afterSequence":3}
        }),
    );
    assert_eq!(
        session_subscription["result"]["threadProjections"][0]["thread"]["threadId"],
        thread_id
    );
    assert_eq!(
        session_subscription["result"]["agentTree"]["roots"][0]["threadId"],
        thread_id
    );
    call(
        &server,
        &mut writer,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"session/request",
            "params":{
                "commandId":"fork",
                "sessionId":session_id,
                "request":{"type":"forkThread","parentThreadId":thread_id,"title":"branch"}
            }
        }),
    );
    call(
        &server,
        &mut writer,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"session/request",
            "params":{
                "commandId":"turn",
                "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"hello"}]}
            }
        }),
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);

    let notifications = server.drain_notifications(&mut observer);
    assert!(
        notifications
            .iter()
            .any(|value| value.contains("\"method\":\"session/changed\""))
    );
    assert!(notifications.iter().any(|value| {
        value.contains("\"method\":\"session/thread/update\"") && value.contains("\"agentMessage\"")
    }));
    assert!(notifications.iter().any(|value| {
        value.contains("\"method\":\"session/thread/update\"")
            && value.contains("\"itemDelta\"")
            && value.contains("\"streamCursor\"")
    }));
}

#[test]
fn subscribe_returns_durable_gap_for_reconnect() {
    let server = server();
    let mut first_connection = server.connection();
    initialize(&server, &mut first_connection);
    let session = create_session(&server, &mut first_connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut first_connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();

    let mut reconnected = server.connection();
    initialize(&server, &mut reconnected);
    let replay = call(
        &server,
        &mut reconnected,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}
        }),
    );
    assert_eq!(replay["result"]["updates"][0]["durableSequence"], 1);
    assert_eq!(
        replay["result"]["updates"][0]["update"]["type"],
        "committed"
    );
}

#[test]
fn resources_remain_connection_owned_and_chunked() {
    let server = server();
    let mut owner = server.connection();
    let mut other = server.connection();
    initialize(&server, &mut owner);
    initialize(&server, &mut other);
    let resource_id = server
        .create_resource(&owner, "text/plain".into(), b"hello".to_vec())
        .unwrap();
    let owner_read = call(
        &server,
        &mut owner,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"resource/read",
            "params":{"resourceId":resource_id,"offset":0,"maxBytes":3}
        }),
    );
    assert_eq!(owner_read["result"]["decodedLength"], 3);
    let denied = call(
        &server,
        &mut other,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"resource/read",
            "params":{"resourceId":resource_id,"offset":0,"maxBytes":3}
        }),
    );
    assert_eq!(denied["error"]["message"], "ResourceNotOwner");
}

#[test]
fn typst_compilation_returns_a_connection_owned_pdf_resource() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let compiled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"document/typst/compile",
            "params":{"source":"= Paper\n\nA formula: $x^2$."}
        }),
    );
    assert_eq!(compiled["result"]["status"], "success");
    assert_eq!(
        compiled["result"]["resource"]["mimeType"],
        "application/pdf"
    );
    let resource_id = compiled["result"]["resource"]["resourceId"]
        .as_str()
        .unwrap();

    let bytes = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"resource/read",
            "params":{"resourceId":resource_id,"offset":0,"maxBytes":16}
        }),
    );
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(bytes["result"]["dataBase64"].as_str().unwrap())
        .unwrap();
    assert!(decoded.starts_with(b"%PDF-"));
}

#[test]
fn typst_source_errors_are_typed_results_not_server_failures() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let compiled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"document/typst/compile",
            "params":{"source":"#let ="}
        }),
    );
    assert_eq!(compiled["result"]["status"], "failed");
    assert!(
        compiled["result"]["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| !diagnostics.is_empty())
    );
}

#[test]
fn gui_config_updates_round_trip_without_backend_field_interpretation() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-gui-config-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server().with_config_store(Arc::new(ConfigStore::open(&path).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let updated = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"config/update",
            "params":{
                "commandId":"configure-gui","expectedRevision":0,
                "gui":{
                    "theme":"ash-dark",
                    "interfaceFontFamily":"Inter",
                    "interfaceFontSize":15,
                    "editorFontFamily":"JetBrains Mono",
                    "editorFontSize":15,
                    "editorLineHeight":24
                }
            }
        }),
    );
    assert_eq!(updated["result"]["revision"], 1);
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"config/read","params":{}}),
    );
    assert_eq!(
        read["result"]["gui"],
        serde_json::json!({
            "theme":"ash-dark",
            "interfaceFontFamily":"Inter",
            "interfaceFontSize":15,
            "editorFontFamily":"JetBrains Mono",
            "editorFontSize":15,
            "editorLineHeight":24
        })
    );

    let reset = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"config/update",
            "params":{
                "commandId":"reset-gui","expectedRevision":1,
                "gui":null
            }
        }),
    );
    assert_eq!(reset["result"]["revision"], 2);
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"config/read","params":{}}),
    );
    assert_eq!(read["result"]["gui"], serde_json::json!({}));

    drop(connection);
    drop(server);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("toml"));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
}

#[test]
fn config_updates_use_typed_command_ids() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-config-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server().with_config_store(Arc::new(ConfigStore::open(&path).unwrap()));
    let mut connection = server.connection();
    let mut observer = server.connection();
    initialize(&server, &mut connection);
    initialize(&server, &mut observer);
    let updated = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"config/update",
            "params":{
                "commandId":"config-noop","expectedRevision":0,
                "approvalReviewModel":{"type":"automatic"}
            }
        }),
    );
    assert_eq!(updated["result"]["revision"], 0);
    assert_eq!(updated["result"]["generation"], 0);
    assert_eq!(updated["result"]["disposition"], "updated");
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"config/read","params":{}}),
    );
    assert_eq!(read["result"]["revision"], 0);
    assert_eq!(
        read["result"]["approvalReviewModel"],
        serde_json::json!({"type":"automatic"})
    );
    assert_eq!(read["result"]["gui"], serde_json::json!({}));
    let mcp = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"mcp/server/upsert",
            "params":{
                "commandId":"github-mcp","expectedRevision":0,
                "server":{
                    "id":"user:mcp:github",
                    "displayName":"GitHub",
                    "transport":{"type":"streamableHttp","url":"https://mcp.github.example"},
                    "credential":{"type":"reference","credentialRef":"user:credential:github"},
                    "enablement":"disabled"
                }
            }
        }),
    );
    assert_eq!(mcp["result"]["revision"], 1);
    let mcp_status = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":40,"method":"mcp/server/status","params":{}
        }),
    );
    assert_eq!(mcp_status["result"]["catalogGeneration"], 1);
    assert_eq!(mcp_status["result"]["servers"][0]["id"], "user:mcp:github");
    assert_eq!(
        mcp_status["result"]["servers"][0]["state"]["status"],
        "disabled"
    );
    let skill = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":5,"method":"skill/source/add",
            "params":{
                "commandId":"personal-skills","expectedRevision":1,
                "source":{
                    "id":"user:skill-source:personal",
                    "rootReference":"user:skill-root:personal",
                    "enablement":"disabled"
                }
            }
        }),
    );
    assert_eq!(skill["result"]["revision"], 2);
    let enabled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"mcp/server/enablement/set",
            "params":{
                "commandId":"enable-github-mcp","expectedRevision":2,
                "serverId":"user:mcp:github","enablement":"enabled"
            }
        }),
    );
    assert_eq!(enabled["result"]["revision"], 3);
    let stale = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"skill/source/enablement/set",
            "params":{
                "commandId":"stale-skill","expectedRevision":2,
                "sourceId":"user:skill-source:personal","enablement":"enabled"
            }
        }),
    );
    assert_eq!(stale["error"]["message"], "ConfigRevisionConflict");
    let plugin = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":8,"method":"plugin/request/upsert",
            "params":{
                "commandId":"request-review-plugin","expectedRevision":3,
                "request":{
                    "pluginId":"acme/code-review",
                    "version":"1.2.3",
                    "enablement":"disabled"
                }
            }
        }),
    );
    assert_eq!(plugin["result"]["revision"], 4);
    let hook = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":9,"method":"hook/upsert",
            "params":{
                "commandId":"add-review-hook","expectedRevision":4,
                "hook":{
                    "id":"user:hook:review",
                    "event":"beforeTool",
                    "matcher":{"toolNames":["shell_command"]},
                    "action":{"type":"process","program":"review-hook","args":["--check"]},
                    "enablement":"disabled"
                }
            }
        }),
    );
    assert_eq!(hook["result"]["revision"], 5);
    let plugin_enabled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":10,"method":"plugin/request/enablement/set",
            "params":{
                "commandId":"enable-review-plugin","expectedRevision":5,
                "pluginId":"acme/code-review","enablement":"enabled"
            }
        }),
    );
    assert_eq!(plugin_enabled["result"]["revision"], 6);
    let hook_enabled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":11,"method":"hook/enablement/set",
            "params":{
                "commandId":"enable-review-hook","expectedRevision":6,
                "hookId":"user:hook:review","enablement":"enabled"
            }
        }),
    );
    assert_eq!(hook_enabled["result"]["revision"], 7);
    let executable = std::env::temp_dir()
        .join("rust-analyzer")
        .to_string_lossy()
        .into_owned();
    let language_server = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":12,"method":"languageServer/configure",
            "params":{
                "commandId":"configure-rust-analyzer","expectedRevision":7,
                "serverId":"rust-analyzer",
                "config":{"mode":"enabled","executable":executable}
            }
        }),
    );
    assert_eq!(language_server["result"]["revision"], 8);
    let configured = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":13,"method":"config/read","params":{}}),
    );
    assert_eq!(configured["result"]["revision"], 8);
    assert_eq!(
        configured["result"]["mcpServers"]["user:mcp:github"]["enablement"],
        "enabled"
    );
    assert_eq!(
        configured["result"]["skillSources"]["user:skill-source:personal"]["rootReference"],
        "user:skill-root:personal"
    );
    assert_eq!(
        configured["result"]["pluginRequests"]["acme/code-review"]["enablement"],
        "enabled"
    );
    assert_eq!(
        configured["result"]["hooks"]["user:hook:review"]["action"]["program"],
        "review-hook"
    );
    assert_eq!(
        configured["result"]["languageServers"]["rust-analyzer"]["mode"],
        "enabled"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let observed = server
            .drain_notifications(&mut observer)
            .into_iter()
            .map(|notification| serde_json::from_str::<serde_json::Value>(&notification).unwrap())
            .any(|notification| {
                notification["method"] == "config/changed"
                    && notification["params"]["revision"] == 8
                    && notification["params"]["generation"] == 8
            });
        if observed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "config watcher did not publish the committed generation"
        );
        thread::sleep(Duration::from_millis(10));
    }
    drop(observer);
    drop(connection);
    drop(server);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
}

#[test]
fn config_update_persists_and_reads_the_tui_section() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-tui-theme-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server().with_config_store(Arc::new(ConfigStore::open(&path).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let updated = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"config/update",
            "params":{
                "commandId":"select-tui-theme",
                "expectedRevision":0,
                "tui":{"theme":"ash-code-light"}
            }
        }),
    );
    assert_eq!(updated["result"]["revision"], 1);

    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"config/read","params":{}}),
    );
    assert_eq!(read["result"]["tui"]["theme"], "ash-code-light");
    let document = std::fs::read_to_string(path.with_extension("toml")).unwrap();
    assert!(document.contains("[tui]\n"));
    assert!(document.contains("theme = \"ash-code-light\""));

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("toml"));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
}

#[test]
fn exec_policy_rule_rpc_round_trips_typed_user_rules() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-exec-policy-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server().with_config_store(Arc::new(ConfigStore::open(&path).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let upserted = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"execPolicy/rule/upsert",
            "params":{
                "commandId":"allow-git-status","expectedRevision":0,
                "rule":{
                    "id":"allow-git-status",
                    "selector":{
                        "type":"commandPrefix",
                        "pattern":[
                            {"type":"literal","value":"git"},
                            {"type":"literal","value":"status"}
                        ]
                    },
                    "effect":{"type":"allowUnsandboxed"},
                    "justification":"explicit user rule"
                }
            }
        }),
    );
    assert_eq!(upserted["result"]["revision"], 1);

    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"config/read","params":{}}),
    );
    assert_eq!(
        read["result"]["execPolicyRules"],
        serde_json::json!([{
            "id":"allow-git-status",
            "selector":{
                "type":"commandPrefix",
                "pattern":[
                    {"type":"literal","value":"git"},
                    {"type":"literal","value":"status"}
                ]
            },
            "effect":{"type":"allowUnsandboxed"},
            "justification":"explicit user rule"
        }])
    );

    let removed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"execPolicy/rule/remove",
            "params":{
                "commandId":"remove-git-status","expectedRevision":1,
                "ruleId":"allow-git-status"
            }
        }),
    );
    assert_eq!(removed["result"]["revision"], 2);
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"config/read","params":{}}),
    );
    assert_eq!(read["result"]["execPolicyRules"], serde_json::json!([]));
}

#[test]
fn mcp_runtime_intent_rpc_does_not_mutate_config_revision() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-mcp-intent-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server()
        .with_config_store(Arc::new(ConfigStore::open(&path).unwrap()))
        .with_local_env_host(None, crate::server::DirGrantPolicy::InspectOnly)
        .unwrap();
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}
        }),
    );
    assert!(
        initialized["result"]["capabilities"]["sessions"]
            .as_bool()
            .unwrap()
    );

    let created = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"mcp/server/upsert",
            "params":{
                "commandId":"intent-server","expectedRevision":0,
                "server":{
                    "id":"user:mcp:intent",
                    "displayName":"Intent",
                    "transport":{"type":"streamableHttp","url":"https://mcp.example.test"},
                    "credential":{"type":"unauthenticated"},
                    "enablement":"disabled"
                }
            }
        }),
    );
    assert_eq!(created["result"]["revision"], 1);
    let connected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"mcp/server/connect",
            "params":{"serverId":"user:mcp:intent"}
        }),
    );
    assert_eq!(
        connected["result"],
        serde_json::json!({
            "serverId":"user:mcp:intent","intent":"connect"
        })
    );
    let disconnected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":4,"method":"mcp/server/disconnect",
            "params":{"serverId":"user:mcp:intent"}
        }),
    );
    assert_eq!(
        disconnected["result"],
        serde_json::json!({
            "serverId":"user:mcp:intent","intent":"disconnect"
        })
    );
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"config/read","params":{}}),
    );
    assert_eq!(read["result"]["revision"], 1);
    assert_eq!(
        read["result"]["mcpServers"]["user:mcp:intent"]["enablement"],
        "disabled"
    );
}

#[test]
fn tool_search_configure_rejects_an_unavailable_embedding_before_commit() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-tool-search-config-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server().with_config_store(Arc::new(ConfigStore::open(&path).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"toolSearch/configure",
            "params":{
                "commandId":"enable-tool-search","expectedRevision":0,
                "mode":"hybridEmbedding",
                "embeddingModel":{"provider":"ollama","model":"nomic-embed-text"}
            }
        }),
    );
    assert_eq!(rejected["error"]["message"], "ToolSearchUnavailable");

    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"config/read","params":{}}),
    );
    assert_eq!(read["result"]["revision"], 0);
    assert_eq!(read["result"]["toolSearch"]["mode"], "lexical");
    assert_eq!(
        read["result"]["toolSearch"]["embeddingStatus"]["type"],
        "disabled"
    );
}

#[test]
fn provider_context_budget_metadata_round_trips_through_the_rpc() {
    let path = std::env::temp_dir().join(format!(
        "ash-app-server-model-context-{}.sqlite3",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let server = server().with_config_store(Arc::new(ConfigStore::open(&path).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let configured = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"provider/configure",
            "params":{
                "commandId":"configure-openai-context","expectedRevision":0,
                "config":{
                    "provider":"openai",
                    "modelContext":{
                        "gpt-5.6":{
                            "contextWindow":200000,
                            "autoCompactTokenLimit":150000
                        }
                    }
                }
            }
        }),
    );
    assert_eq!(configured["result"]["revision"], 1);

    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"config/read","params":{}}),
    );
    assert_eq!(
        read["result"]["providers"]["openai"]["modelContext"]["gpt-5.6"],
        serde_json::json!({
            "contextWindow": 200000,
            "autoCompactTokenLimit": 150000
        })
    );

    drop(connection);
    drop(server);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("toml"));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
}

#[test]
fn interaction_resolution_uses_the_durable_identity_and_resumes_the_turn() {
    let server = server();
    let mut connection = server.connection();
    initialize_with_capabilities(
        &server,
        &mut connection,
        serde_json::json!({
            "agentInteractions":{"version":1,"kinds":["userInput"]}
        }),
    );
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let session_id = ash_protocol::SessionId::new(session_id).unwrap();
    let started = server
        .threads()
        .start_turn(
            &thread_id,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("agent-turn").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "wait".into(),
                }],
            },
        )
        .unwrap();
    server
        .threads()
        .request_turn_interaction(
            &thread_id,
            &started.turn_id,
            RequestTurnInteraction {
                request_id: RequestId::new("input-1").unwrap(),
                item_id: None,
                request: AgentRequest::UserInput {
                    request: RequestUserInput {
                        questions: Vec::new(),
                    },
                },
                deadline: None,
            },
        )
        .unwrap();

    let subscribed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}
        }),
    );
    assert!(subscribed["result"]["thread"].is_object());
    let notifications = server.drain_notifications(&mut connection);
    assert!(
        notifications
            .iter()
            .any(|notification| notification.contains("\"method\":\"agent/request\""))
    );

    let resolved = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"resolve-input-1",
                "sessionId":session_id,
                "request":{"type":"resolveInteraction","expectedSequence":5,"threadId":thread_id,"turnId":started.turn_id,"requestId":"input-1","response":{"type":"userInput", "response":{"answers":{}}}}
            }
        }),
    );

    assert_eq!(resolved["result"]["value"]["sequence"], 6);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let snapshot = server.threads().read_thread(&thread_id).unwrap();
        assert!(snapshot.turns[0].pending_interaction.is_none());
        if snapshot.turns[0].status == ash_core::TurnStatus::Completed {
            assert!(snapshot.items.iter().any(|item| {
                matches!(item, ash_protocol::ThreadItem::AgentMessage { text, .. } if text == "Ash: wait")
            }));
            break;
        }
        assert_eq!(snapshot.turns[0].status, ash_core::TurnStatus::Running);
        assert!(
            Instant::now() < deadline,
            "resolved interaction did not resume the waiting Turn"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[derive(Default)]
struct AppServerInteractiveModel {
    calls: AtomicUsize,
}

impl ModelService for AppServerInteractiveModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let call = self.calls.fetch_add(1, Ordering::Relaxed);
        if call == 0 {
            return Ok(ModelResponse {
                output: vec![ResponseItem::ToolCall(ToolCall {
                    id: ash_protocol::ToolCallId::new("app-server-interactive-call").unwrap(),
                    name: ash_protocol::ToolName::new("app-server-interactive").unwrap(),
                    arguments: serde_json::json!({}),
                })],
                usage: None,
                billing: None,
                stop_reason: StopReason::ToolUse,
            });
        }
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("done".into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

struct AppServerInteractiveTool;

impl ToolService for AppServerInteractiveTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ash_protocol::ToolName::new("app-server-interactive").unwrap(),
            description: "request test user input".into(),
            parameters: serde_json::json!({"type":"object"}),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::SystemOperation,
                "request test user input",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "app-server-interactive"),
            SandboxCompatibility::Supported(shell_test_sandbox()),
            ActionPolicyRevision::new("app-server-interactive-v1"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(
            "interactive execution context is required".into(),
        ))
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
        _: &ash_core::ToolExecutionFacts,
        interactions: Arc<dyn ash_core::ToolInteractionService>,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match interactions.request_user_input(RequestUserInput {
            questions: vec![ash_protocol::UserInputQuestion {
                id: "city".into(),
                header: "City".into(),
                question: "Which city?".into(),
                options: Vec::new(),
                allow_free_form: true,
            }],
        })? {
            ash_core::ToolUserInputOutcome::Answered(response) => Ok(ToolExecutionOutput::Success(
                response.answers["city"].value.clone(),
            )),
            ash_core::ToolUserInputOutcome::Cancelled(reason) => Ok(ToolExecutionOutput::Failure(
                format!("interaction cancelled: {reason:?}"),
            )),
        }
    }
}

struct CountingResumeBackend {
    delegate: Arc<dyn ash_core::TurnExecutionBackend>,
    resumes: Arc<AtomicUsize>,
}

impl ash_core::TurnExecutionBackend for CountingResumeBackend {
    fn start(
        &self,
        thread_id: &ash_protocol::ThreadId,
        turn_id: &ash_protocol::TurnId,
    ) -> Result<(), CoreError> {
        self.delegate.start(thread_id, turn_id)
    }

    fn resume(
        &self,
        thread_id: &ash_protocol::ThreadId,
        turn_id: &ash_protocol::TurnId,
    ) -> Result<(), CoreError> {
        self.resumes.fetch_add(1, Ordering::Relaxed);
        self.delegate.resume(thread_id, turn_id)
    }

    fn steer(
        &self,
        thread_id: &ash_protocol::ThreadId,
        turn_id: &ash_protocol::TurnId,
        command_id: &CommandId,
        input: &[UserInput],
    ) -> Result<(), CoreError> {
        self.delegate.steer(thread_id, turn_id, command_id, input)
    }
}

#[test]
fn live_tool_interaction_resolution_wakes_execution_without_duplicate_backend_resume() {
    let model = Arc::new(AppServerInteractiveModel::default());
    let server = server_with_model(model.clone()).with_tool_service(
        Arc::new(AppServerInteractiveTool),
        Arc::new(ShellTestPolicy),
    );
    let resumes = Arc::new(AtomicUsize::new(0));
    let backend = Arc::new(CountingResumeBackend {
        delegate: server.turn_executor_backend(),
        resumes: resumes.clone(),
    });
    let server = server.with_turn_backend(backend);
    let mut connection = server.connection();
    initialize_with_capabilities(
        &server,
        &mut connection,
        serde_json::json!({
            "agentInteractions":{"version":1,"kinds":["userInput"]}
        }),
    );
    let session = create_session(&server, &mut connection, 2, "interactive-session");
    let session_id = session["result"]["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let thread = create_thread(
        &server,
        &mut connection,
        3,
        "interactive-thread",
        &session_id,
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":1}
        }),
    );
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"interactive-turn",
                "sessionId":session_id,
                "request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"ask"}]}
            }
        }),
    );
    let turn_id = started["result"]["value"]["turnId"]
        .as_str()
        .unwrap()
        .to_string();
    let protocol_thread_id = ash_protocol::ThreadId::new(&thread_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let (sequence, request_id) = loop {
        let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();
        if let Some(interaction) = snapshot.turns[0].pending_interaction.as_ref() {
            break (snapshot.sequence, interaction.request_id.to_string());
        }
        assert!(
            Instant::now() < deadline,
            "interactive tool did not publish its durable request"
        );
        thread::sleep(Duration::from_millis(2));
    };
    let notifications = server.drain_notifications(&mut connection);
    assert!(
        notifications
            .iter()
            .any(|notification| notification.contains("\"method\":\"agent/request\""))
    );

    let resolved = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"session/request",
            "params":{
                "commandId":"resolve-live-tool-input",
                "sessionId":session_id,
                "request":{
                    "type":"resolveInteraction",
                    "expectedSequence":sequence,
                    "threadId":thread_id,
                    "turnId":turn_id,
                    "requestId":request_id,
                    "response":{"type":"userInput","response":{"answers":{"city":{"value":"Paris"}}}}
                }
            }
        }),
    );
    assert!(resolved["result"]["value"]["sequence"].is_number());
    wait_for_latest_turn(&server, &thread_id, TurnStatus::Completed);
    assert_eq!(resumes.load(Ordering::Relaxed), 0);
    assert_eq!(model.calls.load(Ordering::Relaxed), 2);
    let snapshot = server.threads().read_thread(&protocol_thread_id).unwrap();
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ash_protocol::ThreadItem::ToolResult { text, is_error: false, .. } if text == "Paris"
    )));
}

#[test]
fn expired_interaction_is_cancelled_and_fails_the_turn() {
    let server = server();
    let mut connection = server.connection();
    initialize_with_capabilities(
        &server,
        &mut connection,
        serde_json::json!({
            "agentInteractions":{"version":1,"kinds":["userInput"]}
        }),
    );
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let session_id = ash_protocol::SessionId::new(session_id).unwrap();
    let started = server
        .threads()
        .start_turn(
            &thread_id,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("deadline-turn").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "wait".into(),
                }],
            },
        )
        .unwrap();
    let expires_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 100;
    server
        .threads()
        .request_turn_interaction(
            &thread_id,
            &started.turn_id,
            RequestTurnInteraction {
                request_id: RequestId::new("deadline-input").unwrap(),
                item_id: None,
                request: AgentRequest::UserInput {
                    request: RequestUserInput {
                        questions: Vec::new(),
                    },
                },
                deadline: Some(InteractionDeadline { expires_at_unix_ms }),
            },
        )
        .unwrap();
    let subscribed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}
        }),
    );
    assert!(subscribed["result"]["thread"].is_object());

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let snapshot = server.threads().read_thread(&thread_id).unwrap();
        if snapshot.turns[0].status == TurnStatus::Failed {
            assert!(snapshot.turns[0].pending_interaction.is_none());
            assert_eq!(
                snapshot.turns[0].failure.as_ref().unwrap().code,
                StableTurnErrorCode::InteractionDeadlineElapsed
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "interaction deadline watcher did not close the Turn"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn approval_interaction_resolves_through_the_typed_app_server_contract() {
    let server = server();
    let mut connection = server.connection();
    initialize_with_capabilities(
        &server,
        &mut connection,
        serde_json::json!({
            "agentInteractions":{"version":1,"kinds":["approval"]}
        }),
    );
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let session_id = ash_protocol::SessionId::new(session_id).unwrap();
    let started = server
        .threads()
        .start_turn(
            &thread_id,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("approval-turn").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "approve".into(),
                }],
            },
        )
        .unwrap();
    server
        .threads()
        .request_turn_interaction(
            &thread_id,
            &started.turn_id,
            RequestTurnInteraction {
                request_id: RequestId::new("approval-1").unwrap(),
                item_id: None,
                request: AgentRequest::Approval {
                    request: ActionApprovalRequest {
                        action_digest: "a".repeat(64),
                        policy_revision: "policy-1".into(),
                        capabilities: vec![ActionApprovalCapability {
                            kind: ActionApprovalCapabilityKind::Network,
                            scope: "api.example.com".into(),
                        }],
                        reason: "network requires approval".into(),
                        sandbox_denial: None,
                    },
                },
                deadline: None,
            },
        )
        .unwrap();

    let subscribed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"session/thread/subscribe",
            "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}
        }),
    );
    assert!(subscribed["result"]["thread"].is_object());
    let notifications = server.drain_notifications(&mut connection);
    assert!(
        notifications
            .iter()
            .any(|notification| notification.contains("\"method\":\"agent/request\""))
    );

    let resolved = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"resolve-approval-1",
                "sessionId":session_id,
                "request":{"type":"resolveInteraction","expectedSequence":5,"threadId":thread_id,"turnId":started.turn_id,"requestId":"approval-1","response":{
                    "type":"approval",
                    "response":{"decision":"approveOnce"}
                }}
            }
        }),
    );

    assert_eq!(resolved["result"]["value"]["sequence"], 6);
    let events = server
        .threads()
        .thread_updates_after(&thread_id, 5)
        .unwrap();
    assert!(matches!(
        &events[0].update,
        ash_protocol::ThreadUpdate::Committed {
            event: ash_protocol::ThreadEvent::InteractionResolved {
                response: ash_protocol::AgentResponse::Approval { .. },
                ..
            }
        }
    ));
}

#[test]
fn interaction_response_is_rejected_from_a_capable_non_owner_connection() {
    let server = server();
    let mut owner = server.connection();
    let mut other = server.connection();
    let capabilities = serde_json::json!({
        "agentInteractions":{"version":1,"kinds":["approval"]}
    });
    initialize_with_capabilities(&server, &mut owner, capabilities.clone());
    initialize_with_capabilities(&server, &mut other, capabilities);
    let session = create_session(&server, &mut owner, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut owner, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let thread_id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let session_id = ash_protocol::SessionId::new(session_id).unwrap();
    let started = server
        .threads()
        .start_turn(
            &thread_id,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("approval-turn-owner-check").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "approve".into(),
                }],
            },
        )
        .unwrap();
    server
        .threads()
        .request_turn_interaction(
            &thread_id,
            &started.turn_id,
            RequestTurnInteraction {
                request_id: RequestId::new("approval-owner-check").unwrap(),
                item_id: None,
                request: AgentRequest::Approval {
                    request: ActionApprovalRequest {
                        action_digest: "b".repeat(64),
                        policy_revision: "policy-1".into(),
                        capabilities: vec![ActionApprovalCapability {
                            kind: ActionApprovalCapabilityKind::Network,
                            scope: "api.example.com".into(),
                        }],
                        reason: "network requires approval".into(),
                        sandbox_denial: None,
                    },
                },
                deadline: None,
            },
        )
        .unwrap();

    for connection in [&mut owner, &mut other] {
        let subscribed = call(
            &server,
            connection,
            serde_json::json!({
                "jsonrpc":"2.0",
                "id":4,
                "method":"session/thread/subscribe",
                "params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}
            }),
        );
        assert!(subscribed["result"]["thread"].is_object());
    }
    assert!(
        server
            .drain_notifications(&mut owner)
            .iter()
            .any(|notification| notification.contains("\"method\":\"agent/request\""))
    );
    assert!(
        !server
            .drain_notifications(&mut other)
            .iter()
            .any(|notification| notification.contains("\"method\":\"agent/request\""))
    );

    let rejected = call(
        &server,
        &mut other,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"session/request",
            "params":{
                "commandId":"resolve-approval-from-other",
                "sessionId":session_id,
                "request":{"type":"resolveInteraction","expectedSequence":5,"threadId":thread_id,"turnId":started.turn_id,"requestId":"approval-owner-check","response":{
                    "type":"approval",
                    "response":{"decision":"approveOnce"}
                }}
            }
        }),
    );

    assert_eq!(rejected["error"]["message"], "AgentInteractionNotOwner");
    assert!(
        server.threads().read_thread(&thread_id).unwrap().turns[0]
            .pending_interaction
            .is_some()
    );
}

#[test]
fn jsonl_transport_writes_response_before_causal_updates() {
    let server = server();
    let input = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"},\"capabilities\":{}}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/create\",\"params\":{\"commandId\":\"session\",\"title\":\"task\"}}\n"
    );
    let mut output = Vec::new();
    server
        .serve_jsonl(Cursor::new(input.as_bytes()), &mut output)
        .unwrap();
    let lines = String::from_utf8(output).unwrap();
    assert_eq!(lines.lines().count(), 2);
    assert!(lines.lines().all(|line| line.contains("\"id\":")));
}

#[test]
fn only_product_host_jsonl_transport_accepts_host_capabilities() {
    let server = server();
    let input = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"},\"capabilities\":{\"dirPermissionsHost\":{\"version\":1}}}}\n",
    );

    let mut client_output = Vec::new();
    server
        .serve_jsonl(Cursor::new(input.as_bytes()), &mut client_output)
        .unwrap();
    let client_response: serde_json::Value =
        serde_json::from_slice(client_output.trim_ascii_end()).unwrap();
    assert_eq!(client_response["error"]["message"], "PermissionRequired");

    let mut host_output = Vec::new();
    server
        .serve_product_host_jsonl(Cursor::new(input.as_bytes()), &mut host_output)
        .unwrap();
    let host_response: serde_json::Value =
        serde_json::from_slice(host_output.trim_ascii_end()).unwrap();
    assert!(host_response["result"].is_object());
}

#[test]
fn jsonl_transport_writes_notifications_without_another_request() {
    let server = Arc::new(server());
    let (mut client, host) = UnixStream::pair().unwrap();
    let output = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
    let served = Arc::clone(&server);
    let captured = Arc::clone(&output);
    let server_thread = thread::spawn(move || {
        served.serve_jsonl(
            std::io::BufReader::new(host),
            CapturingWriter { output: captured },
        )
    });

    client
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"},\"capabilities\":{}}}\n",
        )
        .unwrap();
    wait_for_captured(&output, "\"id\":1");
    server.publish_fs_changed_for_test(
        ash_app_server_protocol::protocol::fs::FsChanged::PathsChanged {
            dir_id: None,
            paths: vec![std::path::PathBuf::from("src/lib.rs")],
        },
    );

    wait_for_captured(&output, "\"method\":\"fs/changed\"");
    client.shutdown(Shutdown::Write).unwrap();
    server_thread.join().unwrap().unwrap();
}

#[test]
fn slow_connection_writer_does_not_block_another_connection() {
    let server = Arc::new(server());
    let input = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"slow\",\"version\":\"1\"},\"capabilities\":{}}}\n",
    );
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let served = Arc::clone(&server);
    let slow = thread::spawn(move || {
        served.serve_jsonl(
            Cursor::new(input.as_bytes()),
            BlockingWriter {
                started: Some(started_tx),
                release: release_rx,
                released: false,
            },
        )
    });
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    let mut fast_connection = server.connection();
    initialize(&server, &mut fast_connection);

    release_tx.send(()).unwrap();
    slow.join().unwrap().unwrap();
    server.close_connection(fast_connection);
}

#[test]
fn account_rpc_projects_login_completion_without_credentials() {
    let driver = Arc::new(TestLoginDriver::default());
    let login = Arc::new(LoginService::new(driver.clone()).unwrap());
    let server = server().with_login_service(Arc::clone(&login));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let initial = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}),
    );
    assert_eq!(initial["result"]["accounts"], serde_json::json!([]));
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"account/login/start",
            "params":{"method":{"type":"openAiChatGptBrowser"}}
        }),
    );
    let login_id = LoginId::new(started["result"]["loginId"].as_str().unwrap()).unwrap();
    login
        .complete(CompleteLogin {
            login_id,
            outcome: LoginCompletionOutcome::Succeeded {
                account: AccountSnapshot {
                    account: AccountRef {
                        provider: "chatgpt-subscription".into(),
                        account_id: "acct_redacted".into(),
                    },
                    email: Some("person@example.test".into()),
                    display_name: None,
                    organization: None,
                    plan: Some("plus".into()),
                    status: AccountStatus::Ready,
                    credential_revision: u64::MAX,
                },
            },
        })
        .unwrap();

    let notifications = server.drain_notifications(&mut connection);
    assert!(notifications.iter().any(|value| {
        value.contains("\"method\":\"account/login/completed\"")
            && value.contains("\"accountId\":\"acct_redacted\"")
    }));
    assert!(
        notifications
            .iter()
            .any(|value| value.contains("\"method\":\"account/updated\""))
    );
    assert!(notifications.iter().all(|value| {
        !value.contains("accessToken")
            && !value.contains("refreshToken")
            && !value.contains("apiKey")
    }));

    *driver.account.lock().unwrap() = login.read().unwrap().accounts.first().cloned();
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"account/read","params":{}}),
    );
    assert_eq!(read["result"]["accounts"][0]["plan"], "plus");
    assert_eq!(read["result"]["revision"], "1");
    assert_eq!(
        read["result"]["accounts"][0]["credentialRevision"],
        u64::MAX.to_string()
    );
    *driver.account.lock().unwrap() = None;
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"account/read","params":{}}),
    );
    assert_eq!(read["result"]["accounts"], serde_json::json!([]));
}

#[test]
fn filesystem_rpc_lists_and_describes_paths() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-files-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/lib.rs"), "hello").unwrap();
    std::fs::write(root.join("paper.pdf"), b"%PDF-1.7\n").unwrap();
    let server = server().with_file_system(Arc::new(LocalFileSystem::new(
        ash_file_access::Grant::for_environment(
            Dir::open_local(&root).unwrap(),
            ash_file_access::GrantSource::ExplicitUser,
            ash_file_access::Permissions::new([
                ash_file_access::Permission::ReadFiles,
                ash_file_access::Permission::WriteFiles,
                ash_file_access::Permission::BrowseFiles,
            ]),
        ),
    )));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let listed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"fs/readDirectory",
            "params":{"path":"src"}
        }),
    );
    let metadata = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"fs/getMetadata",
            "params":{"path":"src/lib.rs"}
        }),
    );
    let contents = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"fs/readFile",
            "params":{"path":"src/lib.rs"}
        }),
    );
    let written = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"fs/writeFile",
            "params":{"path":"src/lib.rs","content":"updated","expectedRevision":contents["result"]["revision"]}
        }),
    );
    let created = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"fs/writeFile",
            "params":{"path":"src/new.rs","content":"new"}
        }),
    );
    let stale = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":7,
            "method":"fs/writeFile",
            "params":{"path":"src/lib.rs","content":"stale","expectedRevision":contents["result"]["revision"]}
        }),
    );
    let binary = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":8,
            "method":"fs/readBinaryFile",
            "params":{"path":"paper.pdf"}
        }),
    );
    let binary_data = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":9,
            "method":"resource/read",
            "params":{"resourceId":binary["result"]["resource"]["resourceId"],"offset":0,"maxBytes":262144}
        }),
    );

    assert_eq!(
        listed["result"]["entries"],
        serde_json::json!([{"name":"lib.rs","fileType":"file"}]),
    );
    assert_eq!(metadata["result"]["fileType"], "file");
    assert_eq!(metadata["result"]["sizeBytes"], 5);
    assert_eq!(contents["result"]["content"], "hello");
    assert!(contents["result"]["revision"].is_string());
    assert_eq!(written["result"]["metadata"]["sizeBytes"], 7);
    assert!(written["result"]["revision"].is_string());
    assert_eq!(created["result"]["metadata"]["sizeBytes"], 3);
    assert_eq!(stale["error"]["code"], -32042);
    assert_eq!(stale["error"]["message"], "FileSystemRevisionConflict");
    assert_eq!(
        binary["result"]["resource"]["mimeType"],
        "application/octet-stream"
    );
    assert_eq!(binary["result"]["resource"]["size"], 9);
    assert!(binary["result"]["revision"].is_string());
    assert_eq!(binary_data["result"]["dataBase64"], "JVBERi0xLjcK");
    assert_eq!(binary_data["result"]["decodedLength"], 9);
    assert_eq!(binary_data["result"]["eof"], true);
    assert_eq!(
        std::fs::read_to_string(root.join("src/lib.rs")).unwrap(),
        "updated"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("src/new.rs")).unwrap(),
        "new"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn filesystem_watcher_publishes_only_dir_relative_paths() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-files-watch-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let dir = Dir::open_local(&root).unwrap();
    let server = server()
        .with_file_system(Arc::new(LocalFileSystem::new(
            ash_file_access::Grant::for_environment(
                dir.clone(),
                ash_file_access::GrantSource::ExplicitUser,
                ash_file_access::Permissions::new([
                    ash_file_access::Permission::ReadFiles,
                    ash_file_access::Permission::WriteFiles,
                    ash_file_access::Permission::BrowseFiles,
                ]),
            ),
        )))
        .with_file_system_watcher(dir)
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let mut observed = None;
    for attempt in 0..60 {
        std::fs::write(root.join("changed.txt"), format!("external {attempt}\n")).unwrap();
        thread::sleep(Duration::from_millis(50));
        for raw in server.drain_notifications(&mut connection) {
            let notification: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if notification["method"] == "fs/changed" {
                observed = Some(notification);
                break;
            }
        }
        if observed.is_some() {
            break;
        }
    }

    let observed = observed.expect("filesystem watcher should publish an invalidation hint");
    assert_eq!(observed["params"]["type"], "pathsChanged");
    let paths = observed["params"]["paths"].as_array().unwrap();
    assert!(paths.iter().any(|path| path == "changed.txt"));
    assert!(
        paths
            .iter()
            .all(|path| path.as_str().is_some_and(|path| !path.starts_with('/')))
    );
    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn git_status_rpc_returns_dir_repository_state() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-git-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let dir = root.join("dir");
    std::fs::create_dir_all(&dir).unwrap();
    run_git(&root, &["init"]);
    run_git(&root, &["config", "user.name", "Ash Test"]);
    run_git(&root, &["config", "user.email", "ash@example.test"]);
    std::fs::write(dir.join("tracked.txt"), "first\n").unwrap();
    std::fs::write(root.join("outside.txt"), "outside\n").unwrap();
    run_git(&root, &["add", "dir/tracked.txt", "outside.txt"]);
    run_git(&root, &["commit", "-m", "initial"]);
    std::fs::write(dir.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    std::fs::write(root.join("outside.txt"), "outside changed\n").unwrap();

    let server = server()
        .with_git_root(dir_authorization(&dir, DirPermission::MutateRepository))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let repositories = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"git/repositories",
            "params":{}
        }),
    );
    let repository_id = repositories["result"]["repositories"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(repositories["result"]["repositories"][0]["path"], "");
    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"git/status",
            "params":{"repositoryId":repository_id}
        }),
    );
    assert_eq!(response["result"]["repositoryId"], repository_id);
    assert_eq!(response["result"]["head"]["type"], "branch");
    assert_eq!(response["result"]["changes"].as_array().unwrap().len(), 2);
    assert!(
        response["result"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| {
                change["path"] == "tracked.txt" && change["worktreeStatus"] == "modified"
            })
    );
    assert!(
        response["result"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| {
                change["path"] == "new.txt" && change["worktreeStatus"] == "untracked"
            })
    );

    let staged = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"git/stage",
            "params":{"repositoryId":repository_id,"paths":["new.txt"]}
        }),
    );
    assert!(
        staged["result"]["status"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| { change["path"] == "new.txt" && change["indexStatus"] == "added" })
    );
    let unstaged = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"git/unstage",
            "params":{"repositoryId":repository_id,"paths":["new.txt"]}
        }),
    );
    assert!(
        unstaged["result"]["status"]["changes"].is_array(),
        "unexpected unstage response: {unstaged}"
    );
    assert!(
        unstaged["result"]["status"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| {
                change["path"] == "new.txt" && change["worktreeStatus"] == "untracked"
            })
    );
    let invalid = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"git/stage",
            "params":{"repositoryId":repository_id,"paths":["../outside.txt"]}
        }),
    );
    assert_eq!(invalid["error"]["message"], "InvalidParams");
    let _ = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":7,
            "method":"git/stage",
            "params":{"repositoryId":repository_id,"paths":["new.txt"]}
        }),
    );
    let committed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":8,
            "method":"git/commit",
            "params":{"repositoryId":repository_id,"message":"add dir file"}
        }),
    );
    assert!(!committed["result"]["objectId"].as_str().unwrap().is_empty());
    let discarded = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":9,
            "method":"git/discardWorktree",
            "params":{"repositoryId":repository_id,"paths":["tracked.txt"]}
        }),
    );
    assert!(
        discarded["result"]["status"]["changes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn restricted_dir_exposes_git_status_but_rejects_mutations() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-restricted-git-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    run_git(&root, &["init", "--initial-branch=main"]);
    run_git(&root, &["config", "user.name", "Ash Test"]);
    run_git(&root, &["config", "user.email", "ash@example.test"]);
    std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    run_git(&root, &["add", "tracked.txt"]);
    run_git(&root, &["commit", "-m", "initial"]);
    std::fs::write(root.join("tracked.txt"), "changed\n").unwrap();

    let server = server()
        .with_local_env_host(None, crate::server::DirGrantPolicy::InspectOnly)
        .unwrap();
    assert_eq!(
        server.switch_local_dir_root(root.clone()),
        Ok(dunce::canonicalize(&root).unwrap())
    );
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"initialize",
            "params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}
        }),
    );
    assert_eq!(initialized["result"]["capabilities"]["git"], true);

    let status = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"git/status","params":{}}),
    );
    assert_eq!(status["result"]["changes"].as_array().unwrap().len(), 1);
    assert_eq!(status["result"]["changes"][0]["path"], "tracked.txt");

    let staged = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"git/stage",
            "params":{"paths":["tracked.txt"]}
        }),
    );
    assert_eq!(staged["error"]["message"], "GitUnavailable");

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn git_remote_rpcs_fetch_pull_and_push_against_a_local_bare_remote() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-git-remote-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    run_git(
        &root,
        &["init", "--bare", "--initial-branch=main", "origin.git"],
    );
    run_git(&root, &["clone", "origin.git", "dir"]);
    let dir = root.join("dir");
    run_git(&dir, &["config", "user.name", "Ash Test"]);
    run_git(&dir, &["config", "user.email", "ash@example.test"]);
    run_git(&dir, &["config", "core.autocrlf", "false"]);
    std::fs::write(dir.join("shared.txt"), "initial\n").unwrap();
    run_git(&dir, &["add", "shared.txt"]);
    run_git(&dir, &["commit", "-m", "initial"]);
    run_git(&dir, &["push", "--set-upstream", "origin", "main"]);
    run_git(&root, &["clone", "origin.git", "peer"]);
    let peer = root.join("peer");
    run_git(&peer, &["config", "user.name", "Ash Test"]);
    run_git(&peer, &["config", "user.email", "ash@example.test"]);
    run_git(&peer, &["config", "core.autocrlf", "false"]);

    let server = server()
        .with_git_root(dir_authorization(&dir, DirPermission::MutateRepository))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    std::fs::write(peer.join("shared.txt"), "from peer\n").unwrap();
    run_git(&peer, &["add", "shared.txt"]);
    run_git(&peer, &["commit", "-m", "peer update"]);
    run_git(&peer, &["push"]);

    let fetched = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"git/fetch","params":{"mode":"default"}}),
    );
    assert!(fetched.get("error").is_none(), "{fetched}");
    let pulled = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"git/pull","params":{}}),
    );
    assert!(pulled.get("error").is_none(), "{pulled}");
    assert_eq!(
        std::fs::read_to_string(dir.join("shared.txt")).unwrap(),
        "from peer\n"
    );

    std::fs::write(dir.join("local.txt"), "from app server\n").unwrap();
    let staged = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"git/stage",
            "params":{"paths":["local.txt"]}
        }),
    );
    assert!(staged.get("error").is_none(), "{staged}");
    let committed = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"git/commit",
            "params":{"message":"app server update"}
        }),
    );
    assert!(committed.get("error").is_none(), "{committed}");
    let pushed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"git/push","params":{}}),
    );
    assert!(pushed.get("error").is_none(), "{pushed}");
    run_git(&peer, &["pull", "--ff-only"]);
    assert_eq!(
        std::fs::read_to_string(peer.join("local.txt")).unwrap(),
        "from app server\n"
    );
    run_git(
        &dir,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/example/ash.git",
        ],
    );
    let graph = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":7,"method":"git/graph","params":{"limit":50}}),
    );
    assert!(graph.get("error").is_none(), "{graph}");
    assert!(
        graph["result"]["references"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| {
                reference["name"] == "origin/main"
                    && reference["kind"] == "remoteBranch"
                    && reference["remoteName"] == "origin"
            })
    );
    assert_eq!(graph["result"]["remotes"][0]["name"], "origin");
    assert_eq!(
        graph["result"]["remotes"][0]["identity"]["provider"],
        "github"
    );
    let graph_page = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":8,"method":"git/graph","params":{"limit":1}}),
    );
    assert!(graph_page.get("error").is_none(), "{graph_page}");
    assert_eq!(graph_page["result"]["commits"].as_array().unwrap().len(), 1);
    assert_eq!(graph_page["result"]["hasMore"], true);
    let cursor = graph_page["result"]["nextCursor"]
        .as_str()
        .expect("graph continuation cursor");
    let graph_tail = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":9,"method":"git/graph","params":{"limit":50,"cursor":cursor}}),
    );
    assert!(graph_tail.get("error").is_none(), "{graph_tail}");
    assert_eq!(graph_tail["result"]["hasMore"], false);
    assert!(graph_tail["result"]["nextCursor"].is_null());

    let committed_object_id = committed["result"]["objectId"]
        .as_str()
        .expect("committed object id");
    let commit_changes = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":10,
            "method":"git/commitChanges",
            "params":{"objectId":committed_object_id}
        }),
    );
    assert!(commit_changes.get("error").is_none(), "{commit_changes}");
    assert!(commit_changes["result"]["parentObjectId"].is_string());
    assert!(
        commit_changes["result"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["path"] == "local.txt" && change["status"] == "added")
    );
    let commit_file = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":11,
            "method":"git/commitFile",
            "params":{"objectId":committed_object_id,"path":"local.txt"}
        }),
    );
    assert!(commit_file.get("error").is_none(), "{commit_file}");
    assert_eq!(commit_file["result"]["original"]["kind"], "missing");
    assert_eq!(commit_file["result"]["modified"]["kind"], "text");
    assert_eq!(
        commit_file["result"]["modified"]["text"],
        "from app server\n"
    );

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn git_change_file_rpc_preserves_head_index_and_worktree_sides() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-git-change-file-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    run_git(&root, &["init"]);
    run_git(&root, &["config", "user.name", "Ash Test"]);
    run_git(&root, &["config", "user.email", "ash@example.test"]);
    std::fs::write(root.join("tracked.txt"), "from head\n").unwrap();
    run_git(&root, &["add", "tracked.txt"]);
    run_git(&root, &["commit", "-m", "initial"]);
    std::fs::write(root.join("tracked.txt"), "from index\n").unwrap();
    run_git(&root, &["add", "tracked.txt"]);
    std::fs::write(root.join("tracked.txt"), "from working tree\n").unwrap();

    let server = server()
        .with_git_root(dir_authorization(&root, DirPermission::InspectRepository))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let staged = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"git/changeFile",
            "params":{"path":"tracked.txt","comparison":"staged"}
        }),
    );
    assert!(staged.get("error").is_none(), "{staged}");
    assert_eq!(staged["result"]["original"]["text"], "from head\n");
    assert_eq!(staged["result"]["modified"]["text"], "from index\n");

    let unstaged = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"git/changeFile",
            "params":{"path":"tracked.txt","comparison":"unstaged"}
        }),
    );
    assert!(unstaged.get("error").is_none(), "{unstaged}");
    assert_eq!(unstaged["result"]["original"]["text"], "from index\n");
    assert_eq!(
        unstaged["result"]["modified"]["text"],
        "from working tree\n"
    );

    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn git_watcher_publishes_external_repository_changes() {
    let root = std::env::temp_dir().join(format!(
        "ash-app-server-git-watch-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    run_git(&root, &["init"]);
    run_git(&root, &["config", "user.name", "Ash Test"]);
    run_git(&root, &["config", "user.email", "ash@example.test"]);
    std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    run_git(&root, &["add", "tracked.txt"]);
    run_git(&root, &["commit", "-m", "initial"]);
    let server = server()
        .with_git_root(dir_authorization(&root, DirPermission::MutateRepository))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let initial = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"git/status",
            "params":{}
        }),
    );
    let initial_revision = initial["result"]["revision"].as_u64().unwrap();
    server.drain_notifications(&mut connection);

    let mut observed = None;
    for attempt in 0..60 {
        std::fs::write(root.join("tracked.txt"), format!("external {attempt}\n")).unwrap();
        thread::sleep(Duration::from_millis(50));
        for raw in server.drain_notifications(&mut connection) {
            let notification: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if notification["method"] == "git/statusChanged"
                && notification["params"]["status"]["revision"]
                    .as_u64()
                    .is_some_and(|revision| revision > initial_revision)
            {
                observed = Some(notification);
                break;
            }
        }
        if observed.is_some() {
            break;
        }
    }

    let observed = observed.expect("Git watcher should publish a changed dir status");
    assert_eq!(
        observed["params"]["status"]["changes"][0]["path"],
        "tracked.txt"
    );
    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}

fn run_git(root: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr),
    );
}

fn dir_authorization(root: &std::path::Path, permission: DirPermission) -> Authorization {
    ash_file_access::Grant::for_environment(
        Dir::open_local(root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([permission]),
    )
    .authorize(permission)
    .unwrap()
}

#[test]
fn custom_provider_order_survives_edits_and_remove_cleans_only_its_secret() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(ConfigStore::open(directory.path().join("config.sqlite3")).unwrap());
    let secrets = Arc::new(MemorySecretStore::default());
    let registry = ash_model_provider_config::ProviderConfigRegistry::builtin();
    let credentials = Arc::new(ash_model_provider::ProviderCredentialService::new(
        registry,
        secrets.clone(),
    ));
    let server = server()
        .with_config_store(store.clone())
        .with_provider_credentials(credentials.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (revision, id, name) in [
        (0, "custom-a", "Zulu"),
        (1, "custom-b", "Alpha"),
        (2, "custom-a", "Renamed"),
    ] {
        let reply = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":revision+2,"method":"provider/configure","params":{"commandId":format!("configure-{revision}"),"expectedRevision":revision,"config":{"provider":id,"baseUrl":"https://example.test/v1","custom":{"name":name,"protocol":"anthropicMessages","order":999}}}}),
        );
        assert!(reply.get("error").is_none(), "{reply}");
    }
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(
        snapshot.values.providers[&ash_protocol::ProviderId::new("custom-a").unwrap()]
            .custom
            .as_ref()
            .unwrap()
            .order,
        1
    );
    assert_eq!(
        snapshot.values.providers[&ash_protocol::ProviderId::new("custom-b").unwrap()]
            .custom
            .as_ref()
            .unwrap()
            .order,
        2
    );
    let configured = credentials
        .with_configs(snapshot.values.providers.values())
        .unwrap();
    let id = ash_protocol::ProviderId::new("custom-a").unwrap();
    configured
        .set_api_key(&id, b"removed-key".to_vec())
        .unwrap();
    let builtin = ash_protocol::ProviderId::new("openai").unwrap();
    configured
        .set_api_key(&builtin, b"keep-key".to_vec())
        .unwrap();
    let denied = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"provider/remove","params":{"commandId":"remove-builtin","expectedRevision":3,"provider":"openai"}}),
    );
    assert!(denied.get("error").is_some());
    let removed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"provider/remove","params":{"commandId":"remove-custom","expectedRevision":3,"provider":"custom-a"}}),
    );
    assert!(removed.get("error").is_none(), "{removed}");
    assert!(
        secrets
            .load(&ash_model_provider::provider_api_key_secret_key(&id))
            .unwrap()
            .is_none()
    );
    assert!(
        secrets
            .load(&ash_model_provider::provider_api_key_secret_key(&builtin))
            .unwrap()
            .is_some()
    );
    assert!(
        !store
            .read_snapshot()
            .unwrap()
            .values
            .providers
            .contains_key(&id)
    );
}

#[test]
fn agent_identity_spans_tasks_forks_and_replacement_through_rpc() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let first = create_session(&server, &mut connection, 2, "identity-first");
    let session_id = first["result"]["session"]["sessionId"].as_str().unwrap();
    let root_id = first["result"]["session"]["threads"][0]["threadId"]
        .as_str()
        .unwrap();
    let root = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":3, "method":"session/thread/read",
            "params":{"sessionId":session_id,"threadId":root_id}
        }),
    );
    let agent_id = root["result"]["thread"]["agentId"].as_str().unwrap();
    let second = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"session/create",
            "params":{"commandId":"identity-second","title":"another task","agentId":agent_id}
        }),
    );
    assert!(second.get("error").is_none(), "{second}");
    assert_ne!(second["result"]["session"]["sessionId"], session_id);
    let fork = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":5, "method":"session/request",
            "params":{"commandId":"identity-fork","sessionId":session_id,"request":{"type":"forkThread","parentThreadId":root_id,"title":"fork"}}
        }),
    );
    assert!(fork.get("error").is_none(), "{fork}");
    let archived = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":6, "method":"session/request",
            "params":{"commandId":"identity-archive","sessionId":session_id,"request":{"type":"archive"}}
        }),
    );
    assert!(archived.get("error").is_none(), "{archived}");
    let replacement_request = serde_json::json!({
        "jsonrpc":"2.0", "id":7, "method":"session/request",
        "params":{"commandId":"identity-replace","sessionId":session_id,"request":{"type":"replaceThread","sourceThreadId":root_id,"title":"replacement"}}
    });
    let replaced = call(&server, &mut connection, replacement_request.clone());
    assert!(replaced.get("error").is_none(), "{replaced}");
    let mut retry = replacement_request;
    retry["id"] = serde_json::json!(10);
    let replayed = call(&server, &mut connection, retry);
    assert!(replayed.get("error").is_none(), "{replayed}");
    assert_eq!(replayed["result"], replaced["result"]);
    let agent = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":8, "method":"agent/read", "params":{"agentId":agent_id}
        }),
    );
    let branches = agent["result"]["threads"].as_array().unwrap();
    assert_eq!(branches.len(), 4);
    assert_eq!(agent["result"]["agentId"], agent_id);
    assert!(
        branches
            .iter()
            .any(|branch| branch["origin"]["type"] == "replacement"
                && branch["origin"]["sourceThreadId"] == root_id)
    );
    let unknown = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":9, "method":"session/create",
            "params":{"commandId":"identity-unknown","title":"unknown","agentId":"missing-agent"}
        }),
    );
    assert!(unknown.get("error").is_some());
}

#[test]
fn message_restore_interrupts_the_source_and_replays_without_interrupting_later_work() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = create_session(&server, &mut connection, 2, "restore-session");
    let session = created["result"]["session"]["sessionId"].as_str().unwrap();
    let source = ash_protocol::ThreadId::new(session).unwrap();
    let start = |command: &str| {
        server
            .threads()
            .start_turn(
                &source,
                StartTurnRequest {
                    advisor: None,
                    command_id: ash_protocol::CommandId::new(command).unwrap(),
                    expected_sequence: core_api::SequenceExpectation::Any,
                    model: None,
                    kind: Default::default(),
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    policy_revision: "test".into(),
                    approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: vec![],
                    input: vec![ash_protocol::UserInput::Text {
                        text: command.into(),
                    }],
                },
            )
            .unwrap()
    };
    let first = start("active");
    let checkpoints = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/thread/checkpoints","params":{"sessionId":session,"threadId":source}}),
    );
    let item = checkpoints["result"]["checkpoints"][0]["itemId"]
        .as_str()
        .unwrap();
    let restore = |id| serde_json::json!({"jsonrpc":"2.0","id":id,"method":"session/request","params":{"sessionId":session,"commandId":"restore-active","request":{"type":"restoreMessage","threadId":source,"itemId":item,"boundary":"after","title":"restored"}}});
    let restored = call(&server, &mut connection, restore(4));
    assert!(restored.get("error").is_none(), "{restored}");
    let current = server.threads().read_thread(&source).unwrap();
    assert_eq!(current.turns[0].turn_id, first.turn_id);
    assert_eq!(current.turns[0].status, TurnStatus::Interrupted);
    let branch = server
        .threads()
        .read_thread(
            &ash_protocol::ThreadId::new(restored["result"]["value"]["threadId"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
    assert_eq!(branch.agent_id, current.agent_id);
    assert_eq!(branch.items, current.items);
    assert_eq!(branch.turns[0].status, TurnStatus::Interrupted);
    let later = start("later work");
    let replay = call(&server, &mut connection, restore(5));
    assert!(replay.get("error").is_none(), "{replay}");
    assert_eq!(
        replay["result"]["value"]["threadId"],
        restored["result"]["value"]["threadId"]
    );
    assert!(
        server
            .threads()
            .read_thread(&source)
            .unwrap()
            .turns
            .iter()
            .any(|turn| turn.turn_id == later.turn_id && turn.status != TurnStatus::Interrupted)
    );
}

#[test]
fn filesystem_rpc_enforces_file_permissions_and_revocation() {
    for permission in [
        ash_file_access::Permission::ReadFiles,
        ash_file_access::Permission::BrowseFiles,
        ash_file_access::Permission::WriteFiles,
    ] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file"), "old").unwrap();
        let grant = ash_file_access::Grant::for_environment(
            Dir::open_local(root.path()).unwrap(),
            ash_file_access::GrantSource::ExplicitUser,
            ash_file_access::Permissions::new([permission]),
        );
        let server = server().with_file_system(Arc::new(ash_file_system::LocalFileSystem::new(
            grant.clone(),
        )));
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        for (index, method, params, required) in [
            (
                2,
                "fs/readFile",
                serde_json::json!({"path":"file"}),
                ash_file_access::Permission::ReadFiles,
            ),
            (
                3,
                "fs/readDirectory",
                serde_json::json!({"path":""}),
                ash_file_access::Permission::BrowseFiles,
            ),
            (
                4,
                "fs/writeFile",
                serde_json::json!({"path":"file", "content":"new"}),
                ash_file_access::Permission::WriteFiles,
            ),
        ] {
            let response = call(
                &server,
                &mut connection,
                serde_json::json!({"jsonrpc":"2.0", "id":index, "method":method, "params":params}),
            );
            assert_eq!(
                response.get("error").is_none(),
                permission == required,
                "{method}: {response}"
            );
        }
        grant.revoke();
        let response = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0", "id":5, "method":"fs/readFile", "params":{"path":"file"}}),
        );
        assert!(response.get("error").is_some());
    }
}

#[test]
fn instruction_list_and_explicit_attachment_use_current_authorized_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("instructions")).unwrap();
    let path = root.path().join("instructions/review.md");
    std::fs::write(&path, "---\nname: review\ndescription: API review\nload: on-demand\n---\nCheck public API compatibility.").unwrap();
    std::fs::write(
        root.path().join("instructions/bad.md"),
        "---\nload: unknown\n---\nBad rule",
    )
    .unwrap();
    let model = Arc::new(RecordingModel::default());
    let server = server_with_model(model.clone()).with_home(Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(root.path()).unwrap(),
    )));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "instruction-list-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let listed = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"instructions/list","params":{"sessionId":session_id}}),
    );
    assert_eq!(
        listed["result"]["instructions"][0]["path"],
        path.display().to_string()
    );
    assert_eq!(listed["result"]["instructions"][0]["load"], "onDemand");
    assert_eq!(listed["result"]["diagnostics"].as_array().unwrap().len(), 1);
    assert_eq!(
        listed["result"]["diagnostics"][0]["path"],
        root.path()
            .join("instructions/bad.md")
            .display()
            .to_string()
    );
    assert!(
        !listed
            .to_string()
            .contains("Check public API compatibility.")
    );
    let thread = create_thread(
        &server,
        &mut connection,
        4,
        "instruction-list-thread",
        session_id,
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let started = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"session/request","params":{"commandId":"attach-instruction","sessionId":session_id,"request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"instruction","path":path},{"type":"text","text":"Review this API"}]}}}),
    );
    assert!(
        started["result"]["value"]["turnId"].is_string(),
        "{started}"
    );
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
    assert!(model.requests.lock().unwrap()[0].input.iter().any(|item| matches!(item, InputItem::Message(message) if message.content.iter().any(|part| matches!(part, ContentPart::Text(text) if text.contains("Check public API compatibility."))))));
    {
        let requests = model.requests.lock().unwrap();
        let request = &requests[0];
        let product = request.instructions.as_deref().unwrap();
        assert!(product.contains("current user's explicit request takes precedence"));
        assert!(!product.contains("Check public API compatibility."));
        let text = serde_json::to_string(&request.input).unwrap();
        assert!(text.contains("activation="));
        assert!(text.contains("revision="));
        assert!(text.contains("scope="));
    }
    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":6,"method":"session/request",
            "params":{"commandId":"outside-instruction","sessionId":session_id,"request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"instruction","path":root.path().join("private.md")},{"type":"text","text":"Review"}]}}
        }),
    );
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
    std::fs::remove_file(&path).unwrap();
    let rejected = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":7,"method":"session/request",
            "params":{"commandId":"deleted-instruction","sessionId":session_id,"request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"instruction","path":path},{"type":"text","text":"Review"}]}}
        }),
    );
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
}

#[path = "execution_environment_tests.rs"]
mod execution_environment_tests;

#[test]
fn advisor_requests_are_typed_retry_safe_and_separate_from_worker_turns() {
    let backend = Arc::new(CountingStartBackend::default());
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    let provider = ProviderId::new("openai").unwrap();
    let configured = config
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("configure-advisor-provider").unwrap(),
            expected_revision: ash_config::ConfigRevision::new(0),
            command: ash_config::UserConfigCommand::ConfigureProvider {
                provider: provider.clone(),
                config: ash_model_provider_config::ModelProviderConfig::new(provider.clone()),
            },
        })
        .unwrap();
    let default_selected = config
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("set-advisor-default").unwrap(),
            expected_revision: configured.revision,
            command: ash_config::UserConfigCommand::UpdatePreferences(
                ash_config::PreferencesUpdate {
                    advisor: ash_protocol::Patch::Value(ash_protocol::AdvisorConfig::new(
                        ModelRef::new(provider, ModelId::new("reviewer").unwrap()),
                    )),
                    ..Default::default()
                },
            ),
        })
        .unwrap();
    let server = server()
        .with_config_store(config.clone())
        .with_turn_backend(backend.clone());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "advisor-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "advisor-thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let request = |id: u64, command: &str, body: serde_json::Value| serde_json::json!({"jsonrpc":"2.0","id":id,"method":"session/request","params":{"commandId":command,"sessionId":session_id,"request":body}});
    let mut off = request(
        4,
        "off",
        serde_json::json!({"type":"configureAdvisor","threadId":thread_id,"expectedSequence":1,"selection":{"type":"off"}}),
    );
    let changed = call(&server, &mut connection, off.clone());
    assert_eq!(changed["result"]["type"], "advisorConfigured");
    off["id"] = serde_json::json!(5);
    let retry = call(&server, &mut connection, off);
    assert_eq!(
        retry["result"], changed["result"],
        "configuration retry must return the original receipt: {retry}"
    );
    let id = ash_protocol::ThreadId::new(thread_id).unwrap();
    let sequence = server
        .threads()
        .configure_advisor(
            &id,
            ash_protocol::CommandId::new("select").unwrap(),
            core_api::SequenceExpectation::Any,
            ash_protocol::AdvisorSelection::Model {
                config: ash_protocol::AdvisorConfig::new(ash_protocol::ModelRef {
                    provider: ash_protocol::ProviderId::new("test").unwrap(),
                    model: ash_protocol::ModelId::new("advisor").unwrap(),
                }),
            },
        )
        .unwrap();
    let replayed = call(
        &server,
        &mut connection,
        request(
            6,
            "select",
            serde_json::json!({
                "type":"configureAdvisor", "threadId":thread_id, "expectedSequence":1,
                "selection":{"type":"model", "config":{"model":{"provider":"test", "model":"advisor"}}}
            }),
        ),
    );
    assert_eq!(
        replayed["result"]["value"]["sequence"], sequence,
        "retry must use its receipt even if the model is no longer in the catalog: {replayed}"
    );
    let off_sequence = server
        .threads()
        .configure_advisor(
            &id,
            CommandId::new("legacy-off").unwrap(),
            core_api::SequenceExpectation::Any,
            ash_protocol::AdvisorSelection::Off,
        )
        .unwrap();
    let mut disabled = ash_protocol::AdvisorConfig::new(ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("reviewer").unwrap(),
    ));
    disabled.enabled = false;
    let disabled_result = config
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("disable-advisor-default").unwrap(),
            expected_revision: default_selected.revision,
            command: ash_config::UserConfigCommand::UpdatePreferences(
                ash_config::PreferencesUpdate {
                    advisor: ash_protocol::Patch::Value(disabled.clone()),
                    ..Default::default()
                },
            ),
        })
        .unwrap();
    let rejected = call(
        &server,
        &mut connection,
        request(
            70,
            "disabled-ask",
            serde_json::json!({"type":"consultAdvisor","threadId":thread_id,"expectedSequence":off_sequence,"question":"Check cancellation"}),
        ),
    );
    assert_eq!(
        rejected["error"]["data"]["kind"], "AdvisorDisabled",
        "{rejected}"
    );
    let explicit_session = create_session(&server, &mut connection, 71, "disabled-session");
    let explicit_session_id = explicit_session["result"]["session"]["sessionId"]
        .as_str()
        .unwrap();
    let explicit = create_thread(
        &server,
        &mut connection,
        72,
        "disabled-thread",
        explicit_session_id,
        1,
    );
    let explicit_id = explicit["result"]["value"]["threadId"].as_str().unwrap();
    let explicit_thread_id = ash_protocol::ThreadId::new(explicit_id).unwrap();
    let explicit_sequence = server
        .threads()
        .configure_advisor(
            &explicit_thread_id,
            CommandId::new("explicit-advisor").unwrap(),
            core_api::SequenceExpectation::Any,
            ash_protocol::AdvisorSelection::Model {
                config: ash_protocol::AdvisorConfig::new(ModelRef::new(
                    ProviderId::new("openai").unwrap(),
                    ModelId::new("reviewer").unwrap(),
                )),
            },
        )
        .unwrap();
    let ordinary = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":73,"method":"session/request",
            "params":{"commandId":"disabled-ordinary","sessionId":explicit_session_id,"request":{
                "type":"startTurn","threadId":explicit_id,"expectedSequence":explicit_sequence,
                "input":[{"type":"text","text":"Review this"}]
            }}
        }),
    );
    assert_eq!(ordinary["result"]["type"], "turn", "{ordinary}");
    let ordinary_thread = server.threads().read_thread(&explicit_thread_id).unwrap();
    assert!(ordinary_thread.turns[0].advisor.is_none());
    config
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("reenable-advisor-default").unwrap(),
            expected_revision: disabled_result.revision,
            command: ash_config::UserConfigCommand::UpdatePreferences(
                ash_config::PreferencesUpdate {
                    advisor: ash_protocol::Patch::Value(ash_protocol::AdvisorConfig {
                        enabled: true,
                        ..disabled
                    }),
                    ..Default::default()
                },
            ),
        })
        .unwrap();
    let mut ask = request(
        7,
        "ask",
        serde_json::json!({"type":"consultAdvisor","threadId":thread_id,"expectedSequence":off_sequence,"question":"Check cancellation"}),
    );
    let accepted = call(&server, &mut connection, ask.clone());
    assert_eq!(accepted["result"]["type"], "turn", "{accepted}");
    ask["id"] = serde_json::json!(8);
    assert_eq!(
        call(&server, &mut connection, ask)["result"],
        accepted["result"]
    );
    assert_eq!(backend.starts.load(Ordering::Relaxed), 2);
    let state = server.threads().read_thread(&id).unwrap();
    assert_eq!(state.turns[0].kind, ash_protocol::TurnKind::Advisor);
    assert_eq!(
        state.turns[0]
            .advisor
            .as_ref()
            .unwrap()
            .model
            .model
            .as_str(),
        "reviewer"
    );
    let conflicting = call(
        &server,
        &mut connection,
        request(
            9,
            "ask",
            serde_json::json!({"type":"startTurn","threadId":thread_id,"expectedSequence":off_sequence,"input":[{"type":"text","text":"Check cancellation"}]}),
        ),
    );
    assert!(conflicting.get("error").is_some());
}

#[test]
fn device_subscription_login_registers_its_provider_once_for_model_selection() {
    struct Driver {
        provider: &'static str,
        method: ash_login::LoginMethod,
    }
    impl InteractiveLoginDriver for Driver {
        fn provider_id(&self) -> &'static str {
            self.provider
        }
        fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
            Ok(None)
        }
        fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
            assert_eq!(request.method, self.method);
            Ok(BeginLogin::DeviceCode {
                login_id: request.login_id,
                verification_url: "https://auth.example.test/device".into(),
                user_code: "SUBSCRIPTION-CODE".into(),
            })
        }
        fn cancel(&self, _: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
            Ok(CancelLoginOutcome::Cancelled)
        }
        fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
            Ok(())
        }
    }
    for (provider, method, rpc_method) in [
        (
            "xai-subscription",
            ash_login::LoginMethod::XaiDeviceCode,
            "xaiDeviceCode",
        ),
        (
            "kimi-subscription",
            ash_login::LoginMethod::KimiDeviceCode,
            "kimiDeviceCode",
        ),
    ] {
        let profile = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
        let server = server()
            .with_config_store(config.clone())
            .with_login_service(Arc::new(
                LoginService::new(Arc::new(Driver { provider, method })).unwrap(),
            ));
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        for id in 2..4 {
            let response = call(
                &server,
                &mut connection,
                serde_json::json!({"jsonrpc":"2.0","id":id,"method":"account/login/start","params":{"method":{"type":rpc_method}}}),
            );
            assert_eq!(
                response["result"]["userCode"], "SUBSCRIPTION-CODE",
                "{response}"
            );
            let cancelled = call(
                &server,
                &mut connection,
                serde_json::json!({"jsonrpc":"2.0","id":id+2,"method":"account/login/cancel","params":{"loginId":response["result"]["loginId"]}}),
            );
            assert_eq!(cancelled["result"]["status"], "cancelled");
            let snapshot = config.read_snapshot().unwrap();
            assert_eq!(snapshot.revision.get(), 1);
            assert_eq!(snapshot.values.providers.len(), 1);
            assert!(
                snapshot.values.providers.contains_key(
                    &ProviderId::new(if provider == "xai-subscription" {
                        "xai"
                    } else {
                        "kimi"
                    })
                    .unwrap()
                )
            );
            assert!(snapshot.values.model.is_none());
        }
    }
}

#[test]
fn github_account_login_routes_browser_challenge_without_model_provider_configuration() {
    struct Driver;
    impl InteractiveLoginDriver for Driver {
        fn provider_id(&self) -> &'static str {
            "github"
        }
        fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
            Ok(None)
        }
        fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
            assert_eq!(request.method, ash_login::LoginMethod::GitHubBrowser);
            Ok(BeginLogin::Browser {
                login_id: request.login_id,
                authorization_url: "https://github.com/login/oauth/authorize".into(),
            })
        }
        fn cancel(&self, _: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
            Ok(CancelLoginOutcome::Cancelled)
        }
        fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
            Ok(())
        }
    }

    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    let server = server()
        .with_config_store(config.clone())
        .with_login_service(Arc::new(LoginService::new(Arc::new(Driver)).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"account/login/start",
            "params":{"method":{"type":"gitHubBrowser"}}
        }),
    );
    assert_eq!(
        response["result"]["authorizationUrl"],
        "https://github.com/login/oauth/authorize"
    );
    assert!(config.read_snapshot().unwrap().values.providers.is_empty());
    let cancelled = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"account/login/cancel",
            "params":{"loginId":response["result"]["loginId"]}
        }),
    );
    assert_eq!(cancelled["result"]["status"], "cancelled");
}

#[test]
fn chatgpt_login_registers_subscription_only_after_it_is_ready() {
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    let driver = Arc::new(TestLoginDriver::default());
    let server = server()
        .with_config_store(config.clone())
        .with_login_service(Arc::new(LoginService::new(driver.clone()).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    let started = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"account/login/start","params":{"method":{"type":"openAiChatGptBrowser"}}}),
    );
    assert!(started["result"]["loginId"].is_string(), "{started}");
    let snapshot = config.read_snapshot().unwrap();
    assert_eq!(snapshot.revision.get(), 0);
    assert!(
        !snapshot
            .values
            .providers
            .contains_key(&ProviderId::new("openai").unwrap())
    );
    assert!(snapshot.values.model.is_none());

    let cancelled = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"account/login/cancel","params":{"loginId":started["result"]["loginId"]}}),
    );
    assert_eq!(cancelled["result"]["status"], "cancelled");
    let restarted = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"account/login/start","params":{"method":{"type":"openAiChatGptBrowser"}}}),
    );
    assert!(restarted["result"]["loginId"].is_string(), "{restarted}");
    assert_eq!(config.read_snapshot().unwrap().revision.get(), 0);
    *driver.account.lock().unwrap() = Some(AccountSnapshot {
        account: AccountRef {
            provider: "chatgpt-subscription".into(),
            account_id: "account-1".into(),
        },
        email: None,
        display_name: None,
        organization: None,
        plan: Some("plus".into()),
        status: AccountStatus::Ready,
        credential_revision: 1,
    });
    let read = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"account/read","params":{}}),
    );
    assert_eq!(read["result"]["accounts"][0]["status"], "ready");
    let snapshot = config.read_snapshot().unwrap();
    assert_eq!(snapshot.revision.get(), 1);
    assert!(
        snapshot
            .values
            .providers
            .contains_key(&ProviderId::new("openai").unwrap())
    );
    assert!(snapshot.values.model.is_none());
}

#[test]
fn account_read_registers_subscription_for_an_existing_chatgpt_login() {
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    let driver = Arc::new(TestLoginDriver {
        account: Mutex::new(Some(AccountSnapshot {
            account: AccountRef {
                provider: "chatgpt-subscription".into(),
                account_id: "account-1".into(),
            },
            email: None,
            display_name: None,
            organization: None,
            plan: Some("plus".into()),
            status: AccountStatus::Ready,
            credential_revision: 1,
        })),
    });
    let server = server()
        .with_config_store(config.clone())
        .with_login_service(Arc::new(LoginService::new(driver).unwrap()));
    let mut connection = server.connection();
    initialize(&server, &mut connection);

    for id in 2..4 {
        let read = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":"account/read","params":{}}),
        );
        assert_eq!(read["result"]["accounts"][0]["status"], "ready");
        let snapshot = config.read_snapshot().unwrap();
        assert_eq!(snapshot.revision.get(), 1);
        assert!(
            snapshot
                .values
                .providers
                .contains_key(&ProviderId::new("openai").unwrap())
        );
        assert!(snapshot.values.model.is_none());
    }
}

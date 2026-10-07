use super::*;
use ash_chatgpt::ChatGptAuthManagement;
use ash_client::ClientResponse;
use ash_client::OperationStreamSink;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretValue;
use base64::Engine;
use login::AccountRef;
use login::InteractiveLoginDriver;
use serde_json::json;
use std::sync::Mutex;

struct Transport {
    requests: Mutex<Vec<ClientRequest>>,
    reject: AtomicBool,
}

impl OperationClient for Transport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if self.reject.load(Ordering::SeqCst) {
            return Ok(ClientResponse::new(401, Vec::new(), Vec::new()));
        }
        assert_eq!(request.url(), "https://api.openai.com/v1/models");
        Ok(ClientResponse::new(
            200,
            Vec::new(),
            br#"{"models":[{"slug":"gpt-5.6-luna","display_name":"Luna","visibility":"list"}]}"#
                .to_vec(),
        ))
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if self.reject.load(Ordering::SeqCst) {
            return Ok(ClientResponse::new(401, Vec::new(), Vec::new()));
        }
        let body = json!({"id":"isolated", "status":"completed", "output":[{"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"isolated", "annotations":[]}]}], "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}});
        sink.emit(
            format!(
                "data: {}\n\n",
                json!({"type":"response.completed", "response":body})
            )
            .as_bytes(),
        )?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct Fixture {
    directory: tempfile::TempDir,
    secrets: Arc<MemorySecretStore>,
    transport: Arc<Transport>,
    local: Arc<ChatGptOAuth>,
    plan: Arc<ChatGptPlanOAuth>,
    runtime: ModelProviderRuntime,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        let transport = Arc::new(Transport {
            requests: Mutex::new(Vec::new()),
            reject: AtomicBool::new(false),
        });
        let local = ChatGptOAuth::with_client(
            directory.path().to_owned(),
            secrets.clone(),
            transport.clone(),
            ChatGptAuthManagement::Codex,
        );
        let plan = ChatGptPlanOAuth::with_client(
            secrets.clone(),
            directory.path().join("plan.lock"),
            transport.clone(),
        );
        let runtime = ModelProviderRuntime::with_client_and_secrets(
            ProviderConfigRegistry::builtin(),
            transport.clone(),
            secrets.clone(),
        )
        .with_chatgpt_oauth(local.clone())
        .with_chatgpt_plan(plan.clone());
        Self {
            directory,
            secrets,
            transport,
            local,
            plan,
            runtime,
        }
    }

    fn save_plan(&self, account: &str) {
        self.secrets.store(&plan_key(), &SecretValue::new(serde_json::to_vec(&json!({
            "host_id":"urn:uuid:ash-host", "selection_revision":1, "active":account,
            "accounts":{account:{"client_id":"oaiapp_ash","subject":account,"email":null,"revision":1,
                "tokens":{"access_token":"ash-token","refresh_token":"ash-refresh","id_token":"ash-id", "scopes":["chatgpt.tokens.use.direct","resource.invoke"], "expires_at":4_000_000_000_u64,"earliest_refresh_at":0}}}
        })).unwrap())).unwrap();
    }

    fn save_local(&self, user: &str, expiry: u64) {
        let jwt = |value: serde_json::Value| {
            format!(
                "e30.{}.signature",
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&value).unwrap())
            )
        };
        std::fs::write(self.directory.path().join("auth.json"), serde_json::to_vec(&json!({
            "auth_mode":"chatgpt", "tokens":{"id_token":jwt(json!({"https://api.openai.com/auth":{"chatgpt_user_id":user,"chatgpt_account_id":"workspace"}})), "access_token":jwt(json!({"exp":expiry})),"refresh_token":"codex-refresh","account_id":"workspace"}, "last_refresh":"2026-10-01T00:00:00Z"
        })).unwrap()).unwrap();
    }

    fn preferred(&self) -> String {
        self.runtime
            .preferred_connections(&BTreeMap::new())
            .unwrap()[&ProviderId::new("openai").unwrap()]
            .connection
            .to_string()
    }
}

fn connection_config(connection: &str) -> ModelProviderConfig {
    ModelProviderConfig::for_connection(ash_protocol::ModelConnectionId::new(connection).unwrap())
}

fn plan_key() -> SecretKey {
    SecretKey::new("provider/chatgpt-plan/registrations-v1").unwrap()
}

#[test]
fn automatic_priority_uses_ready_codex_then_ash_then_api_key() {
    let fixture = Fixture::new();
    fixture
        .runtime
        .credentials
        .as_ref()
        .unwrap()
        .set_api_key(
            &ash_protocol::ModelConnectionId::new("openai").unwrap(),
            b"platform-key".to_vec(),
        )
        .unwrap();
    assert_eq!(fixture.preferred(), "openai");
    fixture.save_plan("ash-account");
    assert_eq!(fixture.preferred(), "chatgpt-plan");
    fixture.save_local("codex-user", 4_000_000_000);
    assert_eq!(fixture.preferred(), "chatgpt-subscription");
    fixture.save_local("codex-user", 1);
    assert_eq!(fixture.preferred(), "chatgpt-plan");
    fixture.save_local("codex-user", 4_000_000_000);
    fixture
        .local
        .logout(&AccountRef {
            provider: "chatgpt-subscription".into(),
            account_id: "workspace".into(),
        })
        .unwrap();
    assert_eq!(fixture.preferred(), "chatgpt-plan");
    assert!(fixture.directory.path().join("auth.json").exists());
    fixture.secrets.delete(&plan_key()).unwrap();
    assert_eq!(fixture.preferred(), "openai");
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
}

#[test]
fn unreadable_connection_does_not_block_the_other_login() {
    let fixture = Fixture::new();
    fixture.save_plan("ash-account");
    std::fs::write(
        fixture.directory.path().join("auth.json"),
        b"broken Codex credential",
    )
    .unwrap();
    assert_eq!(fixture.preferred(), "chatgpt-plan");
    fixture.save_local("codex-user", 4_000_000_000);
    fixture
        .secrets
        .store(
            &plan_key(),
            &SecretValue::new(b"broken Ash credential".to_vec()),
        )
        .unwrap();
    assert_eq!(fixture.preferred(), "chatgpt-subscription");
}

#[test]
fn both_connections_reject_a_switch_between_identity_and_token_resolution() {
    let fixture = Fixture::new();
    fixture.save_plan("account-a");
    fixture.save_local("user-a", 4_000_000_000);
    let plan = ProviderTarget::ChatGptPlan(fixture.plan.clone());
    let local = ProviderTarget::ChatGpt(fixture.local.clone());
    let plan_identity = plan.identity().unwrap();
    let local_identity = local.identity().unwrap();
    fixture.save_plan("account-b");
    fixture.save_local("user-b", 4_000_000_000);
    assert!(
        plan.resolve()
            .unwrap()
            .ensure_account(&plan_identity)
            .is_err()
    );
    assert!(
        local
            .resolve()
            .unwrap()
            .ensure_account(&local_identity)
            .is_err()
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
}

#[test]
fn explicit_ash_connection_and_bound_requests_keep_their_destination() {
    let fixture = Fixture::new();
    fixture.save_plan("ash-account");
    let model = fixture
        .runtime
        .build_model(
            &connection_config("chatgpt-plan"),
            &ModelRef::new(
                ProviderId::new("openai").unwrap(),
                ModelId::new("gpt-5.6-luna").unwrap(),
            ),
        )
        .unwrap();
    fixture.save_local("codex-user", 4_000_000_000);
    assert_eq!(fixture.preferred(), "chatgpt-subscription");
    let mut request = ModelRequest::text("hello");
    request.reasoning = Some(ash_protocol::ReasoningConfig {
        effort: ash_protocol::ReasoningEffort::Low,
        summary: false,
    });
    assert_eq!(model.invoke(&request).unwrap().text(), "isolated");
    let requests = fixture.transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url(), "https://api.openai.com/v1/responses");
    assert!(
        requests[0]
            .headers()
            .iter()
            .any(|header| header.name() == "Authorization" && header.value() == "Bearer ash-token")
    );
    assert!(
        !requests[0]
            .headers()
            .iter()
            .any(|header| header.name().eq_ignore_ascii_case("ChatGPT-Account-ID"))
    );
    drop(requests);
    fixture.transport.reject.store(true, Ordering::SeqCst);
    assert!(model.invoke(&request).is_err());
    let requests = fixture.transport.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "401 must not replay against another connection"
    );
    assert!(
        requests
            .iter()
            .all(|request| request.url() == "https://api.openai.com/v1/responses")
    );
}

#[tokio::test]
async fn discovery_scopes_and_credentials_are_isolated_between_connections() {
    let fixture = Fixture::new();
    fixture.save_local("codex-user", 4_000_000_000);
    fixture.save_plan("ash-account");
    let plan = fixture
        .runtime
        .catalog_binding(&connection_config("chatgpt-plan"))
        .unwrap()
        .unwrap();
    let local = fixture
        .runtime
        .catalog_binding(&connection_config("chatgpt-subscription"))
        .unwrap()
        .unwrap();
    assert_ne!(plan.scope(), local.scope());
    fixture
        .runtime
        .models_manager()
        .refresh(plan.scope().clone(), plan.source())
        .await
        .unwrap();
    let requests = fixture.transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url(), "https://api.openai.com/v1/models");
    assert!(
        requests[0]
            .headers()
            .iter()
            .any(|header| header.value() == "Bearer ash-token")
    );
    drop(requests);
    fixture.save_plan("other-registration");
    assert!(
        fixture
            .runtime
            .models_manager()
            .refresh(plan.scope().clone(), plan.source())
            .await
            .is_err()
    );
    assert_eq!(fixture.transport.requests.lock().unwrap().len(), 1);
}

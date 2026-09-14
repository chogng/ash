use super::*;
use crate::model_catalog::ModelCatalog;
use std::sync::mpsc;
use ash_core::InMemoryThreadStore;
use ash_core::ModelSelection;
use ash_protocol::AgentRoleSelection;
use ash_protocol::AgentRoleSource;
use ash_protocol::CommandId;
use ash_protocol::ModelId;
use ash_protocol::ModelInstructionSelection;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ProviderId;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;

struct CaptureModel(mpsc::Sender<ModelRequest>);
impl ModelService for CaptureModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.0.send(request.clone()).unwrap();
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("verified".into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

struct TestModels;
impl ModelCatalog for TestModels {
    fn list(
        &self,
    ) -> Result<Vec<ash_app_server_protocol::protocol::model::ModelCatalogEntry>, CoreError> {
        Ok(Vec::new())
    }
    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
        Ok(Some(model()))
    }
}
fn model() -> ModelRef {
    ModelRef::new(
        ProviderId::new("test").unwrap(),
        ModelId::new("model-v1").unwrap(),
    )
}

struct SkillConfig;
impl SkillConfigSnapshotProvider for SkillConfig {
    fn snapshot(&self) -> Result<ash_config::SkillsConfig, String> {
        Ok(ash_config::SkillsConfig::default())
    }
}

struct CatalogTools;
impl ToolService for CatalogTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        ["read_file", "write_file", "search_tools", "call_mcp_tool", "spawn_agent", "send_agent_message", "wait_agent"].into_iter().map(|name| ToolDefinition {
            name: ToolName::new(name).unwrap(), description: name.into(), parameters: serde_json::json!({"type":"object", "properties":{}, "additionalProperties":false}), strict: true,
        }).collect()
    }
    fn prepare(&self, _: &ToolCall) -> Result<ash_action_policy::ActionReviewRequest, CoreError> {
        Err(CoreError::Execution("unexpected tool preparation".into()))
    }
    fn execute(
        &self,
        _: &ToolCall,
        _: &ash_core::ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ash_core::ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution("unexpected tool execution".into()))
    }
}
struct UnusedPolicy;
impl ActionPolicyService for UnusedPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }
    fn decide(
        &self,
        _: &ash_action_policy::ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ash_action_policy::ExecutionDecision, CoreError> {
        Err(CoreError::Policy("no tool calls are expected".into()))
    }
}

static REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    method: &str,
    params: Value,
) -> Value {
    serde_json::from_str(&server.handle_json(connection, &serde_json::json!({"jsonrpc":"2.0", "id":REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed), "method":method, "params":params}).to_string())).unwrap()
}

#[test]
fn session_role_is_atomic_replayable_and_applied_to_real_model_input() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("github")).unwrap();
    let skill_path = root.path().join("github/SKILL.md");
    std::fs::write(&skill_path, "---\nname: github\ndescription: Read selected GitHub issues.\n---\nUse the connected GitHub tools.\n").unwrap();
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = Arc::new(ThreadController::with_store(store.clone()));
    let (tx, rx) = mpsc::channel();
    let guidance = ash_prompts::PromptArtifact::new(
        "models-manager",
        "model/test",
        "test-v1",
        "MODEL_GUIDANCE_MARKER\n",
    );
    let catalog = ash_models_manager::ModelInstructionCatalog::new([
        ash_models_manager::ModelInstructionProfile {
            model: model(),
            instructions: guidance,
        },
    ])
    .unwrap();
    let mut server = AppServer::new(threads.clone(), Arc::new(CaptureModel(tx)))
        .with_model_instructions(catalog)
        .unwrap()
        .with_skill_runtime(
            ash_skills_extension::BuiltInSkillSource::Root(root.path().to_owned()),
            Arc::new(SkillConfig),
            None,
        )
        .unwrap()
        .with_tool_service(Arc::new(CatalogTools), Arc::new(UnusedPolicy));
    server.model_catalog = Arc::new(TestModels);
    let mut connection = server.connection();
    assert!(
        call(
            &server,
            &mut connection,
            "initialize",
            serde_json::json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}})
        )
        .get("result")
        .is_some()
    );
    let agent = AgentRoleSelection::Exact {
        source: AgentRoleSource::BuiltIn,
        name: "issue".into(),
    };
    let params =
        serde_json::json!({"commandId":"root-issue", "title":"Selected issues", "agent":agent});
    let created = call(&server, &mut connection, "session/create", params.clone());
    assert!(created.get("result").is_some(), "{created}");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let thread_id = ThreadId::new(session_id).unwrap();
    let root_thread = threads.read_thread(&thread_id).unwrap();
    assert_eq!(root_thread.sequence, 1);
    assert!(root_thread.agent_context_seed.is_none());
    let configuration = root_thread.agent_configuration().unwrap();
    assert_eq!(configuration.role.as_ref().unwrap().name, "issue");
    assert!(
        !configuration
            .capability_scope
            .tools
            .iter()
            .any(|tool| tool.as_str() == "write_file")
    );
    assert!(
        configuration
            .capability_scope
            .delegation_tools
            .iter()
            .any(|tool| tool.as_str() == "write_file")
    );
    assert_eq!(
        configuration.capability_scope.skills[0].id.name.as_str(),
        "github"
    );
    let started = call(
        &server,
        &mut connection,
        "session/request",
        serde_json::json!({
            "commandId":"root-first-turn", "sessionId":session_id,
            "request":{"type":"startTurn", "threadId":session_id, "expectedSequence":1,
                "input":[{"type":"text","text":"Handle the selected issues."}]}
        }),
    );
    assert!(started.get("result").is_some(), "{started}");
    let request = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let rendered = serde_json::to_string(&request).unwrap();
    assert!(rendered.contains("Shared working rules"));
    assert!(rendered.contains("Issue coordinator"));
    assert!(rendered.contains("MODEL_GUIDANCE_MARKER"));
    assert!(
        !request
            .tools
            .iter()
            .any(|tool| tool.name.as_str() == "write_file")
    );
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(matches!(
        snapshot.turns[0]
            .instructions
            .as_ref()
            .unwrap()
            .model_guidance(),
        Some(ModelInstructionSelection::Specialized { .. })
    ));
    std::fs::remove_file(skill_path).unwrap();
    let replayed = call(&server, &mut connection, "session/create", params);
    assert_eq!(replayed["result"]["session"]["sessionId"], session_id);
    let conflict = call(
        &server,
        &mut connection,
        "session/create",
        serde_json::json!({"commandId":"root-issue", "title":"Selected issues", "agent":{"type":"default"}}),
    );
    assert!(conflict.get("error").is_some());
    let restored = ThreadController::with_store(store)
        .read_thread(&thread_id)
        .unwrap();
    assert_eq!(restored.agent_configuration(), Some(configuration));
    assert_eq!(
        threads
            .read_started_thread(&CommandId::new("root-issue").unwrap())
            .unwrap()
            .unwrap()
            .agent_configuration(),
        Some(configuration)
    );
}

#[test]
fn missing_role_fails_before_a_session_is_created_and_default_never_routes_by_title() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let (tx, _) = mpsc::channel();
    let server = AppServer::new(threads.clone(), Arc::new(CaptureModel(tx)));
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        "initialize",
        serde_json::json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}}),
    );
    let rejected = call(
        &server,
        &mut connection,
        "session/create",
        serde_json::json!({"commandId":"missing-role", "title":"Issue work", "agent":{"type":"exact","source":{"type":"builtIn"},"name":"missing"}}),
    );
    assert!(rejected.get("error").is_some());
    assert!(
        threads
            .read_started_thread(&CommandId::new("missing-role").unwrap())
            .unwrap()
            .is_none()
    );
    let created = call(
        &server,
        &mut connection,
        "session/create",
        serde_json::json!({"commandId":"default-role", "title":"issue coordinator implementation"}),
    );
    assert!(created.get("result").is_some(), "{created}");
    assert!(
        threads
            .read_started_thread(&CommandId::new("default-role").unwrap())
            .unwrap()
            .unwrap()
            .agent_configuration()
            .is_none()
    );
}

struct SessionActivation(std::sync::atomic::AtomicUsize);

impl ash_extension_api::SkillActivationContributor for SessionActivation {
    fn contribute(
        &self,
        _: ash_extension_api::SkillActivationContext<'_>,
    ) -> Result<Vec<ash_protocol::FrozenSkillActivation>, ash_extension_api::ExtensionError> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Vec::new())
    }
}

#[test]
fn fork_session_binds_extensions_and_delivers_approval_after_subscription() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let (tx, _) = mpsc::channel();
    let mut server = AppServer::new(threads.clone(), Arc::new(CaptureModel(tx)));
    let activation = Arc::new(SessionActivation(std::sync::atomic::AtomicUsize::new(0)));
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.skill_activation_contributor(activation.clone());
    server.agent_extensions = Arc::new(extensions.build());
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        "initialize",
        serde_json::json!({
            "clientInfo":{"name":"fork-test","version":"1"},
            "capabilities":{"agentInteractions":{"version":1,"kinds":["approval"]}}
        }),
    );
    assert!(initialized.get("result").is_some(), "{initialized}");
    let created = call(
        &server,
        &mut connection,
        "session/create",
        serde_json::json!({"commandId":"source", "title":"Source"}),
    );
    let source_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let params = serde_json::json!({"commandId":"copy", "sessionId":source_id,
        "request":{"type":"forkSession", "parentThreadId":source_id, "title":"Copy"}});
    let copied = call(&server, &mut connection, "session/request", params.clone());
    assert!(copied.get("result").is_some(), "{copied}");
    let repeated = call(&server, &mut connection, "session/request", params);
    assert_eq!(copied["result"], repeated["result"]);
    let session_id = ash_protocol::SessionId::new(
        copied["result"]["value"]["session"]["sessionId"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let thread_id = ThreadId::new(copied["result"]["value"]["threadId"].as_str().unwrap()).unwrap();
    assert_ne!(session_id.as_str(), source_id);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    let started = threads
        .start_turn(
            &thread_id,
            ash_core::StartTurnRequest {
                command_id: CommandId::new("copy-turn").unwrap(),
                expected_sequence: ash_core::SequenceExpectation::Exact(snapshot.sequence),
                model: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                policy_revision: "test-policy".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![ash_protocol::UserInput::Text {
                    text: "background task".into(),
                }],
            },
        )
        .unwrap();
    assert_eq!(activation.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    threads
        .request_turn_interaction(
            &thread_id,
            &started.turn_id,
            ash_core::RequestTurnInteraction {
                request_id: ash_protocol::RequestId::new("copy-approval").unwrap(),
                item_id: None,
                request: ash_protocol::AgentRequest::Approval {
                    request: ash_protocol::ActionApprovalRequest {
                        action_digest: "a".repeat(64),
                        policy_revision: "test-policy".into(),
                        capabilities: vec![ash_protocol::ActionApprovalCapability {
                            kind: ash_protocol::ActionApprovalCapabilityKind::Network,
                            scope: "example.test".into(),
                        }],
                        reason: "test approval".into(),
                        sandbox_denial: None,
                    },
                },
                deadline: None,
            },
        )
        .unwrap();
    server.offer_pending_interactions(&threads.read_thread(&thread_id).unwrap());
    assert!(
        !server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notice| notice.contains("\"method\":\"agent/request\""))
    );
    let subscribed = call(
        &server,
        &mut connection,
        "session/thread/subscribe",
        serde_json::json!({
            "sessionId":session_id, "threadId":thread_id, "afterSequence":0
        }),
    );
    assert!(subscribed.get("result").is_some(), "{subscribed}");
    assert!(
        server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notice| notice.contains("\"method\":\"agent/request\"")
                && notice.contains("copy-approval"))
    );
}

use ash_app_server::AppServer;
use ash_app_server::SlashCommandCatalog;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::InProcessClientOptions;
use ash_app_server_client::InProcessTransport;
use ash_app_server_client::ServerNotification;
use ash_app_server_client::SessionStateMode;
use ash_app_server_client::open_in_process_app_server;
use ash_app_server_client::start_in_process_client;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::common::DirectoryGrantsHostCapability;
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::resources::ResourceReadParams;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::skills::SkillCatalogReloadDto;
use ash_app_server_protocol::protocol::skills::SkillEnablementDto;
use ash_app_server_protocol::protocol::skills::SkillListParams;
use ash_app_server_protocol::protocol::skills::SkillResourceOpenParams;
use ash_app_server_protocol::protocol::skills::SkillSetEnablementParams;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandArgumentModeDto;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandDefinition;
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeParams;
use ash_app_server_protocol::protocol::syntax::SyntaxCloseParams;
use ash_app_server_protocol::protocol::syntax::SyntaxEditDto;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::syntax::SyntaxOpenParams;
use ash_app_server_protocol::protocol::syntax::SyntaxUpdateParams;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_app_server_protocol::schema_hash;
use ash_async_utils::CancellationToken;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_protocol::CommandId;
use ash_protocol::ContentPart;
use ash_protocol::InputItem as ModelInputItem;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadUpdate;
use ash_protocol::TurnStatus;
use core_api::CoreError;
use core_api::ModelService;
use std::fs;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

fn app_server() -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(threads, Arc::new(TestModel), ash_app_server_diff::compute)
}

struct TestModel;

impl ModelService for TestModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let prompt = request
            .input
            .iter()
            .rev()
            .find_map(|item| match item {
                ModelInputItem::Message(message) => {
                    message.content.iter().find_map(|content| match content {
                        ContentPart::Text(text) => Some(text.as_str()),
                        ContentPart::Artifact { .. } | ContentPart::ImageUrl { .. } => None,
                        ContentPart::ImageAttachment { .. } => None,
                        ContentPart::AudioAttachment { .. } | ContentPart::AudioUrl { .. } => None,
                    })
                }
                ModelInputItem::ToolResult(_) | ModelInputItem::Reasoning(_) => None,
            })
            .unwrap_or_default();
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(format!("Ash: {prompt}"))],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

fn unique_directory(label: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "ash-app-server-client-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn write_skill(path: &std::path::Path, name: &str, description: &str) {
    let directory = path.join(name);
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\nInstructions.\n"),
    )
    .unwrap();
}

#[test]
fn client_preserves_the_initialized_slash_command_snapshot() {
    let definition = SlashCommandDefinition {
        name: "diagnose".into(),
        description: "inspect the current directory".into(),
        argument_mode: SlashCommandArgumentModeDto::Optional,
        argument_hint: None,
    };
    let server = app_server()
        .with_slash_command_catalog(SlashCommandCatalog::new([definition.clone()]).unwrap());
    let mut client = AppServerClient::new(InProcessTransport::from_server(server));

    client
        .initialize(InitializeParams {
            client_info: ClientInfo {
                name: "test-client".into(),
                version: "1".into(),
            },
            capabilities: ClientCapabilities::default(),
        })
        .unwrap();

    assert_eq!(
        client.initialization().unwrap().slash_commands,
        [definition]
    );
}

#[test]
fn embedded_skill_catalog_lists_built_ins_and_persists_enablement() {
    let state_root = unique_directory("skills-state");
    let skills_root = unique_directory("skills-root");
    write_skill(&skills_root, "skill-creator", "Create or update a Skill");
    let asset = b"\x89PNG\r\n\x1a\nclient-fixture";
    fs::create_dir_all(skills_root.join("skill-creator/assets")).unwrap();
    fs::write(skills_root.join("skill-creator/assets/icon.png"), asset).unwrap();
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "skills-client".into(),
                version: "1".into(),
            },
        )
        .with_built_in_skill_root(&skills_root),
    )
    .unwrap();

    let listed = client
        .list_skills(SkillListParams {
            reload: SkillCatalogReloadDto::Refresh,
            session_id: None,
        })
        .unwrap();
    assert_eq!(listed.skills.len(), 1);
    assert_eq!(listed.skills[0].id.name.as_str(), "skill-creator");
    assert_eq!(listed.skills[0].enablement, SkillEnablementDto::Enabled);

    let opened = client
        .open_skill_resource(SkillResourceOpenParams {
            session_id: None,
            skill_id: listed.skills[0].id.clone(),
            skill_content_digest: listed.skills[0].content_digest.clone(),
            path: "assets/icon.png".into(),
        })
        .unwrap();
    assert_eq!(
        opened.kind,
        ash_app_server_protocol::protocol::skills::SkillResourceKindDto::Asset
    );
    assert_eq!(opened.resource.mime_type, "image/png");
    let resource = client
        .read_resource(ResourceReadParams {
            resource_id: opened.resource.resource_id,
            offset: 0,
            max_bytes: 262_144,
        })
        .unwrap();
    assert_eq!(resource.decoded_length, asset.len());
    assert!(resource.eof);

    let revision = client.read_config().unwrap().revision;
    client
        .set_skill_enablement(SkillSetEnablementParams {
            session_id: None,
            command_id: CommandId::new("disable-skill-creator").unwrap(),
            expected_revision: revision,
            skill_id: listed.skills[0].id.clone(),
            enablement: SkillEnablementDto::Disabled,
        })
        .unwrap();
    let disabled = client.list_skills(SkillListParams::default()).unwrap();
    assert_eq!(disabled.generation, listed.generation + 1);
    assert_eq!(disabled.skills[0].enablement, SkillEnablementDto::Disabled);
    assert!(
        client
            .drain_notifications()
            .unwrap()
            .iter()
            .any(|notification| matches!(
                notification,
                ServerNotification::SkillsChanged(changed)
                    if changed.generation == disabled.generation
            ))
    );

    drop(client);
    let _ = fs::remove_dir_all(state_root);
    let _ = fs::remove_dir_all(skills_root);
}

#[test]
fn embedded_skill_watcher_invalidates_changed_content() {
    let state_root = unique_directory("watch-state");
    let skills_root = unique_directory("watch-root");
    write_skill(&skills_root, "review", "Review code");
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "skills-watch-client".into(),
                version: "1".into(),
            },
        )
        .with_built_in_skill_root(&skills_root),
    )
    .unwrap();
    let initial = client.list_skills(SkillListParams::default()).unwrap();
    thread::sleep(Duration::from_millis(150));

    write_skill(&skills_root, "review", "Review code and tests");

    let deadline = Instant::now() + Duration::from_secs(3);
    let changed_generation = loop {
        let notification =
            client
                .drain_notifications()
                .unwrap()
                .into_iter()
                .find_map(|notification| match notification {
                    ServerNotification::SkillsChanged(changed) => Some(changed.generation),
                    _ => None,
                });
        if let Some(generation) = notification {
            break generation;
        }
        assert!(Instant::now() < deadline, "Skill watcher did not publish");
        thread::sleep(Duration::from_millis(10));
    };
    let refreshed = client.list_skills(SkillListParams::default()).unwrap();
    assert_eq!(refreshed.generation, changed_generation);
    assert_eq!(refreshed.skills[0].description, "Review code and tests");
    assert!(refreshed.generation > initial.generation);

    drop(client);
    let _ = fs::remove_dir_all(state_root);
    let _ = fs::remove_dir_all(skills_root);
}

#[test]
fn embedded_startup_accepts_product_host_capabilities() {
    let state_root = unique_directory("product-host-capabilities");
    let client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "product-host-client".into(),
                version: "1".into(),
            },
        )
        .with_capabilities(ClientCapabilities {
            directory_grants_host: Some(DirectoryGrantsHostCapability { version: 1 }),
            ..ClientCapabilities::default()
        }),
    )
    .unwrap();

    assert!(client.initialization().unwrap().capabilities.memories);

    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn embedded_startup_propagates_the_host_slash_command_catalog() {
    let definition = SlashCommandDefinition {
        name: "diagnose".into(),
        description: "inspect the current directory".into(),
        argument_mode: SlashCommandArgumentModeDto::Optional,
        argument_hint: None,
    };
    let state_root = std::env::temp_dir().join(format!(
        "ash-app-server-client-slash-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "test-client".into(),
                version: "1".into(),
            },
        )
        .with_slash_command_catalog(SlashCommandCatalog::new([definition.clone()]).unwrap()),
    )
    .unwrap();

    assert_eq!(
        client.initialization().unwrap().slash_commands,
        [definition]
    );
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn ephemeral_session_state_ignores_and_does_not_append_durable_history() {
    let state_root = unique_directory("ephemeral-session-state");
    let mut durable = start_in_process_client(InProcessClientOptions::new(
        &state_root,
        ClientInfo {
            name: "durable-seed".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    durable
        .create_session(SessionCreateParams {
            branch_name: None,
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: CommandId::new("durable-seed-session").unwrap(),
            title: "durable seed".into(),
            execution_target: None,
        })
        .unwrap();
    drop(durable);

    let mut ephemeral = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "ephemeral".into(),
                version: "1".into(),
            },
        )
        .with_session_state_mode(SessionStateMode::Ephemeral),
    )
    .unwrap();
    assert!(ephemeral.list_sessions().unwrap().sessions.is_empty());
    ephemeral
        .create_session(SessionCreateParams {
            branch_name: None,
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: CommandId::new("ephemeral-session").unwrap(),
            title: "ephemeral session".into(),
            execution_target: None,
        })
        .unwrap();
    drop(ephemeral);

    let mut durable_again = start_in_process_client(InProcessClientOptions::new(
        &state_root,
        ClientInfo {
            name: "durable-check".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    let sessions = durable_again.list_sessions().unwrap().sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].title, "durable seed");

    drop(durable_again);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn in_process_client_routes_syntax_analysis_to_the_server() {
    let mut client = AppServerClient::new(InProcessTransport::from_server(app_server()));
    client
        .initialize(InitializeParams {
            client_info: ClientInfo {
                name: "test-client".into(),
                version: "1".into(),
            },
            capabilities: ClientCapabilities::default(),
        })
        .expect("in-process client initializes");

    client
        .open_syntax(SyntaxOpenParams {
            document_id: "model-1".into(),
            language: SyntaxLanguageDto::Rust,
            revision: 9,
            text: "fn main() {\n}\n".into(),
        })
        .expect("syntax document opens");
    client
        .update_syntax(SyntaxUpdateParams {
            document_id: "model-1".into(),
            previous_revision: 9,
            revision: 10,
            edits: vec![SyntaxEditDto {
                start_offset: 3,
                end_offset: 7,
                text: "renamed".into(),
            }],
        })
        .expect("syntax edit applies");
    let result = client
        .analyze_syntax(SyntaxAnalyzeParams {
            document_id: "model-1".into(),
            revision: 10,
        })
        .expect("syntax analysis succeeds");

    assert_eq!(result.revision, 10);
    assert!(
        result
            .folding_ranges
            .iter()
            .any(|range| { range.range.start.line_index == 0 && range.range.end.line_index == 1 })
    );
    client
        .close_syntax(SyntaxCloseParams {
            document_id: "model-1".into(),
        })
        .expect("syntax document closes");
}

#[test]
fn in_process_client_uses_session_first_contract_and_canonical_updates() {
    let mut client = AppServerClient::new(InProcessTransport::from_server(app_server()));
    let initialized = client
        .initialize(InitializeParams {
            client_info: ClientInfo {
                name: "test-client".into(),
                version: "1".into(),
            },
            capabilities: ClientCapabilities::default(),
        })
        .expect("in-process client initializes");
    assert_eq!(initialized.schema_hash.0, schema_hash());
    assert_eq!(client.initialization().unwrap(), &initialized);
    let session = client
        .create_session(SessionCreateParams {
            branch_name: None,
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: CommandId::new("session-one").expect("test ID is non-empty"),
            title: "test".into(),
            execution_target: None,
        })
        .expect("Session is created");
    let thread = client
        .request_session(SessionRequestParams {
            command_id: CommandId::new("thread-one").expect("test ID is non-empty"),
            session_id: session.session.session_id.clone(),
            request: SessionRequest::CreateThread {
                agent_id: None,
                title: "root".into(),
            },
        })
        .expect("Thread is created");
    let thread = match thread {
        SessionRequestResult::Thread(thread) => thread,
        result => panic!("unexpected create-thread result: {result:?}"),
    };
    let turn = client
        .request_session(SessionRequestParams {
            command_id: CommandId::new("turn-one").expect("test ID is non-empty"),
            session_id: session.session.session_id.clone(),
            request: SessionRequest::StartTurn {
                ide_window_id: None,
                thread_id: thread.thread_id.clone(),
                expected_sequence: 1,
                mode: ash_protocol::CollaborationMode::Agent,
                approval_mode: Some(ash_protocol::ApprovalMode::default()),
                model: None,
                reasoning_effort: None,
                tool_mode: None,
                input: vec![
                    InputItem::Text {
                        text: "hello".into(),
                    },
                    InputItem::Image {
                        url: concat!(
                            "data:image/png;base64,",
                            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC",
                            "AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        )
                        .into(),
                    },
                ],
            },
        })
        .expect("Turn starts");
    let turn = match turn {
        SessionRequestResult::Turn(turn) => turn,
        result => panic!("unexpected start-turn result: {result:?}"),
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    let snapshot = loop {
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: session.session.session_id.clone(),
                thread_id: thread.thread_id.clone(),
                history: None,
            })
            .expect("Thread remains readable");
        if snapshot.thread.turns[0].status == TurnStatus::Completed {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "Turn did not complete");
        thread::sleep(Duration::from_millis(1));
    };
    let notifications = client.drain_notifications().expect("notifications decode");
    let output = notifications
        .iter()
        .find_map(|notification| match notification {
            ServerNotification::SessionThreadUpdate(update) => match &update.update {
                ThreadUpdate::Committed {
                    event:
                        ThreadEvent::ItemCompleted {
                            item: ThreadItem::AgentMessage { text, .. },
                            ..
                        },
                } => Some(text.as_str()),
                _ => None,
            },
            _ => None,
        });
    assert_eq!(output, Some("Ash: hello"));
    assert_eq!(snapshot.thread.turns[0].turn_id, turn.turn_id);
    assert_eq!(snapshot.thread.turns[0].status, TurnStatus::Completed);
    assert!(matches!(
        &snapshot.thread.turns[0].items[1],
        ThreadItem::UserImageAttachment { .. }
    ));
}

#[test]
fn shared_embedded_host_opens_independent_initialized_connections() {
    let state_root = std::env::temp_dir().join(format!(
        "ash-app-server-client-shared-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let host = open_in_process_app_server(InProcessClientOptions::new(
        &state_root,
        ClientInfo {
            name: "shared-client".into(),
            version: "1".into(),
        },
    ))
    .unwrap();
    let first = host.connect().unwrap();
    let second = host.connect().unwrap();

    assert_eq!(
        first.initialization().unwrap().schema_hash,
        second.initialization().unwrap().schema_hash
    );

    drop((first, second, host));
    let _ = fs::remove_dir_all(state_root);
}

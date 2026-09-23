use super::*;
use ash_app_server::AppServer;
use ash_app_server::SlashCommandCatalog;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::common::DirPermissionsHostCapability;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirAddParams;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirMutationDto;
use ash_app_server_protocol::protocol::environment::SessionDirPermissionsSetParams;
use ash_app_server_protocol::protocol::environment::SessionDirRemoveParams;
use ash_app_server_protocol::protocol::fs::{
    FsFileType, FsGetMetadataParams, FsReadBinaryFileParams, FsReadDirectoryParams,
    FsReadFileParams, FsWriteFileParams,
};
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::language::LanguageCloseParams;
use ash_app_server_protocol::protocol::language::LanguageCompletionTriggerKindDto;
use ash_app_server_protocol::protocol::language::LanguageCompletionsParams;
use ash_app_server_protocol::protocol::language::LanguageDocumentDto;
use ash_app_server_protocol::protocol::language::LanguageHoverParams;
use ash_app_server_protocol::protocol::language::LanguageLocationKindDto;
use ash_app_server_protocol::protocol::language::LanguageLocationsParams;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;
use ash_app_server_protocol::protocol::language::LanguageSynchronizeParams;
use ash_app_server_protocol::protocol::memory::MemoryListParams;
use ash_app_server_protocol::protocol::session::{
    SessionCreateParams, SessionRequest, SessionRequestParams, SessionRequestResult,
    SessionThreadReadParams,
};
use ash_app_server_protocol::protocol::skills::{
    SkillCatalogReloadDto, SkillEnablementDto, SkillListParams, SkillResourceOpenParams,
    SkillSetEnablementParams,
};
use ash_app_server_protocol::protocol::slash_commands::{
    SlashCommandArgumentModeDto, SlashCommandDefinition,
};
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeParams;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
use ash_app_server_protocol::protocol::terminal::TerminalLifecycle;
use ash_app_server_protocol::protocol::terminal::TerminalProfileSelection;
use ash_app_server_protocol::protocol::terminal::TerminalReadParams;
use ash_app_server_protocol::protocol::terminal::TerminalResizeParams;
use ash_app_server_protocol::protocol::terminal::TerminalWriteParams;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_app_server_protocol::schema_hash;
use ash_async_utils::CancellationToken;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_protocol::SessionId;
use ash_protocol::{
    CommandId, ContentPart, InputItem as ModelInputItem, ModelRequest, ModelResponse, ResponseItem,
    StopReason, ThreadEvent, ThreadItem, ThreadUpdate, TurnStatus,
};
use core_api::CoreError;
use core_api::ModelService;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct MockTransport(VecDeque<String>);

impl JsonRpcTransport for MockTransport {
    fn round_trip(&mut self, _: &str) -> Result<String, ClientError> {
        self.0
            .pop_front()
            .ok_or_else(|| ClientError::Transport("no response".into()))
    }
}

fn app_server() -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(threads, Arc::new(TestModel))
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
                        ContentPart::ImageUrl { .. } => None,
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

#[test]
fn client_rejects_response_for_another_request() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}".into(),
    ])));
    let result: Result<serde_json::Value, _> =
        client.call(ClientMethod::Initialize, serde_json::json!({}));
    assert!(matches!(result, Err(ClientError::Protocol(_))));
}

#[test]
fn client_reads_directories_through_the_typed_contract() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":{"entries":[{"name":"src","fileType":"directory"}]}}"#
            .into(),
    ])));

    let result = client
        .read_directory(FsReadDirectoryParams {
            dir_id: None,
            session_directory: None,
            path: "nested".into(),
        })
        .unwrap();

    assert_eq!(result.entries.len(), 1);
    assert_eq!(result.entries[0].name, "src");
    assert_eq!(result.entries[0].file_type, FsFileType::Directory);
}

#[test]
fn client_validates_memory_page_scope() {
    let response = |scope: &str| {
        format!(
            r#"{{"jsonrpc":"2.0","id":1,"result":{{"catalogRevision":1,"memories":[{{"memoryId":"memory-1","scope":{{"type":"{scope}"}},"revision":1,"title":"title","source":"user","createdAtUnixMs":1,"updatedAtUnixMs":1}}],"nextCursor":null}}}}"#
        )
    };
    let mut matching = AppServerClient::new(MockTransport(VecDeque::from([response("profile")])));
    let page = matching
        .list_memories(MemoryListParams {
            scope: ::memories::MemoryScope::Profile,
            cursor: None,
            limit: Some(20),
        })
        .unwrap();
    assert_eq!(page.memories[0].memory_id.as_str(), "memory-1");

    let mut mismatched = AppServerClient::new(MockTransport(VecDeque::from([response("profile")])));
    let result = mismatched.list_memories(MemoryListParams {
        scope: ::memories::MemoryScope::Project {
            project_id: ash_protocol::ProjectId::new("project-1").unwrap(),
        },
        cursor: None,
        limit: Some(20),
    });
    assert!(matches!(result, Err(ClientError::Protocol(_))));
}

#[test]
fn client_manages_session_dirs_through_typed_contracts() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":{"revision":0,"dirs":[]}}"#.into(),
        r#"{"jsonrpc":"2.0","id":2,"result":{"path":"/tmp/extra","mutation":"added","revision":1,"dirs":[{"path":"/tmp/extra","permissions":["readFiles","writeFiles"],"contributions":{"skills":[],"mcpServers":[],"hooks":[],"plugins":[],"diagnostics":[]}}]}}"#.into(),
        r#"{"jsonrpc":"2.0","id":3,"result":{"mutation":"updated","revision":2,"dirs":[{"path":"/tmp/extra","permissions":["readFiles"],"contributions":{"skills":[],"mcpServers":[],"hooks":[],"plugins":[],"diagnostics":[]}}]}}"#.into(),
        r#"{"jsonrpc":"2.0","id":4,"result":{"mutation":"removed","revision":3,"dirs":[]}}"#.into(),
    ])));
    let session_id = SessionId::new("session-dir-session").unwrap();

    assert!(
        client
            .list_session_dirs(SessionDirListParams {
                session_id: session_id.clone(),
            })
            .unwrap()
            .dirs
            .is_empty()
    );
    let added = client
        .add_session_dir(SessionDirAddParams {
            session_id: session_id.clone(),
            path: "/tmp/extra".into(),
            permissions: vec![PermissionDto::ReadFiles, PermissionDto::WriteFiles],
        })
        .unwrap();
    assert_eq!(added.path, PathBuf::from("/tmp/extra"));
    assert_eq!(added.mutation, SessionDirMutationDto::Added);
    assert_eq!(added.dirs[0].path, PathBuf::from("/tmp/extra"));
    let updated = client
        .set_session_dir_permissions(SessionDirPermissionsSetParams {
            session_id: session_id.clone(),
            path: "/tmp/extra".into(),
            expected_revision: 1,
            permissions: vec![PermissionDto::ReadFiles],
        })
        .unwrap();
    assert_eq!(updated.mutation, SessionDirMutationDto::Updated);
    assert_eq!(updated.revision, 2);
    let removed = client
        .remove_session_dir(SessionDirRemoveParams {
            session_id,
            path: "/tmp/extra".into(),
        })
        .unwrap();
    assert_eq!(removed.mutation, SessionDirMutationDto::Removed);
    assert!(removed.dirs.is_empty());
}

#[test]
fn client_analyzes_syntax_through_the_typed_contract() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":{"revision":8,"hasErrors":false,"tokens":[],"foldingRanges":[],"symbols":[],"diagnostics":[]}}"#.into(),
    ])));

    let result = client
        .analyze_syntax(SyntaxAnalyzeParams {
            document_id: "model-1".into(),
            language: SyntaxLanguageDto::Rust,
            revision: 8,
            text: "fn main() {}\n".into(),
        })
        .unwrap();

    assert_eq!(result.revision, 8);
    assert!(!result.has_errors);
}

#[test]
fn client_reads_marketplace_generation_through_the_typed_contract() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":{"instanceId":"marketplace-runtime-1","generation":7,"packages":[]}}"#.into(),
    ])));

    let result = client.list_installed_marketplace_packages().unwrap();

    assert_eq!(result.generation, 7);
    assert_eq!(result.instance_id, "marketplace-runtime-1");
    assert!(result.packages.is_empty());
}

#[test]
fn client_drives_language_documents_and_requests_through_typed_methods() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":null}"#.into(),
        r#"{"jsonrpc":"2.0","id":2,"result":{"revision":7,"contents":"i32","range":null}}"#.into(),
        r#"{"jsonrpc":"2.0","id":3,"result":{"revision":7,"isIncomplete":false,"canResolve":false,"items":[]}}"#.into(),
        r#"{"jsonrpc":"2.0","id":4,"result":{"revision":7,"locations":[]}}"#.into(),
        r#"{"jsonrpc":"2.0","id":5,"result":null}"#.into(),
    ])));
    let document = LanguageDocumentDto {
        dir_id: None,
        session_directory: None,
        path: "src/main.rs".into(),
        language_id: "rust".into(),
        revision: 7,
        text: "let value: i32 = 1;".into(),
    };
    let position = LanguagePositionDto {
        line_index: 0,
        column_index: 9,
    };

    client
        .synchronize_language_document(LanguageSynchronizeParams {
            document: document.clone(),
        })
        .unwrap();
    let hover = client
        .language_hover(LanguageHoverParams {
            document: document.clone(),
            position,
        })
        .unwrap();
    let completions = client
        .language_completions(LanguageCompletionsParams {
            document: document.clone(),
            position,
            trigger_kind: LanguageCompletionTriggerKindDto::Invoke,
            trigger_character: None,
        })
        .unwrap();
    let locations = client
        .language_locations(LanguageLocationsParams {
            document: document.clone(),
            position,
            kind: LanguageLocationKindDto::Definition,
            include_declaration: false,
        })
        .unwrap();
    client
        .close_language_document(LanguageCloseParams {
            dir_id: None,
            session_directory: None,
            path: document.path,
        })
        .unwrap();

    assert_eq!(hover.contents.as_deref(), Some("i32"));
    assert!(completions.items.is_empty());
    assert!(locations.locations.is_empty());
}

#[test]
fn client_drives_terminal_lifecycle_through_typed_methods() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        format!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"terminalId":"terminal-1","profile":{{"profileId":"default","title":"Shell","isDefault":true}},"reconnect":{{"reconnectToken":"{}","reconnectGracePeriodMillis":30000}}}}}}"#, "a".repeat(64)),
        format!(r#"{{"jsonrpc":"2.0","id":2,"result":{{"terminalId":"terminal-1","reconnect":{{"reconnectToken":"{}","reconnectGracePeriodMillis":30000}}}}}}"#, "b".repeat(64)),
        r#"{"jsonrpc":"2.0","id":3,"result":null}"#.into(),
        r#"{"jsonrpc":"2.0","id":4,"result":null}"#.into(),
        r#"{"jsonrpc":"2.0","id":5,"result":{"terminalId":"terminal-1","chunks":[],"nextSequence":0,"outputGap":false,"commandEvents":[],"nextCommandSequence":0,"commandEventGap":false,"exited":false,"exitCode":null}}"#.into(),
        r#"{"jsonrpc":"2.0","id":6,"result":null}"#.into(),
    ])));

    let created = client
        .terminal_create(TerminalCreateParams {
            dir_id: None,
            rows: 24,
            cols: 80,
            profile: TerminalProfileSelection::Default,
            lifecycle: TerminalLifecycle::Reconnectable,
        })
        .unwrap();
    assert_eq!(created.terminal_id, "terminal-1");
    let attached = client
        .terminal_attach(TerminalAttachParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            reconnect_token: created.reconnect.unwrap().reconnect_token,
            rows: 24,
            cols: 80,
        })
        .unwrap();
    assert_eq!(attached.reconnect.reconnect_token, "b".repeat(64));
    client
        .terminal_write(TerminalWriteParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            data: "echo ready\n".into(),
        })
        .unwrap();
    client
        .terminal_resize(TerminalResizeParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            rows: 30,
            cols: 100,
        })
        .unwrap();
    let read = client
        .terminal_read(TerminalReadParams {
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            after_sequence: 0,
            after_command_sequence: 0,
            max_chunks: 8,
        })
        .unwrap();
    assert_eq!(read.terminal_id, "terminal-1");
    client
        .terminal_close(
            ash_app_server_protocol::protocol::terminal::TerminalCloseParams {
                dir_id: None,
                terminal_id: created.terminal_id,
            },
        )
        .unwrap();
}

#[test]
fn client_reads_writes_and_versions_files_through_typed_contracts() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":{"content":"fn main() {}\n","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.into(),
        r#"{"jsonrpc":"2.0","id":2,"result":{"resource":{"resourceId":"resource_0000000000000001","mimeType":"application/octet-stream","size":9,"sha256":"sha256:abc"},"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.into(),
        r#"{"jsonrpc":"2.0","id":3,"result":{"fileType":"file","sizeBytes":13,"readonly":false,"modifiedAtMillis":41}}"#.into(),
        r#"{"jsonrpc":"2.0","id":4,"result":{"metadata":{"fileType":"file","sizeBytes":14,"readonly":false,"modifiedAtMillis":42},"revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}"#.into(),
    ])));

    let read = client
        .read_file(FsReadFileParams {
            dir_id: None,
            session_directory: None,
            path: "src/main.rs".into(),
        })
        .unwrap();
    let binary = client
        .read_binary_file(FsReadBinaryFileParams {
            dir_id: None,
            session_directory: None,
            path: "paper.pdf".into(),
        })
        .unwrap();
    let metadata = client
        .get_file_metadata(FsGetMetadataParams {
            dir_id: None,
            session_directory: None,
            path: "src/main.rs".into(),
        })
        .unwrap();
    let written = client
        .write_file(FsWriteFileParams {
            dir_id: None,
            session_directory: None,
            path: "src/main.rs".into(),
            content: "fn main() { }\n".into(),
            expected_revision: None,
        })
        .unwrap();

    assert_eq!(read.content, "fn main() {}\n");
    assert_eq!(binary.resource.resource_id, "resource_0000000000000001");
    assert_eq!(metadata.modified_at_millis, Some(41));
    assert_eq!(written.metadata.modified_at_millis, Some(42));
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
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: CommandId::new("session-one").expect("test ID is non-empty"),
            title: "test".into(),
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
                thread_id: thread.thread_id.clone(),
                expected_sequence: 1,
                approval_mode: ash_protocol::ApprovalMode::default(),
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

    let result = client
        .analyze_syntax(SyntaxAnalyzeParams {
            document_id: "model-1".into(),
            language: SyntaxLanguageDto::Rust,
            revision: 9,
            text: "fn main() {\n}\n".into(),
        })
        .expect("syntax analysis succeeds");

    assert_eq!(result.revision, 9);
    assert!(
        result
            .folding_ranges
            .iter()
            .any(|range| { range.range.start.line_index == 0 && range.range.end.line_index == 1 })
    );
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
fn initialization_snapshot_is_unavailable_before_handshake() {
    let client = AppServerClient::new(MockTransport(VecDeque::new()));

    assert!(matches!(
        client.initialization(),
        Err(ClientError::Protocol(message)) if message.contains("initialize handshake")
    ));
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
            dir_permissions_host: Some(DirPermissionsHostCapability { version: 1 }),
            ..ClientCapabilities::default()
        }),
    )
    .unwrap();

    assert!(client.initialization().unwrap().capabilities.memories);

    drop(client);
    let _ = fs::remove_dir_all(state_root);
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
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: CommandId::new("durable-seed-session").unwrap(),
            title: "durable seed".into(),
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
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: CommandId::new("ephemeral-session").unwrap(),
            title: "ephemeral session".into(),
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
fn memory_client_checks_citations_and_policy_mutation_identity() {
    use ash_app_server_protocol::protocol::memory::MemoryCitationReadParams;
    use ash_app_server_protocol::protocol::memory::MemoryPolicyUpdateParams;
    let citation = ::memories::MemoryCitation {
        memory_id: ::memories::MemoryId::new("memory-1").unwrap(),
        scope: ::memories::MemoryScope::Profile,
        revision: 1,
        start_byte: 0,
        end_byte: 4,
    };
    let response = |result| serde_json::json!({"jsonrpc":"2.0","id":1,"result":result}).to_string();
    let result = ::memories::MemoryCitationResult {
        citation: citation.clone(),
        title: "title".into(),
        source: ::memories::MemorySource::User,
        body: "body".into(),
    };
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([response(
        serde_json::to_value(&result).unwrap(),
    )])));
    assert_eq!(
        client
            .read_memory_citation(MemoryCitationReadParams {
                citation: citation.clone()
            })
            .unwrap(),
        result
    );
    let mut wrong = result.clone();
    wrong.citation.revision = 2;
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([response(
        serde_json::to_value(wrong).unwrap(),
    )])));
    assert!(matches!(
        client.read_memory_citation(MemoryCitationReadParams { citation }),
        Err(ClientError::Protocol(_))
    ));
    for (revision, mode, valid) in [
        (1, ::memories::MemoryReadMode::FirstInvocation, true),
        (2, ::memories::MemoryReadMode::FirstInvocation, false),
        (1, ::memories::MemoryReadMode::Disabled, false),
    ] {
        let result = ::memories::MemoryPolicyMutationResult {
            disposition: ::memories::MemoryMutationDisposition::Committed,
            catalog_revision: 1,
            policy: ::memories::MemoryPolicy {
                scope: ::memories::MemoryScope::Profile,
                revision,
                automatic_read: mode,
                model_write: ::memories::MemoryWriteMode::Disabled,
            },
        };
        let mut client = AppServerClient::new(MockTransport(VecDeque::from([response(
            serde_json::to_value(&result).unwrap(),
        )])));
        let actual = client.update_memory_policy(MemoryPolicyUpdateParams {
            command_id: CommandId::new("set-policy").unwrap(),
            scope: ::memories::MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: ::memories::MemoryReadMode::FirstInvocation,
            model_write: ::memories::MemoryWriteMode::Disabled,
        });
        if valid {
            assert_eq!(actual.unwrap(), result);
        } else {
            assert!(matches!(actual, Err(ClientError::Protocol(_))));
        }
    }
}

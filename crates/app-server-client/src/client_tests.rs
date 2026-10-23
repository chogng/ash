use super::*;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirAddParams;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::environment::SessionDirMutationDto;
use ash_app_server_protocol::protocol::environment::SessionDirRemoveParams;
use ash_app_server_protocol::protocol::environment::SessionDirectoryGrantSetParams;
use ash_app_server_protocol::protocol::fs::FsFileType;
use ash_app_server_protocol::protocol::fs::FsGetMetadataParams;
use ash_app_server_protocol::protocol::fs::FsReadBinaryFileParams;
use ash_app_server_protocol::protocol::fs::FsReadDirectoryParams;
use ash_app_server_protocol::protocol::fs::FsReadFileParams;
use ash_app_server_protocol::protocol::fs::FsWriteFileParams;
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
use ash_app_server_protocol::protocol::syntax::SyntaxAnalyzeParams;
use ash_app_server_protocol::protocol::syntax::SyntaxLanguageDto;
use ash_app_server_protocol::protocol::syntax::SyntaxOpenParams;
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
use ash_app_server_protocol::protocol::terminal::TerminalLifecycle;
use ash_app_server_protocol::protocol::terminal::TerminalProcessReady;
use ash_app_server_protocol::protocol::terminal::TerminalProfileSelection;
use ash_app_server_protocol::protocol::terminal::TerminalReadParams;
use ash_app_server_protocol::protocol::terminal::TerminalResizeParams;
use ash_app_server_protocol::protocol::terminal::TerminalWriteParams;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use std::collections::VecDeque;
use std::path::PathBuf;

struct MockTransport(VecDeque<String>);

impl JsonRpcTransport for MockTransport {
    fn round_trip(&mut self, _: &str) -> Result<String, ClientError> {
        self.0
            .pop_front()
            .ok_or_else(|| ClientError::Transport("no response".into()))
    }
}

#[test]
fn stopping_initialization_preserves_structured_cause_independently_of_message() {
    for message in ["Local App Server daemon is stopping", "diagnostic changed"] {
        let wire = serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":message,"data":{"kind":"ServerShuttingDown"}}}).to_string();
        let mut client = AppServerClient::new(MockTransport(VecDeque::from([wire])));
        let result: Result<serde_json::Value, _> =
            client.call(ClientMethod::Initialize, serde_json::json!({}));
        assert_eq!(result, Err(ClientError::ServerShuttingDown));
    }
    let wire = serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Local App Server daemon is stopping"}}).to_string();
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([wire])));
    let result: Result<serde_json::Value, _> =
        client.call(ClientMethod::Initialize, serde_json::json!({}));
    assert!(matches!(result, Err(ClientError::Server { .. })));
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
        .set_session_directory_grant(SessionDirectoryGrantSetParams {
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
        r#"{"jsonrpc":"2.0","id":1,"result":null}"#.into(),
        r#"{"jsonrpc":"2.0","id":2,"result":{"revision":8,"hasErrors":false,"tokens":[],"foldingRanges":[],"symbols":[],"diagnostics":[]}}"#.into(),
    ])));

    client
        .open_syntax(SyntaxOpenParams {
            document_id: "model-1".into(),
            language: SyntaxLanguageDto::Rust,
            revision: 8,
            text: "fn main() {}\n".into(),
        })
        .unwrap();
    let result = client
        .analyze_syntax(SyntaxAnalyzeParams {
            document_id: "model-1".into(),
            revision: 8,
        })
        .unwrap();

    assert_eq!(result.revision, 8);
    assert!(!result.has_errors);
}

#[test]
fn client_reads_extension_packages_generation_through_the_typed_contract() {
    let mut client = AppServerClient::new(MockTransport(VecDeque::from([
        r#"{"jsonrpc":"2.0","id":1,"result":{"instanceId":"extension_packages-runtime-1","generation":7,"packages":[]}}"#.into(),
    ])));

    let result = client.list_installed_extension_packages().unwrap();

    assert_eq!(result.generation, 7);
    assert_eq!(result.instance_id, "extension_packages-runtime-1");
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
        format!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"terminalId":"terminal-1","profile":{{"profileId":"default","title":"Shell","isDefault":true}},"ready":{{"pid":1234,"cwd":"/workspace"}},"reconnect":{{"reconnectToken":"{}","reconnectGracePeriodMillis":30000}}}}}}"#, "a".repeat(64)),
        format!(r#"{{"jsonrpc":"2.0","id":2,"result":{{"terminalId":"terminal-1","ready":{{"pid":1234,"cwd":"/workspace"}},"reconnect":{{"reconnectToken":"{}","reconnectGracePeriodMillis":30000}}}}}}"#, "b".repeat(64)),
        r#"{"jsonrpc":"2.0","id":3,"result":null}"#.into(),
        r#"{"jsonrpc":"2.0","id":4,"result":null}"#.into(),
        r#"{"jsonrpc":"2.0","id":5,"result":{"terminalId":"terminal-1","chunks":[],"nextSequence":0,"outputGap":false,"commandEvents":[],"nextCommandSequence":0,"commandEventGap":false,"exited":false,"exitCode":null}}"#.into(),
        r#"{"jsonrpc":"2.0","id":6,"result":null}"#.into(),
    ])));

    let created = client
        .terminal_create(TerminalCreateParams {
            lifetime_token: None,
            auto_replies: None,
            dir_id: None,
            rows: 24,
            cols: 80,
            profile: TerminalProfileSelection::Default,
            lifecycle: TerminalLifecycle::Reconnectable,
            env: None,
            strict_env: None,
            cwd: None,
            execution: None,
        })
        .unwrap();
    assert_eq!(created.terminal_id, "terminal-1");
    let ready = TerminalProcessReady {
        pid: 1234,
        cwd: "/workspace".into(),
        shell_type: None,
        launch: None,
    };
    assert_eq!(created.ready, ready);
    let attached = client
        .terminal_attach(TerminalAttachParams {
            lifetime_token: None,
            dir_id: None,
            terminal_id: created.terminal_id.clone(),
            reconnect_token: created.reconnect.unwrap().reconnect_token,
            rows: 24,
            cols: 80,
        })
        .unwrap();
    assert_eq!(attached.reconnect.reconnect_token, "b".repeat(64));
    assert_eq!(attached.ready, ready);
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
            read_access: None,
            dir_id: None,
            session_directory: None,
            path: "src/main.rs".into(),
            encoding: None,
            auto_guess_encoding: None,
            candidate_guess_encodings: None,
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
            encoding: None,
            options: None,
        })
        .unwrap();

    assert_eq!(read.content, "fn main() {}\n");
    assert_eq!(binary.resource.resource_id, "resource_0000000000000001");
    assert_eq!(metadata.modified_at_millis, Some(41));
    assert_eq!(written.metadata.modified_at_millis, Some(42));
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

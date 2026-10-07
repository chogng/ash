use super::*;
use async_utils::CancellationSource;
use extension_api::ExtensionRegistry;
use memories::AddMemoryRequest;
use memories::DeleteMemoryRequest;
use memories::MemoryCitation;
use memories::MemoryId;
use memories::MemoryReadMode;
use memories::UpdateMemoryPolicyRequest;
use protocol::CommandId;
use protocol::ProjectId;
use protocol::ToolCallId;
use protocol::TurnId;
use serde_json::Value;
use serde_json::json;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use tools::EnvId;
use tools::ToolBinding;
use tools::ToolBindingId;
use tools::ToolContent;
use tools::ToolExecutionContext;
use tools::ToolExecutionOutcome;
use tools::ToolInvocation;
use tools::ToolOperationId;
use tools::ToolPayload;
use tools::ToolRegistryGeneration;
use tools::ToolRuntimeAuthority;
use tools::ToolRuntimeKey;

#[derive(Default)]
struct Scopes {
    allowed: Mutex<Vec<MemoryScope>>,
    calls: AtomicUsize,
    changes: AtomicUsize,
}

impl MemoryEventSink for Scopes {
    fn changed(&self, _: &MemoryScope, _: u64) {
        self.changes.fetch_add(1, Ordering::Relaxed);
    }
}

impl MemoryScopeProvider for Scopes {
    fn scopes(
        &self,
        session: &SessionId,
        thread: &ThreadId,
    ) -> Result<Vec<MemoryScope>, MemoryError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if session.as_str() == "session" && thread.as_str() == "thread" {
            Ok(self.allowed.lock().unwrap().clone())
        } else {
            Ok(Vec::new())
        }
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    memories: Arc<Memories>,
    scopes: Arc<Scopes>,
    registry: ExtensionRegistry,
    cancellation: CancellationSource,
    next_call: AtomicUsize,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let memories = Arc::new(Memories::new(Arc::new(
            state::SqliteMemoryStore::open(root.path().join("state.sqlite")).unwrap(),
        )));
        let scopes = Arc::new(Scopes::default());
        scopes.allowed.lock().unwrap().push(MemoryScope::Profile);
        let mut builder = ExtensionRegistryBuilder::new();
        install(
            &mut builder,
            memories.clone(),
            scopes.clone(),
            scopes.clone(),
        );
        Self {
            _root: root,
            memories,
            scopes,
            registry: builder.build(),
            cancellation: CancellationSource::new(),
            next_call: AtomicUsize::new(0),
        }
    }

    fn remember(&self, id: &str, scope: MemoryScope) -> MemoryCitation {
        let body = "Rust 记忆：先验证行为，再提交。";
        self.memories
            .add_user_memory(
                AddMemoryRequest {
                    command_id: CommandId::new(format!("add-{id}")).unwrap(),
                    memory_id: MemoryId::new(id).unwrap(),
                    scope: scope.clone(),
                    title: "Rust decision".into(),
                    body: body.into(),
                },
                &self.cancellation.token(),
            )
            .unwrap();
        MemoryCitation {
            memory_id: MemoryId::new(id).unwrap(),
            scope,
            revision: 1,
            start_byte: 0,
            end_byte: body.len() as u32,
        }
    }

    fn policy(&self, scope: MemoryScope, mode: MemoryReadMode) {
        let revision = self.memories.policy(&scope).unwrap().revision;
        self.memories
            .update_policy(UpdateMemoryPolicyRequest {
                command_id: CommandId::new(format!("policy-{}-{revision}", scope.storage_key()))
                    .unwrap(),
                scope,
                expected_revision: revision,
                automatic_read: mode,
                model_write: memories::MemoryWriteMode::Disabled,
            })
            .unwrap();
    }

    fn invocation(&self, name: &str, arguments: Value) -> (Arc<dyn ToolExecutor>, ToolInvocation) {
        let executor = self
            .registry
            .contribute_read_only_tools()
            .unwrap()
            .into_iter()
            .chain(
                self.registry
                    .contribute_capability_tools()
                    .unwrap()
                    .into_iter()
                    .map(|tool| tool.into_parts().0),
            )
            .find(|tool| tool.definition().name().as_str() == name)
            .unwrap();
        let definition = executor.definition();
        let binding = ToolBinding::new(
            ToolRegistryGeneration::new(1),
            ToolBindingId::new("memory@1").unwrap(),
            definition.name().clone(),
            definition.digest(),
            ToolRuntimeKey::new("memories").unwrap(),
        );
        let invocation = ToolInvocation::new(
            ToolOperationId::new("operation").unwrap(),
            ToolCallId::new(format!(
                "call-{}",
                self.next_call.fetch_add(1, Ordering::Relaxed)
            ))
            .unwrap(),
            TurnId::new("turn").unwrap(),
            binding,
            ToolPayload::FunctionArguments(arguments),
            ToolExecutionContext::new(
                EnvId::new("host").unwrap(),
                self.cancellation.token(),
                ToolRuntimeAuthority::Unrestricted,
            )
            .with_session_id(SessionId::new("session").unwrap())
            .with_thread_id(ThreadId::new("thread").unwrap()),
        );
        (executor, invocation)
    }

    fn call(&self, name: &str, arguments: Value) -> tools::ToolOutput {
        let (executor, invocation) = self.invocation(name, arguments);
        let ToolExecutionOutcome::Returned(output) =
            pollster::block_on(executor.execute(invocation))
        else {
            panic!("tool did not return");
        };
        output
    }
}

fn text(output: &tools::ToolOutput) -> &str {
    let ToolContent::Text(text) = &output.content()[0] else {
        panic!("expected text output");
    };
    text
}

#[test]
fn tools_search_and_read_only_current_opted_in_scopes() {
    let fixture = Fixture::new();
    let citation = fixture.remember("profile", MemoryScope::Profile);
    let project = MemoryScope::Project {
        project_id: ProjectId::new("unrelated").unwrap(),
    };
    let unrelated = fixture.remember("private", project.clone());
    fixture.policy(project, MemoryReadMode::FirstInvocation);
    assert_eq!(
        serde_json::from_str::<Value>(text(
            &fixture.call("memories-search", json!({"query":"Rust"}))
        ))
        .unwrap()["matches"],
        json!([])
    );
    fixture.policy(MemoryScope::Profile, MemoryReadMode::FirstInvocation);
    let searched = fixture.call("memories-search", json!({"query":"Rust"}));
    let data: Value = serde_json::from_str(text(&searched)).unwrap();
    assert_eq!(data["trust"], "untrusted-data");
    assert_eq!(data["matches"].as_array().unwrap().len(), 1);
    assert_eq!(
        data["matches"][0]["reference"],
        citation.reference().unwrap()
    );
    let read = fixture.call(
        "memories-read",
        json!({"reference":data["matches"][0]["reference"]}),
    );
    assert!(read.status() == tools::ToolOutputStatus::Success);
    assert_eq!(
        serde_json::from_str::<Value>(text(&read)).unwrap()["memory"],
        data["matches"][0]["memory"]
    );
    let denied = fixture.call(
        "memories-read",
        json!({"reference":unrelated.reference().unwrap()}),
    );
    assert!(denied.status() == tools::ToolOutputStatus::Error);
    assert!(!text(&denied).contains("先验证"));
}

#[test]
fn memories_read_returns_the_complete_body_needed_for_merging() {
    let fixture = Fixture::new();
    let body = "merge ".repeat(900);
    fixture
        .memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("enable-long-memory").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Enabled,
        })
        .unwrap();
    let saved = fixture.call(
        "memories-save",
        json!({
            "scope":"profile",
            "title":"Long-lived decisions",
            "body":body.clone(),
            "expected_revision":0
        }),
    );
    assert_eq!(saved.status(), tools::ToolOutputStatus::Success);

    let searched: Value = serde_json::from_str(text(
        &fixture.call("memories-search", json!({"query":"merge"})),
    ))
    .unwrap();
    assert_eq!(
        searched["matches"][0]["memory"]["body"]
            .as_str()
            .unwrap()
            .len(),
        4096
    );

    let read: Value = serde_json::from_str(text(&fixture.call(
        "memories-read",
        json!({"reference":searched["matches"][0]["reference"]}),
    )))
    .unwrap();
    assert_eq!(read["memory"]["body"], body);
    assert_eq!(read["memory"]["citation"]["startByte"], 0);
    assert_eq!(read["memory"]["citation"]["endByte"], body.len() as u64);
}

#[test]
fn reads_recheck_scope_consent_revision_and_deletion() {
    let fixture = Fixture::new();
    let citation = fixture.remember("profile", MemoryScope::Profile);
    fixture.policy(MemoryScope::Profile, MemoryReadMode::FirstInvocation);
    let read = |citation: &MemoryCitation| {
        fixture.call(
            "memories-read",
            json!({"reference":citation.reference().unwrap()}),
        )
    };
    assert!(read(&citation).status() == tools::ToolOutputStatus::Success);
    fixture.scopes.allowed.lock().unwrap().clear();
    assert!(read(&citation).status() == tools::ToolOutputStatus::Error);
    fixture
        .scopes
        .allowed
        .lock()
        .unwrap()
        .push(MemoryScope::Profile);
    fixture.policy(MemoryScope::Profile, MemoryReadMode::Disabled);
    assert!(read(&citation).status() == tools::ToolOutputStatus::Error);
    fixture.policy(MemoryScope::Profile, MemoryReadMode::FirstInvocation);
    assert!(
        text(&read(&MemoryCitation {
            revision: 2,
            ..citation.clone()
        }))
        .contains("revision conflict")
    );
    assert!(
        text(&read(&MemoryCitation {
            start_byte: 6,
            ..citation.clone()
        }))
        .contains("UTF-8")
    );
    fixture
        .memories
        .delete(DeleteMemoryRequest {
            command_id: CommandId::new("delete").unwrap(),
            memory_id: citation.memory_id.clone(),
            scope: citation.scope.clone(),
            expected_revision: 1,
        })
        .unwrap();
    assert!(text(&read(&citation)).contains("not found"));
}

#[test]
fn invalid_cancelled_or_unbound_invocations_do_not_resolve_authority() {
    let fixture = Fixture::new();
    for (name, arguments) in [
        ("memories-search", json!({"query":"  "})),
        ("memories-search", json!({"query":"x".repeat(513)})),
        (
            "memories-search",
            json!({"query":"Rust", "session_id":"other"}),
        ),
        ("memories-read", json!({"reference":"memory:invalid"})),
    ] {
        let (executor, invocation) = fixture.invocation(name, arguments);
        assert!(matches!(
            pollster::block_on(executor.execute(invocation)),
            ToolExecutionOutcome::NotStarted(_)
        ));
    }
    let (executor, invocation) = fixture.invocation("memories-search", json!({"query":"Rust"}));
    let unbound = ToolInvocation::new(
        invocation.operation_id().clone(),
        invocation.call_id().clone(),
        invocation.turn_id().clone(),
        invocation.binding().clone(),
        invocation.payload().clone(),
        ToolExecutionContext::new(
            EnvId::new("host").unwrap(),
            fixture.cancellation.token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    );
    assert!(matches!(
        pollster::block_on(executor.execute(unbound)),
        ToolExecutionOutcome::NotStarted(_)
    ));
    fixture.cancellation.cancel();
    assert!(matches!(
        pollster::block_on(executor.execute(invocation)),
        ToolExecutionOutcome::NotStarted(_)
    ));
    assert_eq!(fixture.scopes.calls.load(Ordering::Relaxed), 0);
}

#[test]
fn context_and_tools_share_current_authority_and_reinstallation_replaces_both() {
    let mut fixture = Fixture::new();
    fixture.remember("profile", MemoryScope::Profile);
    fixture.policy(MemoryScope::Profile, MemoryReadMode::FirstInvocation);
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = TurnId::new("turn").unwrap();
    let request = ContextSourceRequest {
        session_id: &session,
        thread_id: &thread,
        turn_id: &turn,
        query: "Rust",
    };
    assert_eq!(
        fixture
            .registry
            .collect_context(&request, &fixture.cancellation.token())
            .unwrap()
            .len(),
        1
    );
    let other = SessionId::new("other").unwrap();
    assert!(
        fixture
            .registry
            .collect_context(
                &ContextSourceRequest {
                    session_id: &other,
                    ..request
                },
                &fixture.cancellation.token()
            )
            .unwrap()
            .is_empty()
    );
    let mut builder = ExtensionRegistryBuilder::from_registry(&fixture.registry);
    install(
        &mut builder,
        fixture.memories.clone(),
        Arc::new(Scopes::default()),
        fixture.scopes.clone(),
    );
    fixture.registry = builder.build();
    assert_eq!(
        fixture.registry.contribute_read_only_tools().unwrap().len(),
        3
    );
    assert!(
        fixture
            .registry
            .collect_context(&request, &fixture.cancellation.token())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        serde_json::from_str::<Value>(text(
            &fixture.call("memories-search", json!({"query":"Rust"}))
        ))
        .unwrap()["matches"],
        json!([])
    );
}

#[test]
fn model_save_uses_host_identity_and_publishes_only_committed_changes() {
    let fixture = Fixture::new();
    let args = json!({"scope":"profile","title":"Rust choice","body":"Use Rust for this tool","expected_revision":0});
    let denied = fixture.call("memories-save", args.clone());
    assert_eq!(denied.status(), tools::ToolOutputStatus::Error);
    fixture
        .memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("enable-write").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Enabled,
        })
        .unwrap();
    let scopes: Value =
        serde_json::from_str(text(&fixture.call("memories-scopes", json!({})))).unwrap();
    assert_eq!(scopes["scopes"][0]["policy"]["modelWrite"], "enabled");
    let (executor, invocation) = fixture.invocation("memories-save", args);
    let execute = || match pollster::block_on(executor.execute(invocation.clone())) {
        ToolExecutionOutcome::Returned(output) => output,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let saved: Value = serde_json::from_str(text(&execute())).unwrap();
    assert_eq!(
        saved["memory"]["memory"]["source"]["model"]["threadId"],
        "thread"
    );
    assert_eq!(saved["memory"]["disposition"], "committed");
    let replayed: Value = serde_json::from_str(text(&execute())).unwrap();
    assert_eq!(replayed["memory"]["disposition"], "replayed");
    assert_eq!(fixture.scopes.changes.load(Ordering::Relaxed), 1);
    fixture
        .memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("revoke-write").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 1,
            automatic_read: MemoryReadMode::FirstInvocation,
            model_write: memories::MemoryWriteMode::Disabled,
        })
        .unwrap();
    assert_eq!(execute().status(), tools::ToolOutputStatus::Error);
    assert_eq!(fixture.scopes.changes.load(Ordering::Relaxed), 1);
}

#[test]
fn cancelling_model_save_while_sqlite_is_locked_prevents_the_write() {
    let fixture = Fixture::new();
    fixture
        .memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("enable-write").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: MemoryReadMode::Disabled,
            model_write: memories::MemoryWriteMode::Enabled,
        })
        .unwrap();
    let lock = state::open_sqlite_database(
        &fixture._root.path().join("state.sqlite"),
        state::SqliteDurability::Durable,
    )
    .unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before_scope_resolution = fixture.scopes.calls.load(Ordering::Relaxed);
    let (executor, invocation) = fixture.invocation(
        "memories-save",
        json!({
            "scope":"profile",
            "title":"Queued write",
            "body":"Must not be committed after cancellation",
            "expected_revision":0
        }),
    );
    let worker = std::thread::spawn(move || pollster::block_on(executor.execute(invocation)));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while fixture.scopes.calls.load(Ordering::Relaxed) == before_scope_resolution {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(!worker.is_finished());

    fixture.cancellation.cancel();
    lock.execute_batch("COMMIT").unwrap();
    let ToolExecutionOutcome::Returned(output) = worker.join().unwrap() else {
        panic!("unexpected tool outcome");
    };
    assert_eq!(output.status(), tools::ToolOutputStatus::Error);
    assert!(text(&output).contains("cancelled"));
    assert!(
        fixture
            .memories
            .list(memories::ListMemoriesRequest {
                scope: MemoryScope::Profile,
                cursor: None,
                limit: 10,
            })
            .unwrap()
            .memories
            .is_empty()
    );
    assert_eq!(fixture.scopes.changes.load(Ordering::Relaxed), 0);
}

#[test]
fn automatic_saving_instructions_follow_current_consent_without_loading_memory_content() {
    let mut fixture = Fixture::new();
    fixture.remember("private", MemoryScope::Profile);
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = TurnId::new("turn").unwrap();
    let collect = |registry: &ExtensionRegistry| {
        registry
            .contribute_turn_input(extension_api::TurnInputContext::for_session(
                &session,
                &thread,
                &turn,
                &[],
            ))
            .unwrap()
    };
    assert!(collect(&fixture.registry).is_empty());
    fixture
        .memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("enable-auto-save").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 0,
            automatic_read: MemoryReadMode::Disabled,
            model_write: memories::MemoryWriteMode::Enabled,
        })
        .unwrap();
    let fragments = collect(&fixture.registry);
    assert_eq!(fragments.len(), 1);
    assert_eq!(
        fragments[0].layer(),
        extension_api::PromptFragmentLayer::Product
    );
    assert!(
        fragments[0]
            .body()
            .contains("without waiting for a separate save request")
    );
    assert!(!fragments[0].body().contains("先验证"));
    assert!(
        fixture
            .registry
            .contribute_turn_input(extension_api::TurnInputContext::new(&thread, &turn, &[]))
            .unwrap()
            .is_empty()
    );
    let other = SessionId::new("other").unwrap();
    assert!(
        fixture
            .registry
            .contribute_turn_input(extension_api::TurnInputContext::for_session(
                &other,
                &thread,
                &turn,
                &[]
            ))
            .unwrap()
            .is_empty()
    );
    let mut builder = ExtensionRegistryBuilder::from_registry(&fixture.registry);
    install(
        &mut builder,
        fixture.memories.clone(),
        fixture.scopes.clone(),
        fixture.scopes.clone(),
    );
    fixture.registry = builder.build();
    assert_eq!(collect(&fixture.registry).len(), 1);
    fixture
        .memories
        .update_policy(UpdateMemoryPolicyRequest {
            command_id: CommandId::new("disable-auto-save").unwrap(),
            scope: MemoryScope::Profile,
            expected_revision: 1,
            automatic_read: MemoryReadMode::Disabled,
            model_write: memories::MemoryWriteMode::Disabled,
        })
        .unwrap();
    assert!(collect(&fixture.registry).is_empty());
}

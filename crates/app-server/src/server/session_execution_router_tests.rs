use super::*;
use ash_async_utils::CancellationSource;
use ash_protocol::CommandId;
use ash_protocol::TurnId;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct WorkspaceSource(AtomicUsize);

impl ContextSource for WorkspaceSource {
    fn collect(
        &self,
        _: &ContextSourceRequest<'_>,
        _: &CancellationToken,
    ) -> Result<Vec<ContextEvidence>, CoreError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(Vec::new())
    }
}

#[test]
fn workspace_retrieval_follows_the_persisted_session_owner() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        ash_core::InMemoryThreadStore::default(),
    )));
    let workspace = Arc::new(WorkspaceSource::default());
    let router = SessionExecutionRouter::new(&threads);
    assert!(matches!(
        router.allows_workspace(&SessionId::new("unknown-session").unwrap()),
        Err(CoreError::NotFound(_))
    ));
    let source = router.workspace_evidence(workspace.clone());
    let turn_id = TurnId::new("turn").unwrap();
    let cancellation = CancellationSource::new();
    let workspace_target = || {
        Some(SessionExecutionTarget::Local {
            root: std::env::temp_dir(),
        })
    };
    for (title, kind, target, expected_calls) in [
        ("chat", SessionKind::Chat, workspace_target(), 0),
        ("code", SessionKind::Code, workspace_target(), 1),
        ("host-scoped-code", SessionKind::Code, None, 2),
    ] {
        let root = threads
            .start_thread(
                &ash_core::NoThreadWorktreeBinder,
                core_api::StartThreadRequest {
                    kind,
                    agent_id: None,
                    agent: None,
                    command_id: CommandId::new(title).unwrap(),
                    title: title.into(),
                    branch_name: None,
                    worktree_start: None,
                    execution_target: target,
                },
            )
            .unwrap();
        let branch = threads
            .create_branch(
                &ash_core::NoThreadWorktreeBinder,
                core_api::CreateBranchRequest {
                    agent_id: None,
                    command_id: CommandId::new(format!("{title}-branch")).unwrap(),
                    session_id: root.session_id,
                    title: format!("{title} branch"),
                },
            )
            .unwrap();
        source
            .collect(
                &ContextSourceRequest {
                    session_id: &branch.session_id,
                    thread_id: &branch.thread_id,
                    turn_id: &turn_id,
                    query: "source lookup",
                },
                &cancellation.token(),
            )
            .unwrap();
        assert_eq!(workspace.0.load(Ordering::Relaxed), expected_calls);
    }
}

#[test]
fn creation_and_approval_share_session_defaults() {
    let chat = SessionExecutionRoute::new(SessionKind::Chat, None);
    assert_eq!(
        chat.approval_mode(None, || Ok(ApprovalMode::Auto)).unwrap(),
        ApprovalMode::Manual
    );
    assert_eq!(
        chat.approval_mode(Some(ApprovalMode::Auto), || unreachable!())
            .unwrap(),
        ApprovalMode::Auto
    );
    assert_eq!(
        SessionExecutionRoute::admit_creation(None, None).unwrap(),
        None
    );
    let code = SessionExecutionRoute::new(SessionKind::Code, None);
    assert_eq!(
        code.approval_mode(None, || Ok(ApprovalMode::Auto)).unwrap(),
        ApprovalMode::Auto
    );
}

#[test]
fn explicit_directory_binding_enables_and_clears_workspace_for_a_chat() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        ash_core::InMemoryThreadStore::default(),
    )));
    let chat = threads
        .start_thread(
            &ash_core::NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                kind: SessionKind::Chat,
                agent_id: None,
                agent: None,
                command_id: CommandId::new("chat-directory-toggle").unwrap(),
                title: "Chat".into(),
                branch_name: None,
                worktree_start: None,
                execution_target: None,
            },
        )
        .unwrap();
    let router = SessionExecutionRouter::new(&threads);
    assert!(!router.allows_workspace(&chat.session_id).unwrap());
    threads
        .change_session_directory(
            &chat.session_id,
            Some(&std::env::temp_dir()),
            CommandId::new("enable-workspace").unwrap(),
            |_, _| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
    assert!(router.allows_workspace(&chat.session_id).unwrap());
    threads
        .change_session_directory(
            &chat.session_id,
            None,
            CommandId::new("disable-workspace").unwrap(),
            |_, _| Ok(()),
            |_| Ok(()),
        )
        .unwrap();
    assert!(!router.allows_workspace(&chat.session_id).unwrap());
    let saved = threads.read_thread(&chat.thread_id).unwrap();
    assert_eq!(saved.session_id, chat.session_id);
    assert_eq!(saved.kind, SessionKind::Chat);
    assert_eq!(saved.title, chat.title);
}

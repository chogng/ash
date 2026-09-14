use super::Command;
use super::CommandRequest;
use super::prepare_command;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::ChatSubmission;
use ash_protocol::ApprovalMode;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

#[test]
fn resume_request_preserves_the_selected_session_and_thread() {
    let thread_id = ThreadId::new("thread-2").unwrap();
    let request = prepare_command(
        ApprovalMode::AskPermissions,
        Command::Resume {
            session_id: "session-1".into(),
            preferred_thread_id: Some(thread_id.clone()),
        },
    );

    assert!(matches!(
        request,
        CommandRequest::Resume {
            session_id,
            preferred_thread_id: Some(preferred_thread_id),
        } if session_id == "session-1" && preferred_thread_id == thread_id
    ));
}

#[test]
fn archive_request_preserves_all_selected_sessions() {
    let first = SessionId::new("session-1").unwrap();
    let second = SessionId::new("session-2").unwrap();
    let request = prepare_command(
        ApprovalMode::AskPermissions,
        Command::Archive {
            session_ids: vec![first.clone(), second.clone()],
        },
    );

    assert!(matches!(
        request,
        CommandRequest::Archive { session_ids }
            if session_ids == vec![first, second]
    ));
}

#[test]
fn manager_request_preserves_submission_and_approval_mode() {
    let submission = ChatSubmission {
        display_text: "investigate the failure".into(),
        input: vec![ChatInputItem::Text("investigate the failure".into())],
    };
    let request = prepare_command(
        ApprovalMode::BypassPermissions,
        Command::CreateAndEnter {
            submission: submission.clone(),
        },
    );

    assert!(matches!(
        request,
        CommandRequest::CreateAndEnter {
            submission: prepared,
            approval_mode: ApprovalMode::BypassPermissions,
        } if prepared == submission
    ));
}

#[test]
fn switch_request_preserves_the_selected_thread() {
    let thread_id = ThreadId::new("thread-2").unwrap();
    let request = prepare_command(
        ApprovalMode::AskPermissions,
        Command::SwitchThread {
            thread_id: thread_id.clone(),
        },
    );

    assert!(matches!(
        request,
        CommandRequest::SwitchThread { thread_id: prepared } if prepared == thread_id
    ));
}


#[test]
fn fork_command_preserves_selection_and_starts_only_when_prompted() {
    use super::ForkStatus;
    use super::SessionCompletion;
    use crate::app::App;
    use crate::app::AppCommand;
    use ash_app_server_client::{AppServerSession, InProcessClientOptions};
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let _guard = crate::test_support::in_process_test_guard();
    let root = tempfile::tempdir().unwrap();
    let session = AppServerSession::start_embedded(
        InProcessClientOptions::new(
            root.path(),
            ClientInfo {
                name: "fork-flow-test".into(),
                version: "1".into(),
            },
        )
        .with_model_operation_client(std::sync::Arc::new(OfflineModel)),
    )
    .unwrap();
    let mut client = session.client();
    let source = super::ActiveConversation::start(&mut client, "original".into()).unwrap();
    let (subscription, _, _) =
        super::ThreadSubscription::start(&mut client, source.session_id(), source.thread_id())
            .unwrap();
    let current = super::Conversation {
        conversation: source,
        subscription,
    };
    for (prompt, snapshot) in [
        ("", "fork_waiting_notice"),
        ("investigate independently", "fork_background_notice"),
    ] {
        let mut app = App::new();
        let command_text = if prompt.is_empty() {
            "/fork".to_owned()
        } else {
            format!("/fork {prompt}")
        };
        app.insert_text(&command_text);
        let Some(AppCommand::Sessions(command @ Command::Fork { .. })) =
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        else {
            panic!("fork must use Session commands")
        };
        assert_eq!(
            command.command_line().as_deref(),
            Some(command_text.as_str())
        );
        let completion = prepare_command(ApprovalMode::BypassPermissions, command)
            .execute(client.clone(), Some(current.clone()));
        let SessionCompletion::Forked {
            command,
            result: Ok(result),
        } = completion
        else {
            panic!("fork must return a structured completion")
        };
        let copied_id = result.session_id.clone();
        assert_ne!(&copied_id, current.conversation.session_id());
        assert!(matches!(
            (&result.status, prompt.is_empty()),
            (ForkStatus::Waiting, true) | (ForkStatus::Started, false)
        ));
        app.update(result.into_event(command));
        let messages = app.messages();
        let message = messages.last().unwrap();
        let text = format!("{}\n{}", message.text(), message.detail().unwrap())
            .replace(copied_id.as_str(), "SESSION");
        insta::assert_snapshot!(snapshot, text);
        let copied =
            super::ActiveConversation::open(&mut client, copied_id.as_str(), None).unwrap();
        let thread = client
            .read_session_thread(SessionThreadReadParams {
                session_id: copied_id,
                thread_id: copied.thread_id().clone(),
                history: None,
            })
            .unwrap()
            .thread;
        if prompt.is_empty() {
            assert!(thread.turns.is_empty());
        } else {
            assert_eq!(thread.turns.len(), 1);
            assert_eq!(
                thread.turns[0].approval_mode,
                ApprovalMode::BypassPermissions
            );
            assert!(thread.turns[0].items.iter().any(|item| matches!(item, ash_protocol::ThreadItem::UserMessage { text, .. } if text == prompt)));
        }
        let original = client
            .read_session_thread(SessionThreadReadParams {
                session_id: current.conversation.session_id().clone(),
                thread_id: current.conversation.thread_id().clone(),
                history: None,
            })
            .unwrap()
            .thread;
        assert!(original.turns.is_empty());
    }
}

struct OfflineModel;
impl ash_client::OperationClient for OfflineModel {
    fn execute(&self, _: &ash_client::ClientRequest) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
        Err(ash_client::ClientError::Transport("offline test model".into()))
    }
}

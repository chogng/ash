use super::ActiveConversation;
use super::App;
use super::AppCommand;
use super::Status;
use super::apply_active_turn_snapshot;
use crate::models::set_model;
use crate::sessions::Event as SessionEvent;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadRequestScope;
use crate::thread::submit_prompt;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tempfile::tempdir;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::InProcessClientOptions;
use ash_app_server_client::InProcessTransport;
use ash_app_server_client::ProviderApiKeySetRequest;
use ash_app_server_client::start_in_process_client;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::config::ProviderConfigDto;
use ash_app_server_protocol::protocol::config::ProviderConfigureParams;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::TurnStatus;

const FIRST_PROMPT: &str = "请正常回复，并展示多行输出。";
const FIRST_PARTIAL: &str = "你好！普通对话";
const FIRST_RESPONSE: &str = concat!(
    "你好！普通对话已经连通。\n\n",
    "```rust\n",
    "fn main() { println!(\"ash\"); }\n",
    "```\n\n",
    "- 流式输出正常\n",
    "- 多行文本正常",
);
const SECOND_PROMPT: &str = "第二轮还能看到上一轮吗？";
const SECOND_RESPONSE: &str = "可以。第二轮回复已完成，并保留了上一轮上下文。";

#[test]
fn normal_conversation_streams_completes_and_preserves_multi_turn_context() {
    let _guard = crate::test_support::in_process_test_guard();
    let state_root = tempdir().unwrap();
    let model = Arc::new(ScriptedModel::default());
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            state_root.path(),
            ClientInfo {
                name: "ash-tui-conversation-test".into(),
                version: "1".into(),
            },
        )
        .with_capabilities(crate::client_capabilities())
        .with_model_operation_client(model.clone())
        .without_built_in_skills(),
    )
    .unwrap();
    let revision = client.read_config().unwrap().revision;
    client
        .configure_provider(ProviderConfigureParams {
            command_id: CommandId::new("configure-openai-conversation-test").unwrap(),
            expected_revision: revision,
            config: ProviderConfigDto {
                custom: None,
                provider: "openai".into(),
                base_url: None,
                max_output_tokens: None,
                model_context: Default::default(),
            },
        })
        .unwrap();
    client
        .set_provider_api_key(ProviderApiKeySetRequest::new(
            "openai".into(),
            "test-api-key".into(),
        ))
        .unwrap();
    set_model(&mut client, "openai/gpt-5.6").unwrap();
    let mut conversation =
        ActiveConversation::start(&mut client, "Conversation flow".into()).unwrap();
    let mut app = app_for_conversation(&mut client, &conversation);

    let first = submit_from_input(&mut app, FIRST_PROMPT);
    crate::tui_assert_snapshot!("conversation_submitted", render(&app));
    let started = submit_prompt(
        &mut client,
        request_scope(&conversation),
        first,
        ApprovalMode::AskPermissions,
    )
    .unwrap();
    conversation.set_thread_sequence(started.sequence);
    app.set_active_turn(started.turn_id);

    model.wait_for_first_delta();
    let streaming = read_thread(&mut client, &conversation);
    app.update(ThreadEvent::TranscriptSnapshotReceived(
        streaming.transcript,
    ));
    apply_active_turn_snapshot(&mut app, &streaming.thread.turns);
    assert!(
        app.messages()
            .iter()
            .any(|message| message.text() == FIRST_PROMPT)
    );
    assert!(
        app.messages()
            .iter()
            .any(|message| message.text().contains(FIRST_PARTIAL))
    );
    assert_eq!(app.status(), &Status::Working);
    crate::tui_assert_snapshot!("conversation_streaming", render(&app));

    model.release_first_response();
    let completed = wait_for_completed_thread(&mut client, &conversation, 1);
    conversation.set_thread_sequence(completed.thread.sequence);
    app.update(ThreadEvent::TranscriptSnapshotReceived(
        completed.transcript,
    ));
    apply_active_turn_snapshot(&mut app, &completed.thread.turns);
    let completed_frame = render(&app);
    assert!(completed_frame.contains("fn main()"));
    assert_eq!(app.latest_agent_response(), Some(FIRST_RESPONSE));
    assert_eq!(app.status(), &Status::Ready);
    crate::tui_assert_snapshot!("conversation_completed", render(&app));

    let second = submit_from_input(&mut app, SECOND_PROMPT);
    let started = submit_prompt(
        &mut client,
        request_scope(&conversation),
        second,
        ApprovalMode::AskPermissions,
    )
    .unwrap();
    conversation.set_thread_sequence(started.sequence);
    app.set_active_turn(started.turn_id);
    let completed = wait_for_completed_thread(&mut client, &conversation, 2);
    app.update(ThreadEvent::TranscriptSnapshotReceived(
        completed.transcript,
    ));
    apply_active_turn_snapshot(&mut app, &completed.thread.turns);

    assert!(
        app.messages()
            .iter()
            .any(|message| message.text() == SECOND_PROMPT)
    );
    assert_eq!(app.latest_agent_response(), Some(SECOND_RESPONSE));
    assert_eq!(app.status(), &Status::Ready);
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let second_request: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
    assert!(json_contains_text(&second_request, FIRST_PROMPT));
    assert!(json_contains_text(&second_request, FIRST_RESPONSE));
    assert!(json_contains_text(&second_request, SECOND_PROMPT));
    drop(requests);
    crate::tui_assert_snapshot!("conversation_second_turn", render(&app));
}

fn app_for_conversation(
    client: &mut AppServerClient<InProcessTransport>,
    conversation: &ActiveConversation,
) -> App {
    let session = client
        .read_session(SessionReadParams {
            session_id: conversation.session_id().clone(),
        })
        .unwrap()
        .session;
    let initial = read_thread(client, conversation);
    let mut app = App::new();
    app.update(ThreadEvent::ContextChanged {
        session_id: conversation.session_id().clone(),
        thread_id: conversation.thread_id().clone(),
    });
    app.update(SessionEvent::CatalogReceived(vec![session]));
    app.update(ThreadEvent::TranscriptSnapshotReceived(initial.transcript));
    app
}

fn submit_from_input(app: &mut App, prompt: &str) -> crate::thread::composer::ChatSubmission {
    app.insert_text(prompt);
    let Some(AppCommand::Thread(ThreadCommand::SubmitTurn { submission })) =
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("normal input did not produce SubmitTurn");
    };
    submission
}

fn request_scope(conversation: &ActiveConversation) -> ThreadRequestScope {
    ThreadRequestScope::new(
        conversation.session_id(),
        conversation.thread_id(),
        conversation.thread_sequence(),
    )
}

fn read_thread(
    client: &mut AppServerClient<InProcessTransport>,
    conversation: &ActiveConversation,
) -> ash_app_server_protocol::protocol::session::SessionThreadReadResult {
    client
        .read_session_thread(SessionThreadReadParams {
            session_id: conversation.session_id().clone(),
            thread_id: conversation.thread_id().clone(),
            history: None,
        })
        .unwrap()
}

fn wait_for_completed_thread(
    client: &mut AppServerClient<InProcessTransport>,
    conversation: &ActiveConversation,
    expected_turns: usize,
) -> ash_app_server_protocol::protocol::session::SessionThreadReadResult {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = read_thread(client, conversation);
        if snapshot.thread.turns.len() == expected_turns
            && snapshot
                .thread
                .turns
                .last()
                .is_some_and(|turn| turn.status == TurnStatus::Completed)
        {
            return snapshot;
        }
        assert!(Instant::now() < deadline, "Turn completion timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn render(app: &App) -> String {
    let backend = TestBackend::new(100, 32);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    (0..32)
        .map(|row| {
            (0..100)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn json_contains_text(value: &serde_json::Value, expected: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value.contains(expected),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_contains_text(value, expected)),
        serde_json::Value::Object(values) => values
            .values()
            .any(|value| json_contains_text(value, expected)),
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            false
        }
    }
}

#[derive(Default)]
struct ScriptedModel {
    calls: AtomicUsize,
    first_response: ResponseGate,
    requests: Mutex<Vec<String>>,
}

impl ScriptedModel {
    fn wait_for_first_delta(&self) {
        self.first_response.wait_until_entered();
    }

    fn release_first_response(&self) {
        self.first_response.release();
    }
}

impl OperationClient for ScriptedModel {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("the configured OpenAI model must use streaming execution")
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.requests
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(request.body()).into_owned());
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            emit_delta(sink, FIRST_PARTIAL)?;
            self.first_response.enter_and_wait();
            emit_delta(sink, &FIRST_RESPONSE[FIRST_PARTIAL.len()..])?;
            emit_completed(sink, FIRST_RESPONSE)?;
        } else {
            emit_delta(sink, SECOND_RESPONSE)?;
            emit_completed(sink, SECOND_RESPONSE)?;
        }
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

fn emit_delta(sink: &mut dyn OperationStreamSink, text: &str) -> Result<(), ClientError> {
    let event = serde_json::json!({
        "type": "response.output_text.delta",
        "delta": text,
    });
    sink.emit(format!("event: response.output_text.delta\ndata: {event}\n\n").as_bytes())
}

fn emit_completed(sink: &mut dyn OperationStreamSink, text: &str) -> Result<(), ClientError> {
    let event = serde_json::json!({
        "type": "response.completed",
        "response": {
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": text }],
            }],
        },
    });
    sink.emit(format!("event: response.completed\ndata: {event}\n\n").as_bytes())
}

#[derive(Default)]
struct ResponseGate {
    state: Mutex<ResponseGateState>,
    changed: Condvar,
}

#[derive(Default)]
struct ResponseGateState {
    entered: bool,
    released: bool,
}

impl ResponseGate {
    fn enter_and_wait(&self) {
        let mut state = self.state.lock().unwrap();
        state.entered = true;
        self.changed.notify_all();
        while !state.released {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn wait_until_entered(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut state = self.state.lock().unwrap();
        while !state.entered {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "first model delta timed out");
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            assert!(!timeout.timed_out(), "first model delta timed out");
            state = next;
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.released = true;
        self.changed.notify_all();
    }
}

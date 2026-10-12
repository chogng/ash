use super::*;
use ash_async_utils::CancellationToken;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;
use ash_protocol::ToolCall;
use core_api::CoreError;
use core_api::ModelService;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

struct ApplicationModel {
    calls: AtomicUsize,
    output: Mutex<Vec<Value>>,
    tools: Vec<(&'static str, Value)>,
}
impl ModelService for ApplicationModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.output
            .lock()
            .unwrap()
            .push(serde_json::to_value(&request.input).unwrap());
        assert!(
            request
                .tools
                .iter()
                .any(|tool| tool.name.as_str() == "create_thread")
        );
        let index = self.calls.fetch_add(1, Ordering::Relaxed);
        let output = if let Some((name, arguments)) = self.tools.get(index) {
            vec![ResponseItem::ToolCall(ToolCall {
                id: ash_protocol::ToolCallId::new(format!("app-call-{index}")).unwrap(),
                name: ash_protocol::ToolName::new(*name).unwrap(),
                arguments: arguments.clone(),
            })]
        } else {
            vec![ResponseItem::Text("done".into())]
        };
        Ok(ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason: if index < self.tools.len() {
                StopReason::ToolUse
            } else {
                StopReason::Completed
            },
        })
    }
}
fn start(server: &AppServer, owner: &mut ConnectionState) -> (String, String) {
    let session = super::create_session(server, owner, 2, "app-test-session");
    let session_id = session["result"]["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let thread = super::create_thread(server, owner, 3, "app-test-thread", &session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"]
        .as_str()
        .unwrap()
        .to_string();
    let result = super::call(
        server,
        owner,
        json!({"jsonrpc":"2.0","id":4,"method":"session/request","params":{"commandId":"app-test-turn","sessionId":session_id,"request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"input":[{"type":"text","text":"Create a separate task and organize it"}]}}}),
    );
    assert!(result.get("error").is_none(), "{result}");
    (session_id, thread_id)
}
fn model(tools: Vec<(&'static str, Value)>) -> Arc<ApplicationModel> {
    Arc::new(ApplicationModel {
        calls: AtomicUsize::new(0),
        output: Mutex::new(Vec::new()),
        tools,
    })
}

#[test]
fn application_tools_execute_from_model_through_core_and_existing_session_owner() {
    let model = model(vec![
        (
            "create_thread",
            json!({"title":"Created by application tool"}),
        ),
        ("list_threads", json!({"archived":false})),
        (
            "automation_update",
            json!({"mode":"list","id":null,"expected_revision":null,"definition":null,"status":null,"run_id":null}),
        ),
    ]);
    let server = super::server_with_model(model.clone()).into_shared();
    let mut owner = server.connection();
    super::initialize(&server, &mut owner);
    let (_, thread) = start(&server, &mut owner);
    super::wait_for_latest_turn(&server, &thread, ash_protocol::TurnStatus::Completed);
    let list = super::call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":5,"method":"session/list","params":{}}),
    );
    let sessions: Vec<ash_protocol::Session> =
        serde_json::from_value(list["result"]["sessions"].clone()).unwrap();
    assert_eq!(
        sessions
            .iter()
            .filter(|session| session.title == "Created by application tool")
            .count(),
        1
    );
    let input = serde_json::to_string(&*model.output.lock().unwrap()).unwrap();
    assert!(input.contains("Created by application tool"), "{input}");
    // Optional product services report an explicit error rather than a fabricated success.
    assert!(input.contains("AutomationUnavailable"), "{input}");
}

#[test]
fn application_ui_requests_stay_on_the_initiating_connection_and_fail_on_disconnect() {
    let model = model(vec![
        ("create_sidebar_section", json!({"name":"Review"})),
        ("list_sidebar_sections", json!({})),
        ("list_sidebar_sections", json!({})),
    ]);
    let server = super::server_with_model(model.clone()).into_shared();
    let mut owner = server.product_host_connection();
    let mut other = server.product_host_connection();
    let capability = json!({"appTools":{"version":1,"agents":true,"desktop":true}});
    super::initialize_with_capabilities(&server, &mut owner, capability.clone());
    super::initialize_with_capabilities(&server, &mut other, capability);
    let (_, thread) = start(&server, &mut owner);
    let deadline = Instant::now() + Duration::from_secs(3);
    let request = loop {
        let messages = server
            .connection_notifications(&owner)
            .drain()
            .into_iter()
            .map(|message| serde_json::from_str::<Value>(&message).unwrap())
            .collect::<Vec<_>>();
        if let Some(request) = messages
            .into_iter()
            .find(|message| message["method"] == "app/request")
        {
            break request;
        }
        assert!(Instant::now() < deadline, "host request was not dispatched");
        std::thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(request["params"]["threadId"], thread);
    assert_eq!(
        request["params"]["operation"],
        json!({"type":"createSection","name":"Review"})
    );
    let response = json!({"jsonrpc":"2.0","id":request["id"],"result":{"json":"{\"sectionId\":\"review\",\"name\":\"Review\",\"sessionIds\":[]}"}});
    assert!(
        server
            .client_host
            .handle_response(other.connection_id, response.clone())
            .is_err()
    );
    assert!(
        server
            .client_host
            .handle_response(owner.connection_id, response.clone())
            .unwrap()
    );
    let waiting = loop {
        let messages = server.connection_notifications(&owner).drain();
        if let Some(request) = messages
            .into_iter()
            .map(|message| serde_json::from_str::<Value>(&message).unwrap())
            .find(|message| message["method"] == "app/request")
        {
            break request;
        }
        assert!(
            Instant::now() < deadline,
            "second host request was not dispatched"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    server.client_host.unregister(owner.connection_id);
    let response = json!({"jsonrpc":"2.0","id":waiting["id"],"result":{"json":"{}"}});
    assert!(
        server
            .client_host
            .handle_response(owner.connection_id, response)
            .unwrap()
    );
    super::wait_for_latest_turn(&server, &thread, ash_protocol::TurnStatus::Completed);
    assert!(
        !server
            .connection_notifications(&other)
            .drain()
            .iter()
            .any(
                |message| serde_json::from_str::<Value>(message).unwrap()["method"]
                    == "app/request"
            )
    );
    assert!(
        serde_json::to_string(&*model.output.lock().unwrap())
            .unwrap()
            .contains("CapabilityUnavailable")
    );
}

#[test]
fn regular_wire_clients_cannot_declare_application_window_authority() {
    let server = super::server();
    let mut connection = server.connection();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{"appTools":{"version":1,"agents":true,"desktop":true}}}});
    let failed = super::call(&server, &mut connection, request);
    assert!(failed.get("error").is_some());
    assert!(
        server
            .client_host
            .app_tools_capability(connection.connection_id)
            .is_none()
    );
    // Failed capability validation must not leave the connection initialized.
    let initialized = super::call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}),
    );
    assert!(initialized.get("error").is_none(), "{initialized}");
}

#[test]
fn development_task_tools_review_and_dispatch_on_the_bound_window() {
    let directory_root = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let root = directory_root.path().canonicalize().unwrap();
    let directory = root.to_string_lossy().into_owned();
    let revision = "a".repeat(64);
    let model = model(vec![
        ("tasks_list", json!({"directory":directory})),
        (
            "tasks_run",
            json!({"directory":directory,"task_id":"check","revision":revision}),
        ),
        (
            "tasks_status",
            json!({"directory":directory,"run_id":"shared-run"}),
        ),
        (
            "tasks_output",
            json!({"directory":directory,"run_id":"shared-run","cursor":0,"max_characters":4096}),
        ),
        (
            "tasks_cancel",
            json!({"directory":directory,"run_id":"shared-run"}),
        ),
    ]);
    let server = crate::open_app_server(
        crate::AppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_agent_model_service(model.clone())
            .with_dir_root(&root),
    )
    .unwrap()
    .into_shared();
    let mut owner = server.product_host_connection();
    let mut other = server.product_host_connection();
    let capability = json!({"appTools":{"version":1,"agents":true,"desktop":true},"dirPermissionsHost":{"version":1}});
    for connection in [&mut owner, &mut other] {
        let initialized = super::call(
            &server,
            connection,
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"task-tools-test","version":"1"},"capabilities":capability}}),
        );
        assert!(initialized.get("error").is_none(), "{initialized}");
    }
    let session = super::create_session(&server, &mut owner, 2, "task-tools-session");
    let session_id =
        ash_protocol::SessionId::new(session["result"]["session"]["sessionId"].as_str().unwrap())
            .unwrap();
    let granted = super::call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":20,"method":"session/dirs/add","params":{"sessionId":session_id,"path":directory,"permissions":["readFiles","executeCommands"]}}),
    );
    assert!(granted.get("error").is_none(), "{granted}");
    let thread = super::create_thread(
        &server,
        &mut owner,
        3,
        "task-tools-thread",
        session_id.as_str(),
        1,
    );
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let started = super::call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":4,"method":"session/request","params":{"commandId":"task-tools-turn","sessionId":session_id,"request":{"type":"startTurn","expectedSequence":1,"threadId":thread_id,"approvalMode":"bypassPermissions","input":[{"type":"text","text":"Run the existing check task"}]}}}),
    );
    assert!(started.get("error").is_none(), "{started}");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut operations = Vec::new();
    while model.calls.load(Ordering::Relaxed) < 6 {
        for frame in server.connection_notifications(&owner).drain() {
            let request: Value = serde_json::from_str(&frame).unwrap();
            if request["method"] != "app/request" {
                continue;
            }
            let operation = &request["params"]["operation"];
            assert_eq!(request["params"]["threadId"], thread_id);
            assert_eq!(operation["directory"], directory);
            operations.push(operation["type"].as_str().unwrap().to_string());
            let result = match operation["type"].as_str().unwrap() {
                "tasksList" => json!({"tasks":[{"taskId":"check","revision":revision}],"runs":[]}),
                "tasksDescribe" => {
                    json!({"taskId":"check","label":"Check","directory":directory,"revision":revision,"commands":[{"command":"compiler","cwd":directory}]})
                }
                "tasksRun" => json!({"runId":"shared-run","taskId":"check","status":"running"}),
                "tasksStatus" => json!({"runId":"shared-run","status":"running","ready":false}),
                "tasksOutput" => {
                    json!({"text":"shared execution output","cursor":0,"nextCursor":23,"truncated":false,"hasMore":false})
                }
                "tasksCancel" => json!({"runId":"shared-run","status":"canceled"}),
                unexpected => panic!("unexpected host operation {unexpected}"),
            };
            let response =
                json!({"jsonrpc":"2.0","id":request["id"],"result":{"json":result.to_string()}});
            assert!(
                server
                    .client_host
                    .handle_response(other.connection_id, response.clone())
                    .is_err()
            );
            assert!(
                server
                    .client_host
                    .handle_response(owner.connection_id, response)
                    .unwrap()
            );
        }
        assert!(
            Instant::now() < deadline,
            "task tools did not complete: {operations:?}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    super::wait_for_latest_turn(&server, thread_id, ash_protocol::TurnStatus::Completed);
    assert_eq!(
        operations
            .iter()
            .filter(|operation| *operation == "tasksRun")
            .count(),
        1
    );
    assert!(
        operations
            .iter()
            .any(|operation| operation == "tasksDescribe")
    );
    assert!(
        operations
            .iter()
            .any(|operation| operation == "tasksCancel")
    );
    assert!(
        serde_json::to_string(&*model.output.lock().unwrap())
            .unwrap()
            .contains("shared execution output")
    );
}

use super::{AppServer, ConnectionState};
use crate::local::ProviderModelService;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;
use ash_protocol::{AgentId, SessionId, TeamRunId, ThreadId};
use ash_state::SqliteThreadStore;
use core_api::{AgentRuntime, StartThreadRequest};
use std::sync::Arc;

#[test]
fn team_rpc_keeps_member_identity_across_tasks_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("team.sqlite3");
    let server = open_server(&path);
    let mut connection = server.product_host_connection();
    initialize(&server, &mut connection);

    let create = serde_json::json!({
        "commandId": "create-team",
        "teamId": "team-a",
        "expectedRevision": 0,
        "command": {
            "type": "create",
            "name": "Engineering",
            "description": "Build features together",
            "coordinatorId": "lead-a",
            "members": [
                {"agentId": "lead-a", "name": "Lead", "responsibility": "Coordinate work", "role": {"type": "default"}},
                {"agentId": "reviewer-a", "name": "Reviewer", "responsibility": "Review code", "role": {"type": "default"}}
            ]
        }
    });
    let _: ash_app_server_protocol::protocol::teams::TeamCommandParams =
        serde_json::from_value(create.clone()).unwrap();
    let created = call(&server, &mut connection, 2, "team/command", create.clone());
    assert_eq!(created["result"]["team"]["revision"], 1, "{created}");
    assert_eq!(
        call(&server, &mut connection, 3, "team/command", create)["result"]["replayed"],
        true
    );
    let mut browser = server.browser_connection();
    initialize(&server, &mut browser);
    assert_eq!(
        call(
            &server,
            &mut browser,
            25,
            "team/list",
            serde_json::json!({})
        )["result"]["teams"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut untrusted = server.connection();
    initialize(&server, &mut untrusted);
    assert_eq!(
        call(
            &server,
            &mut untrusted,
            26,
            "team/list",
            serde_json::json!({})
        )["error"]["message"],
        "PermissionRequired"
    );

    let mut runs = Vec::new();
    for index in 1..=2 {
        let started = call(
            &server,
            &mut connection,
            3 + index,
            "team/run/start",
            serde_json::json!({
                "commandId": format!("start-{index}"),
                "runId": format!("run-{index}"),
                "teamId": "team-a",
                "expectedTeamRevision": 1,
                "objective": format!("Build feature {index}")
            }),
        );
        assert!(started.get("result").is_some(), "{started}");
        runs.push(started["result"]["run"].clone());
    }
    assert_ne!(runs[0]["sessionId"], runs[1]["sessionId"]);
    assert_ne!(
        runs[0]["coordinatorThreadId"],
        runs[1]["coordinatorThreadId"]
    );
    for run in &runs {
        let thread = server
            .threads
            .read_thread(&ThreadId::new(run["coordinatorThreadId"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(thread.agent_id, AgentId::new("lead-a").unwrap());
        assert_eq!(thread.turns.len(), 1);
        assert!(thread.items.iter().any(|item| matches!(item, ash_protocol::ThreadItem::UserMessage { text, .. } if text.contains(run["runId"].as_str().unwrap()))));
        assert_eq!(run["members"].as_array().unwrap().len(), 2);
        let scopes = server.memory_scope_labels(Some(&thread.thread_id)).unwrap();
        assert!(scopes.iter().any(|(scope, label)| *scope
            == memories::MemoryScope::Team {
                team_id: ash_protocol::TeamId::new("team-a").unwrap()
            }
            && label == "Team: Engineering"));
    }

    let existing = server
        .agent_runtime()
        .start_thread(StartThreadRequest {
            workspace: None,
            agent_id: Some(AgentId::new("lead-a").unwrap()),
            command_id: ash_protocol::CommandId::new("existing-thread").unwrap(),
            title: "Existing workflow task".into(),
            agent: server
                .resolve_root_agent(&ash_protocol::AgentRoleSelection::Default)
                .unwrap(),
            branch_name: None,
        })
        .unwrap();
    let attach = serde_json::json!({
        "commandId": "attach-workflow", "runId": "run-existing", "teamId": "team-a",
        "expectedTeamRevision": 1, "sessionId": existing.session_id,
        "coordinatorThreadId": existing.thread_id, "objective": "Review workflow stage"
    });
    let attached = call(
        &server,
        &mut connection,
        18,
        "team/run/attach",
        attach.clone(),
    );
    assert_eq!(
        attached["result"]["run"]["sessionId"],
        existing.session_id.to_string(),
        "{attached}"
    );
    assert_eq!(
        call(
            &server,
            &mut connection,
            19,
            "team/run/attach",
            attach.clone()
        )["result"]["replayed"],
        true
    );
    let mut conflicting_attach = attach;
    conflicting_attach["commandId"] = "attach-conflict".into();
    assert_eq!(
        call(
            &server,
            &mut connection,
            27,
            "team/run/attach",
            conflicting_attach
        )["error"]["message"],
        "CommandConflict"
    );
    let memory = call(
        &server,
        &mut connection,
        20,
        "memory/add",
        serde_json::json!({
            "commandId": "remember-team-decision", "memoryId": "protocol-decision",
            "scope": {"type": "team", "teamId": "team-a"},
            "title": "Protocol decision", "body": "Use the shared protocol"
        }),
    );
    assert!(memory.get("result").is_some(), "{memory}");

    let replayed = call(
        &server,
        &mut connection,
        15,
        "team/run/start",
        serde_json::json!({
            "commandId": "start-1", "runId": "run-1", "teamId": "team-a",
            "expectedTeamRevision": 1, "objective": "Build feature 1"
        }),
    );
    assert_eq!(replayed["result"]["replayed"], true, "{replayed}");
    assert_eq!(
        server
            .threads
            .read_thread(&ThreadId::new(runs[0]["coordinatorThreadId"].as_str().unwrap()).unwrap())
            .unwrap()
            .turns
            .len(),
        1
    );

    let posted = call(
        &server,
        &mut connection,
        6,
        "team/message/post",
        serde_json::json!({
            "messageId": "decision-1", "teamId": "team-a", "runId": "run-1",
            "senderId": "lead-a", "receiverId": null, "text": "Use the shared protocol"
        }),
    );
    assert!(posted.get("result").is_some(), "{posted}");
    let posted_again = call(
        &server,
        &mut connection,
        16,
        "team/message/post",
        serde_json::json!({
            "messageId": "decision-1", "teamId": "team-a", "runId": "run-1",
            "senderId": "lead-a", "receiverId": null, "text": "Use the shared protocol"
        }),
    );
    assert_eq!(
        posted_again["result"]["message"],
        posted["result"]["message"]
    );
    let private = call(
        &server,
        &mut connection,
        22,
        "team/message/post",
        serde_json::json!({
            "messageId": "private-review", "teamId": "team-a", "runId": "run-1",
            "senderId": "reviewer-a", "receiverId": "reviewer-a", "text": "Private review note"
        }),
    );
    assert!(private.get("result").is_some(), "{private}");
    let lead_messages = call(
        &server,
        &mut connection,
        23,
        "team/message/list",
        serde_json::json!({"teamId": "team-a", "readerId": "lead-a"}),
    );
    assert_eq!(
        lead_messages["result"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reviewer_messages = call(
        &server,
        &mut connection,
        24,
        "team/message/list",
        serde_json::json!({"teamId": "team-a", "readerId": "reviewer-a"}),
    );
    assert_eq!(
        reviewer_messages["result"]["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let changed = call(
        &server,
        &mut connection,
        7,
        "team/command",
        serde_json::json!({
            "commandId": "remove-reviewer", "teamId": "team-a", "expectedRevision": 1,
            "command": {"type": "removeMember", "agentId": "reviewer-a"}
        }),
    );
    assert_eq!(
        changed["result"]["team"]["members"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "{changed}"
    );
    let prior = call(
        &server,
        &mut connection,
        8,
        "team/run/read",
        serde_json::json!({"runId": "run-1"}),
    );
    assert_eq!(
        prior["result"]["run"]["members"].as_array().unwrap().len(),
        2
    );
    let participant = server
        .teams
        .as_ref()
        .unwrap()
        .member_for_spawn(
            &TeamRunId::new("run-1").unwrap(),
            &SessionId::new(runs[0]["sessionId"].as_str().unwrap()).unwrap(),
            &ThreadId::new(runs[0]["coordinatorThreadId"].as_str().unwrap()).unwrap(),
            &AgentId::new("reviewer-a").unwrap(),
        )
        .unwrap();
    assert_eq!(participant.name, "Reviewer");
    let after_removal = call(
        &server,
        &mut connection,
        17,
        "team/run/start",
        serde_json::json!({
            "commandId": "start-3", "runId": "run-3", "teamId": "team-a",
            "expectedTeamRevision": 2, "objective": "Build feature 3"
        }),
    );
    assert_eq!(
        after_removal["result"]["run"]["members"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "{after_removal}"
    );
    drop(server);

    let reopened = open_server(&path);
    let mut connection = reopened.product_host_connection();
    initialize(&reopened, &mut connection);
    let listed = call(
        &reopened,
        &mut connection,
        9,
        "team/run/list",
        serde_json::json!({"teamId": "team-a"}),
    );
    assert_eq!(
        listed["result"]["runs"].as_array().unwrap().len(),
        4,
        "{listed}"
    );
    let messages = call(
        &reopened,
        &mut connection,
        10,
        "team/message/list",
        serde_json::json!({"teamId": "team-a", "readerId": "lead-a"}),
    );
    assert_eq!(
        messages["result"]["messages"][0]["text"], "Use the shared protocol",
        "{messages}"
    );
    let remembered = call(
        &reopened,
        &mut connection,
        21,
        "memory/read",
        serde_json::json!({
            "memoryId": "protocol-decision", "scope": {"type": "team", "teamId": "team-a"}
        }),
    );
    assert_eq!(
        remembered["result"]["body"], "Use the shared protocol",
        "{remembered}"
    );
    let denied = call(
        &reopened,
        &mut connection,
        11,
        "team/message/list",
        serde_json::json!({"teamId": "team-a", "readerId": "reviewer-a"}),
    );
    assert_eq!(denied["error"]["message"], "TeamMemberUnauthorized");
}

fn open_server(path: &std::path::Path) -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        SqliteThreadStore::open(path).unwrap(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_local_teams(path)
    .unwrap()
    .with_local_memories(path)
    .unwrap()
}

fn initialize(server: &AppServer, connection: &mut ConnectionState) {
    let response = call(
        server,
        connection,
        1,
        "initialize",
        serde_json::json!({"clientInfo": {"name": "team-test", "version": "1"}, "capabilities": {}}),
    );
    assert!(response.get("result").is_some(), "{response}");
}

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    serde_json::from_str(
        &server.handle_json(
            connection,
            &serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
                .to_string(),
        ),
    )
    .unwrap()
}

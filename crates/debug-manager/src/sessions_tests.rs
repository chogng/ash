use std::sync::Arc;

use ash_debug_contract::DebugConsoleEntryKind;
use ash_debug_contract::DebugSessionAdmission;
use serde_json::json;

use super::DebugSessions;

fn admission(id: &str, parent: Option<&str>) -> DebugSessionAdmission {
    DebugSessionAdmission {
        id: id.into(),
        workspace_id: "workspace".into(),
        parent_id: parent.map(str::to_owned),
        lifecycle_managed_by_parent: parent.is_some(),
        merge_console: parent.is_some(),
        no_debug: None,
    }
}

#[test]
fn prepared_sessions_inherit_route_and_are_revoked_with_their_parent() {
    let registry = DebugSessions::default();
    let mut root = admission("parent", None);
    root.no_debug = Some(true);
    registry.reserve(1, root).unwrap();
    let child = registry
        .reserve(1, admission("child", Some("parent")))
        .unwrap();
    assert_eq!(child.no_debug, Some(true));
    assert_eq!(child.console_id, "parent");
    assert_eq!(child.lifecycle_target_id, "parent");
    assert!(
        registry
            .reserve(2, admission("foreign", Some("parent")))
            .is_err()
    );
    let mut foreign_workspace = admission("foreign", Some("parent"));
    foreign_workspace.workspace_id = "other".into();
    assert!(registry.reserve(1, foreign_workspace).is_err());
    registry
        .reserve(1, admission("grandchild", Some("child")))
        .unwrap();
    let ended = registry.end(1, "parent").unwrap();
    assert_eq!(ended.descendants, ["grandchild", "child"]);
    assert!(registry.read(1, "child").unwrap().ended);
    assert!(
        registry
            .reserve(1, admission("late", Some("child")))
            .is_err()
    );
    assert_eq!(registry.end(1, "parent").unwrap(), ended);
    registry.close_owner(1);
    assert!(registry.read(1, "child").is_err());
}

#[test]
fn parent_end_closes_resources_across_directory_managers_and_refuses_late_binding() {
    let registry = Arc::new(DebugSessions::default());
    registry.reserve(7, admission("parent", None)).unwrap();
    registry
        .reserve(7, admission("child", Some("parent")))
        .unwrap();
    registry
        .reserve(7, admission("preparing", Some("parent")))
        .unwrap();
    let parent_manager = Arc::new(crate::tests::manager());
    let child_manager = Arc::new(crate::tests::manager());
    let parent = parent_manager.open_client_transport().unwrap();
    let child = child_manager.open_client_transport().unwrap();
    // Backend handles can coincide in two directories; public identities cannot.
    assert_eq!(parent, child);
    parent_manager
        .set_public_id(&parent, "parent".into())
        .unwrap();
    child_manager.set_public_id(&child, "child".into()).unwrap();
    parent_manager
        .attach(&parent, registry.clone(), 7, None)
        .unwrap();
    child_manager
        .attach(&child, registry.clone(), 7, None)
        .unwrap();
    registry.end(7, "parent").unwrap();
    assert_eq!(
        parent_manager.read(&parent, 0, 128).unwrap().session.state,
        crate::DebugExecutionState::Terminated
    );
    assert_eq!(
        child_manager.read(&child, 0, 128).unwrap().session.state,
        crate::DebugExecutionState::Terminated
    );
    assert!(child_manager.request(&child, "custom:echo", None).is_err());
    let late = child_manager.open_client_transport().unwrap();
    child_manager
        .set_public_id(&late, "preparing".into())
        .unwrap();
    assert!(
        child_manager
            .attach(&late, registry.clone(), 7, None)
            .is_err()
    );
    registry.reserve(8, admission("parent", None)).unwrap();
    registry.close_owner(7);
    assert!(!registry.read(8, "parent").unwrap().ended);
}

#[test]
fn structured_output_preserves_shared_order_groups_objects_and_source_then_clears_in_rust() {
    let registry = DebugSessions::default();
    registry.reserve(1, admission("parent", None)).unwrap();
    registry
        .reserve(1, admission("child", Some("parent")))
        .unwrap();
    registry
        .append(
            1,
            "parent",
            DebugConsoleEntryKind::Output,
            &json!({"output":"group","group":"startCollapsed"}),
        )
        .unwrap();
    registry.append(1, "parent", DebugConsoleEntryKind::Output, &json!({"output":"error\n","category":"stderr","variablesReference":42,"source":{"path":"/tmp/main.rs","name":"main.rs","sourceReference":2,"vendor":"discard"},"line":8,"column":0,"data":{"key":"value"}})).unwrap();
    registry
        .append(
            1,
            "child",
            DebugConsoleEntryKind::Output,
            &json!({"output":"child\n"}),
        )
        .unwrap();
    registry
        .append(
            1,
            "parent",
            DebugConsoleEntryKind::Output,
            &json!({"group":"end"}),
        )
        .unwrap();
    registry
        .append(
            1,
            "parent",
            DebugConsoleEntryKind::Output,
            &json!({"output":"outside\n"}),
        )
        .unwrap();
    let output = registry.console(1, "child").unwrap();
    assert_eq!(output.entries.len(), 4);
    assert_eq!(output.entries[0].kind, DebugConsoleEntryKind::Group);
    assert!(output.entries[0].collapsed);
    assert_eq!(output.entries[1].parent_id, Some(output.entries[0].id));
    assert_eq!(output.entries[1].variables_reference, Some(42));
    assert_eq!(output.entries[1].category, "stderr");
    assert_eq!(
        output.entries[1].source.as_ref().unwrap()["path"],
        "/tmp/main.rs"
    );
    assert!(
        output.entries[1]
            .source
            .as_ref()
            .unwrap()
            .get("vendor")
            .is_none()
    );
    assert_eq!(output.entries[1].line, Some(8));
    assert_eq!(output.entries[1].column, None);
    assert_eq!(output.entries[2].session_id, "child");
    assert_eq!(output.entries[2].parent_id, None);
    assert_eq!(output.entries[3].parent_id, None);
    registry.end(1, "parent").unwrap();
    assert_eq!(registry.console(1, "parent").unwrap(), output);
    assert!(registry.console(2, "parent").is_err());
    registry.clear_console(1, "child").unwrap();
    assert!(registry.console(1, "parent").unwrap().entries.is_empty());
    assert!(registry.console(1, "parent").unwrap().revision > output.revision);
}

#[test]
fn output_retention_is_bounded_and_dropped_group_headers_do_not_leave_dangling_parents() {
    let registry = DebugSessions::default();
    registry.reserve(1, admission("session", None)).unwrap();
    registry
        .append(
            1,
            "session",
            DebugConsoleEntryKind::Output,
            &json!({"output":"group","group":"start"}),
        )
        .unwrap();
    for _ in 0..600 {
        registry
            .append(
                1,
                "session",
                DebugConsoleEntryKind::Output,
                &json!({"output":"中".repeat(200)}),
            )
            .unwrap();
    }
    let output = registry.console(1, "session").unwrap();
    assert!(output.entries.len() < 512);
    assert!(output.entries.iter().all(|entry| entry.parent_id.is_none()));
    assert!(
        output
            .entries
            .iter()
            .all(|entry| entry.output == "中".repeat(200))
    );
    assert!(serde_json::to_vec(&output).unwrap().len() < 129_000);
    for index in 0..24 {
        let id = format!("ended-{index}");
        registry.reserve(1, admission(&id, None)).unwrap();
        registry.end(1, &id).unwrap();
    }
    registry.reserve(1, admission("next", None)).unwrap();
    assert!(registry.read(1, "ended-0").is_err());
    assert!(registry.console(1, "session").is_ok());
}

#[test]
fn parent_revocation_closes_a_child_socket_without_waiting_for_a_renderer() {
    use std::io::Read;
    use std::time::Duration;
    let registry = Arc::new(DebugSessions::default());
    registry.reserve(1, admission("parent", None)).unwrap();
    registry
        .reserve(1, admission("child", Some("parent")))
        .unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut byte = [0];
        assert_eq!(socket.read(&mut byte).unwrap(), 0);
    });
    let manager = Arc::new(crate::tests::manager());
    let id = manager
        .connect(ash_debug_adapter::DebugAdapterConnection::Server { port, host: None })
        .unwrap();
    manager.set_public_id(&id, "child".into()).unwrap();
    manager.attach(&id, registry.clone(), 1, None).unwrap();
    registry.end(1, "parent").unwrap();
    peer.join().unwrap();
}

#[test]
fn one_large_output_keeps_a_valid_tail_and_respects_the_encoded_budget() {
    let registry = DebugSessions::default();
    registry.reserve(1, admission("session", None)).unwrap();
    for output in [
        format!("{}TAIL", "中".repeat(100_000)),
        format!("{}TAIL", "\0".repeat(100_000)),
    ] {
        registry.clear_console(1, "session").unwrap();
        registry
            .append(
                1,
                "session",
                DebugConsoleEntryKind::Output,
                &json!({"output":output,"source":{"name":"not-addressable"}}),
            )
            .unwrap();
        let snapshot = registry.console(1, "session").unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        assert!(snapshot.entries[0].output.ends_with("TAIL"));
        assert!(snapshot.entries[0].source.is_none());
        assert!(serde_json::to_vec(&snapshot).unwrap().len() < 128_000);
    }
}

#[test]
fn resolved_parent_launch_facts_are_visible_before_its_descriptor_can_start_a_child() {
    let registry = Arc::new(DebugSessions::default());
    registry.reserve(1, admission("parent", None)).unwrap();
    registry.prepare(1, "parent", Some(true)).unwrap();
    let child = registry
        .reserve(1, admission("child", Some("parent")))
        .unwrap();
    assert_eq!(child.no_debug, Some(true));
    let manager = Arc::new(crate::tests::manager());
    let id = manager.open_client_transport().unwrap();
    manager.set_public_id(&id, "parent".into()).unwrap();
    assert!(
        manager
            .attach(&id, registry.clone(), 1, Some(false))
            .is_err()
    );
    manager
        .attach(&id, registry.clone(), 1, Some(true))
        .unwrap();
    assert!(registry.prepare(1, "parent", Some(false)).is_err());
    registry.end(1, "parent").unwrap();
    assert!(registry.prepare(1, "child", Some(false)).is_err());
}

#[test]
fn ended_merged_children_release_their_group_stacks_before_tombstone_eviction() {
    let registry = DebugSessions::default();
    registry.reserve(1, admission("parent", None)).unwrap();
    for index in 0..700 {
        let id = format!("child-{index}");
        registry.reserve(1, admission(&id, Some("parent"))).unwrap();
        registry
            .append(
                1,
                &id,
                DebugConsoleEntryKind::Output,
                &json!({"output":"group","group":"start"}),
            )
            .unwrap();
        registry.end(1, &id).unwrap();
        registry
            .append(
                1,
                &id,
                DebugConsoleEntryKind::Output,
                &json!({"output":"late diagnostic"}),
            )
            .unwrap();
        assert!(
            registry
                .console(1, &id)
                .unwrap()
                .entries
                .last()
                .unwrap()
                .parent_id
                .is_none()
        );
        // Late transport diagnostics may reintroduce an empty stack; repeated revocation
        // and tombstone eviction must both release that per-session bookkeeping.
        registry.end(1, &id).unwrap();
    }
    let state = registry.0.lock().unwrap();
    assert!(state.nodes.len() <= 512);
    assert!(
        state
            .consoles
            .get(&(1, "parent".into()))
            .unwrap()
            .groups
            .is_empty()
    );
}

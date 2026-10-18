use super::*;

fn edits(values: &[&str]) -> Vec<DebugWorkspaceEdit> {
    values
        .iter()
        .map(|value| DebugWorkspaceEdit::AddWatch {
            expression: (*value).to_owned(),
        })
        .collect()
}

fn watches(values: &[&str]) -> DebugWorkspaceState {
    DebugWorkspaceState {
        watch_expressions: values.iter().map(|value| (*value).to_owned()).collect(),
        ..Default::default()
    }
}

#[test]
fn definitions_survive_reopen_and_workspace_keys_are_independent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let store = DebugWorkspaceStore::open(&path).unwrap();
    assert_eq!(
        store
            .write("workspace", 0, edits(&["value"]))
            .unwrap()
            .status,
        DebugWorkspaceStatus::Applied
    );
    drop(store);
    let store = DebugWorkspaceStore::open(&path).unwrap();
    assert_eq!(
        store.read("workspace", None).unwrap().snapshot.state,
        watches(&["value"])
    );
    assert_eq!(store.read("other", None).unwrap().snapshot, empty());
}

#[test]
fn separate_connections_cannot_overwrite_a_newer_revision() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let first = DebugWorkspaceStore::open(&path).unwrap();
    let second = DebugWorkspaceStore::open(&path).unwrap();
    let applied = first.write("workspace", 0, edits(&["first"])).unwrap();
    let conflict = second.write("workspace", 0, edits(&["second"])).unwrap();
    assert_eq!(conflict.status, DebugWorkspaceStatus::Conflict);
    assert_eq!(conflict.snapshot, applied.snapshot);
}

#[test]
fn migration_is_atomic_idempotent_and_receipted_across_later_edits() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let legacy = watches(&["old"]);
    let store = DebugWorkspaceStore::open(&path).unwrap();
    let imported = store.read("workspace", Some(legacy.clone())).unwrap();
    assert_eq!(imported.status, DebugWorkspaceStatus::Applied);
    let edited = store
        .write("workspace", imported.snapshot.revision, edits(&["new"]))
        .unwrap();
    drop(store);
    let store = DebugWorkspaceStore::open(&path).unwrap();
    let resumed = store.read("workspace", Some(legacy)).unwrap();
    assert_eq!(resumed.status, DebugWorkspaceStatus::Current);
    assert_eq!(resumed.snapshot, edited.snapshot);
    assert_eq!(
        store
            .read("workspace", Some(watches(&["conflicting legacy"])))
            .unwrap()
            .status,
        DebugWorkspaceStatus::Conflict
    );
    assert_eq!(
        store.read("workspace", None).unwrap().snapshot,
        edited.snapshot
    );
}

#[test]
fn equal_target_accepts_migration_without_replacing_its_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = DebugWorkspaceStore::open(&root.path().join("state.sqlite")).unwrap();
    let state = watches(&["same"]);
    let written = store.write("workspace", 0, edits(&["same"])).unwrap();
    let imported = store.read("workspace", Some(state)).unwrap();
    assert_eq!(imported.status, DebugWorkspaceStatus::Applied);
    assert_eq!(imported.snapshot, written.snapshot);
}

#[test]
fn invalid_import_and_invalid_write_leave_target_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let store = DebugWorkspaceStore::open(&root.path().join("state.sqlite")).unwrap();
    assert!(matches!(
        store.read("workspace", Some(watches(&["\0"]))),
        Err(DebugWorkspaceError::Invalid)
    ));
    assert_eq!(store.read("workspace", None).unwrap().snapshot, empty());
    let written = store.write("workspace", 0, edits(&["valid"])).unwrap();
    assert!(matches!(
        store.write("workspace", 1, edits(&[""])),
        Err(DebugWorkspaceError::Invalid)
    ));
    assert_eq!(
        store.read("workspace", None).unwrap().snapshot,
        written.snapshot
    );
    assert!(matches!(
        store.read("", None),
        Err(DebugWorkspaceError::Invalid)
    ));
}

#[test]
fn persistent_data_contract_rejects_session_addresses_and_adapter_results() {
    let source =
        serde_json::json!({"id":"a", "enabled":true, "resource":"file:///main.rs", "lineNumber":1});
    let state: DebugWorkspaceState = serde_json::from_value(serde_json::json!({"breakpoints":[source], "functionBreakpoints":[], "dataBreakpoints":[], "watchExpressions":[], "exceptionBreakpoints":{}})).unwrap();
    validate(&state).unwrap();
    let mut malformed_resource = state.clone();
    malformed_resource.breakpoints[0].resource = "http://[".into();
    assert!(matches!(
        validate(&malformed_resource),
        Err(DebugWorkspaceError::Invalid)
    ));
    let mut invalid_json = serde_json::to_value(&state).unwrap();
    invalid_json["breakpoints"][0]["verified"] = true.into();
    assert!(serde_json::from_value::<DebugWorkspaceState>(invalid_json).is_err());
    let mut invalid = state.clone();
    invalid.breakpoints.push(state.breakpoints[0].clone());
    assert!(matches!(
        validate(&invalid),
        Err(DebugWorkspaceError::Invalid)
    ));
}

#[test]
fn definition_edits_preserve_all_durable_families_without_runtime_fields() {
    let root = tempfile::tempdir().unwrap();
    let store = DebugWorkspaceStore::open(&root.path().join("state.sqlite")).unwrap();
    let edits: Vec<DebugWorkspaceEdit> = serde_json::from_value(serde_json::json!([
        {"kind":"source","point":{"id":"source","enabled":false,"resource":"ash-remote://host/work/main.rs","lineNumber":7,"columnNumber":3,"condition":" value > 0 ","hitCondition":"2","logMessage":" value = {value} "}},
        {"kind":"function","point":{"id":"function","enabled":true,"name":"app::worker","condition":"value > 1","logMessage":"worker"}},
        {"kind":"data","point":{"id":"data","enabled":true,"dataId":" opaque memory reference ","description":"counter","adapterType":"example","accessType":"readWrite","accessTypes":["read","write","readWrite"],"hitCondition":"3"}},
        {"kind":"addWatch","expression":"second"},
        {"kind":"addWatch","expression":"first"},
        {"kind":"addWatch","expression":"second"},
        {"kind":"exceptions","adapterType":"example","filters":["all"]}
    ])).unwrap();
    let written = store.write("workspace", 0, edits).unwrap();
    assert_eq!(
        written.snapshot.state.watch_expressions,
        ["second", "first"]
    );
    assert_eq!(
        written.snapshot.state.data_breakpoints[0].data_id,
        " opaque memory reference "
    );
    drop(store);
    let store = DebugWorkspaceStore::open(&root.path().join("state.sqlite")).unwrap();
    assert_eq!(
        store.read("workspace", None).unwrap().snapshot,
        written.snapshot
    );
    let encoded = serde_json::to_value(&written.snapshot.state).unwrap();
    for field in ["sessionId", "verified", "canPersist"] {
        let mut invalid = encoded.clone();
        invalid["dataBreakpoints"][0][field] = true.into();
        assert!(serde_json::from_value::<DebugWorkspaceState>(invalid).is_err());
    }
    let removed = store
        .write(
            "workspace",
            written.snapshot.revision,
            vec![
                DebugWorkspaceEdit::Remove {
                    ids: vec!["source".into(), "data".into()],
                },
                DebugWorkspaceEdit::RemoveWatch {
                    expression: "second".into(),
                },
            ],
        )
        .unwrap();
    assert!(removed.snapshot.state.breakpoints.is_empty());
    assert!(removed.snapshot.state.data_breakpoints.is_empty());
    assert_eq!(
        removed.snapshot.state.function_breakpoints,
        written.snapshot.state.function_breakpoints
    );
    assert_eq!(removed.snapshot.state.watch_expressions, ["first"]);
    let disabled = store
        .write(
            "workspace",
            removed.snapshot.revision,
            vec![DebugWorkspaceEdit::SetEnabled { enabled: false }],
        )
        .unwrap();
    assert!(!disabled.snapshot.state.function_breakpoints[0].base.enabled);
    let cleared = store
        .write(
            "workspace",
            disabled.snapshot.revision,
            vec![DebugWorkspaceEdit::ClearBreakpoints],
        )
        .unwrap();
    assert!(cleared.snapshot.state.function_breakpoints.is_empty());
    assert_eq!(cleared.snapshot.state.watch_expressions, ["first"]);
}

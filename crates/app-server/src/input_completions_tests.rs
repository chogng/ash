use super::*;
use crate::server::DirGrantPolicy;
use ash_file_access::Grant;
use serde_json::Value;
use serde_json::json;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

fn complete(server: &AppServer, connection: &mut ConnectionState, params: Value) -> Value {
    call(
        server,
        connection,
        json!({"jsonrpc":"2.0","id":next_id(),"method":"chat/input/completions","params":params}),
    )
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(100);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn query(text: &str) -> Value {
    json!({"operationId":format!("completion-{}", next_id()), "directories":[], "text":text,"offset":text.encode_utf16().count()})
}

#[test]
fn input_completions_advertise_supported_triggers_and_use_canonical_commands() {
    let server = server();
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"completion-test","version":"1"},"capabilities":{}}}),
    );
    assert_eq!(
        initialized["result"]["capabilities"]["inputCompletions"],
        json!({"version":1,"triggerCharacters":["/","@","#"]})
    );
    let mut params = query(" \n /adv later");
    params["offset"] = json!(7);
    let found = complete(&server, &mut connection, params);
    let item = &found["result"]["items"][0];
    assert_eq!(item["label"], "/advisor");
    assert_eq!(item["insertText"], "/advisor ");
    assert_eq!(
        (item["start"].as_u64(), item["end"].as_u64()),
        (Some(3), Some(8))
    );
    assert_eq!(item["value"], json!({"kind":"command"}));
    assert_eq!(item["preselect"], true);
    let prose = complete(&server, &mut connection, query("Explain /adv"));
    assert_eq!(prose["result"]["items"], json!([]));
}

#[test]
fn input_completions_validate_utf16_positions_identity_and_bounds() {
    let server = server();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let mut params = query("😀 #file");
    params["offset"] = json!(1);
    assert_eq!(
        complete(&server, &mut connection, params)["error"]["code"],
        -32602
    );
    let mut params = query("#file");
    params["offset"] = json!(100);
    assert_eq!(
        complete(&server, &mut connection, params)["error"]["code"],
        -32602
    );
    let mut params = query("/adv");
    params["threadId"] = json!("unowned-thread");
    assert_eq!(
        complete(&server, &mut connection, params)["error"]["code"],
        -32602
    );
    let mut params = query("/adv");
    params["sessionId"] = json!("missing-session");
    assert!(complete(&server, &mut connection, params)["error"].is_object());
    let mut params = query("/adv");
    params["directories"] = json!(vec![json!({"type":"workspace","dirId":"folder"}); 33]);
    assert_eq!(
        complete(&server, &mut connection, params)["error"]["code"],
        -32602
    );
}

#[test]
fn input_completions_cancellation_is_owned_by_the_original_connection() {
    let server = server();
    let mut first = server.connection();
    let mut second = server.connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    let cancelled = call(
        &server,
        &mut first,
        json!({"jsonrpc":"2.0","id":2,"method":"chat/input/completions/cancel","params":{"operationId":"completion"}}),
    );
    assert_eq!(cancelled["result"], Value::Null);
    let mut cancelled_query = query("/adv");
    cancelled_query["operationId"] = json!("completion");
    assert!(complete(&server, &mut second, cancelled_query.clone())["result"]["items"].is_array());
    assert_eq!(
        complete(&server, &mut first, cancelled_query)["error"]["code"],
        -32800
    );
}

#[test]
fn input_completions_find_authorized_files_and_empty_folders_with_utf16_ranges() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.ts"), "captured elsewhere").unwrap();
    std::fs::create_dir(root.path().join("folder-empty")).unwrap();
    let server = server()
        .with_local_env_host(
            None,
            DirGrantPolicy::HostSelectedDirs(GrantSource::HostConfiguration),
        )
        .unwrap();
    server
        .activate_local_dirs(vec![(
            "folder".into(),
            Grant::for_environment(
                Dir::open_local(root.path()).unwrap(),
                GrantSource::HostConfiguration,
                Permissions::new([
                    DirPermission::SearchFiles,
                    DirPermission::BrowseFiles,
                    DirPermission::ReadFiles,
                    DirPermission::InspectRepository,
                ]),
            ),
        )])
        .unwrap();
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"completion-test","version":"1"},"capabilities":{}}}),
    );
    let mut params = query("😀 #fil");
    params["directories"] = json!([{"type":"workspace","dirId":"folder"}]);
    let found = complete(&server, &mut connection, params.clone());
    let file = &found["result"]["items"][0];
    assert_eq!(file["label"], "#file.ts");
    assert_eq!(file["start"], 3);
    assert_eq!(file["end"], 7);
    assert_eq!(
        file["value"],
        json!({"kind":"resource","directory":0,"path":"file.ts","isDirectory":false})
    );
    params["operationId"] = json!(format!("completion-{}", next_id()));
    params["text"] = json!("@folder:folder");
    params["offset"] = json!(14);
    let folder = complete(&server, &mut connection, params.clone());
    assert_eq!(folder["result"]["items"][0]["label"], "@folder-empty/");
    params["operationId"] = json!(format!("completion-{}", next_id()));
    params["directories"][0]["dirId"] = json!("ungranted");
    assert!(complete(&server, &mut connection, params)["error"].is_object());
}

#[test]
fn input_completions_use_enabled_skill_catalog_and_return_pinned_references() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("completion-skill")).unwrap();
    std::fs::write(
        root.path().join("completion-skill/SKILL.md"),
        "---\nname: completion-skill\ndescription: Completion test\n---\n\nInstructions.\n",
    )
    .unwrap();
    let server = server()
        .with_skill_runtime(
            ash_skills_extension::BuiltInSkillSource::Root(root.path().into()),
            Arc::new(EmptySkillConfig),
            None,
        )
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let found = complete(&server, &mut connection, query("Use $completion-s"));
    let item = &found["result"]["items"][0];
    assert_eq!(item["insertText"], "$completion-skill ");
    assert_eq!(item["detail"], "Completion test");
    assert_eq!(item["value"]["kind"], "skill");
    assert_eq!(item["value"]["skill"]["version"]["type"], "pinnedDigest");
    assert!(
        item["value"]["skill"]["version"]["digest"]
            .as_str()
            .unwrap()
            .len()
            >= 64
    );
    let catalog = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":21,"method":"skills/list","params":{"reload":"cached"}}),
    );
    assert_eq!(
        item["value"]["skill"]["version"]["digest"],
        catalog["result"]["skills"][0]["contentDigest"]
    );
}

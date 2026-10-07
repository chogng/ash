use super::*;
use grep::Match as ContentSearchMatch;
use grep::MatchRange as ContentSearchMatchRange;

#[test]
fn maps_protocol_query_to_content_search_query() {
    let query = search_query(ContentSearchStartParams {
        dir_id: None,
        session_directory: None,
        query: "needle".into(),
        pattern_kind: ContentSearchPatternKind::Regex,
        freshness: Some(ContentSearchFreshness::Indexed),
        case_sensitivity: ContentSearchProtocolCaseSensitivity::Insensitive,
        include_patterns: vec!["src/**".into()],
        exclude_patterns: vec!["**/*.test.rs".into()],
        max_results: 400,
    });

    assert_eq!(
        query,
        ContentSearchQuery {
            query: "needle".into(),
            pattern: ContentSearchPattern::Regex,
            case_sensitivity: ContentSearchCaseSensitivity::Insensitive,
            include_patterns: vec!["src/**".into()],
            exclude_patterns: vec!["**/*.test.rs".into()],
            max_results: 400,
            scope: Default::default(),
            freshness: grep::Freshness::Indexed,
        }
    );
}

#[test]
fn maps_content_search_page_to_protocol_result() {
    let result = search_page(
        "search-1".into(),
        ContentSearchPage {
            matches: vec![ContentSearchMatch {
                path: "src/lib.rs".into(),
                line_number: 7,
                content: "let 搜索 = \"needle\";".into(),
                ranges: vec![ContentSearchMatchRange { start: 14, end: 20 }],
            }],
            next_match: 1,
            completed: true,
            limit_hit: false,
            error: None,
            freshness: Some(grep::Freshness::Current),
            index_stats: None,
        },
    );

    assert_eq!(result.search_id, "search-1");
    assert_eq!(result.matches.len(), 1);
    assert_eq!(
        result.matches[0].path,
        std::path::PathBuf::from("src/lib.rs")
    );
    assert_eq!(
        result.matches[0].ranges,
        [ContentSearchProtocolMatchRange { start: 10, end: 16 }]
    );
    assert_eq!(result.next_match, 1);
    assert!(result.completed);
    assert!(!result.limit_hit);
    assert_eq!(result.error, None);
    assert_eq!(result.freshness, Some(ContentSearchFreshness::Current));
    assert_eq!(result.index_stats, None);
}

#[test]
fn indexed_statistics_are_exposed_in_the_read_result() {
    let result = search_page(
        "search-1".into(),
        ContentSearchPage {
            matches: vec![],
            next_match: 0,
            completed: true,
            limit_hit: false,
            error: None,
            freshness: Some(grep::Freshness::Indexed),
            index_stats: Some(grep::IndexStats {
                query_plan: "AND(3 trigrams)".into(),
                raw_candidates: 7,
                candidates: 2,
                total_files: 50,
            }),
        },
    );
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(
        json["indexStats"],
        serde_json::json!({
            "queryPlan": "AND(3 trigrams)", "rawCandidates": 7, "candidates": 2, "totalFiles": 50,
        })
    );
}

#[test]
fn omitted_freshness_preserves_current_disk_search() {
    let params = serde_json::from_value::<ContentSearchStartParams>(serde_json::json!({
        "query": "needle", "patternKind": "literal", "caseSensitivity": "sensitive",
        "includePatterns": [], "excludePatterns": [], "maxResults": 100
    }))
    .unwrap();
    assert_eq!(search_query(params).freshness, grep::Freshness::Current);
}

#[test]
fn file_glob_rpc_uses_authorized_roots_ignore_rules_and_limits() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permissions;
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join(".git")).unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    std::fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
    for path in ["root.txt", "ignored.txt", "src/中文.txt", "src/file.rs"] {
        std::fs::write(root.path().join(path), "text").unwrap();
    }
    let grant = Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::SearchFiles, Permission::InspectRepository]),
    );
    let server = glob_server();
    server
        .activate_local_dirs(vec![("folder".into(), grant.clone())])
        .unwrap();
    let mut connection = server.connection();
    glob_call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo":{"name":"glob-test","version":"1"}, "capabilities":{}
        }),
    );
    let params = serde_json::json!({"operationId":"enumerate", "target":{"type":"workspace","dirId":"folder"}, "includePatterns":[], "excludePatterns":[], "maxResults":100});
    let response = glob_call(
        &server,
        &mut connection,
        2,
        "file/search/glob",
        params.clone(),
    );
    let mut paths: Vec<String> =
        serde_json::from_value(response["result"]["paths"].clone()).unwrap();
    paths.sort();
    assert_eq!(paths, ["root.txt", "src/file.rs", "src/中文.txt"]);
    assert_eq!(response["result"]["totalMatches"], 3);
    let response = glob_call(
        &server,
        &mut connection,
        3,
        "file/search/glob",
        serde_json::json!({
            "operationId":"included", "target":{"type":"workspace","dirId":"folder"}, "includePatterns":["**/*.txt"], "excludePatterns":["src/**"], "maxResults":1
        }),
    );
    assert_eq!(
        response["result"]["totalMatches"], 2,
        "positive globs use rg override semantics: {response}"
    );
    assert_eq!(response["result"]["paths"].as_array().unwrap().len(), 1);
    for (index, field, value) in [
        (
            4,
            "target",
            serde_json::json!({"type":"workspace", "dirId":"ungranted"}),
        ),
        (5, "maxResults", serde_json::json!(0)),
        (6, "includePatterns", serde_json::json!(["../*.txt"])),
        (7, "includePatterns", serde_json::json!(["/tmp/**"])),
    ] {
        let mut invalid = params.clone();
        invalid["operationId"] = serde_json::json!(format!("invalid-{index}"));
        invalid[field] = value;
        let response = glob_call(&server, &mut connection, index, "file/search/glob", invalid);
        assert_eq!(response["error"]["code"], -32602, "{response}");
    }
    server
        .activate_local_dirs(vec![
            ("folder".into(), grant.clone()),
            (
                "inspect-only".into(),
                Grant::for_environment(
                    Dir::open_local(root.path()).unwrap(),
                    GrantSource::HostConfiguration,
                    Permissions::new([Permission::InspectRepository]),
                ),
            ),
        ])
        .unwrap();
    let mut denied = params.clone();
    denied["operationId"] = serde_json::json!("no-search-permission");
    denied["target"] = serde_json::json!({"type":"workspace", "dirId":"inspect-only"});
    let response = glob_call(&server, &mut connection, 8, "file/search/glob", denied);
    assert_eq!(
        response["error"]["message"], "PermissionRequired",
        "{response}"
    );
    grant.revoke();
    let mut params = params;
    params["operationId"] = serde_json::json!("revoked");
    let response = glob_call(&server, &mut connection, 9, "file/search/glob", params);
    assert_eq!(
        response["error"]["message"], "PermissionRequired",
        "{response}"
    );
    server.close_connection(connection);
}

#[test]
fn file_glob_cancellation_is_connection_owned_and_keeps_a_terminal_reply() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permissions;
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "text").unwrap();
    let server = glob_server();
    server
        .activate_local_dirs(vec![(
            "folder".into(),
            Grant::for_environment(
                Dir::open_local(root.path()).unwrap(),
                GrantSource::HostConfiguration,
                Permissions::new([Permission::SearchFiles, Permission::InspectRepository]),
            ),
        )])
        .unwrap();
    let mut first = server.connection();
    let mut second = server.connection();
    for connection in [&mut first, &mut second] {
        glob_call(
            &server,
            connection,
            1,
            "initialize",
            serde_json::json!({
                "clientInfo":{"name":"glob-test","version":"1"}, "capabilities":{}
            }),
        );
    }
    let cancelled = glob_call(
        &server,
        &mut first,
        2,
        "file/search/glob/cancel",
        serde_json::json!({"operationId":"pending"}),
    );
    assert_eq!(cancelled["result"], serde_json::Value::Null);
    let query = serde_json::json!({"operationId":"pending", "target":{"type":"workspace","dirId":"folder"}, "includePatterns":[], "excludePatterns":[], "maxResults":100});
    let other = glob_call(&server, &mut second, 2, "file/search/glob", query.clone());
    assert_eq!(other["result"]["paths"], serde_json::json!(["file.txt"]));
    let terminal = glob_call(&server, &mut first, 3, "file/search/glob", query);
    assert_eq!(
        terminal["error"]["message"], "RequestCancelled",
        "{terminal}"
    );
    let invalid = glob_call(
        &server,
        &mut first,
        4,
        "file/search/glob/cancel",
        serde_json::json!({"operationId":""}),
    );
    assert_eq!(invalid["error"]["code"], -32602);
    server.close_connection(first);
    server.close_connection(second);
}

fn glob_server() -> AppServer {
    use crate::local::ProviderModelService;
    use crate::server::DirGrantPolicy;
    use ash_core::InMemoryThreadStore;
    use ash_core::ThreadController;
    use ash_file_access::GrantSource;
    use ash_model_provider::EchoModel;
    use std::sync::Arc;
    AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_ephemeral_env_state()
    .with_local_env_host(
        None,
        DirGrantPolicy::HostSelectedDirs(GrantSource::HostConfiguration),
    )
    .unwrap()
}

fn glob_call(
    server: &AppServer,
    connection: &mut ConnectionState,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    serde_json::from_str(
        &server.handle_json(
            connection,
            &serde_json::json!({
                "jsonrpc":"2.0", "id":id, "method":method, "params":params
            })
            .to_string(),
        ),
    )
    .unwrap()
}

#[test]
fn file_glob_session_target_requires_that_sessions_directory_authorization() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permissions;
    let primary = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    let ungranted = tempfile::tempdir().unwrap();
    std::fs::write(extra.path().join("session.txt"), "text").unwrap();
    let server = glob_server();
    server
        .activate_local_dirs(vec![(
            "folder".into(),
            Grant::for_environment(
                Dir::open_local(primary.path()).unwrap(),
                GrantSource::HostConfiguration,
                Permissions::new([Permission::SearchFiles, Permission::InspectRepository]),
            ),
        )])
        .unwrap();
    let session = server
        .start_thread(core_api::StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: ash_protocol::CommandId::new("glob-session").unwrap(),
            title: "Glob session".into(),
        })
        .unwrap();
    let (path, _, _) = server
        .add_session_dir(
            &session.session_id,
            extra.path().to_path_buf(),
            Permissions::new([Permission::SearchFiles]),
        )
        .unwrap();
    let mut connection = server.connection();
    glob_call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo":{"name":"glob-test","version":"1"}, "capabilities":{}
        }),
    );
    let query = serde_json::json!({
        "operationId":"session-root", "target":{"type":"session", "sessionId":session.session_id, "path":path},
        "includePatterns":[], "excludePatterns":[], "maxResults":100
    });
    let response = glob_call(
        &server,
        &mut connection,
        2,
        "file/search/glob",
        query.clone(),
    );
    assert_eq!(
        response["result"]["paths"],
        serde_json::json!(["session.txt"]),
        "{response}"
    );
    let mut denied = query.clone();
    denied["operationId"] = serde_json::json!("ungranted-session-root");
    denied["target"]["path"] = serde_json::json!(ungranted.path());
    let response = glob_call(&server, &mut connection, 3, "file/search/glob", denied);
    assert_eq!(
        response["error"]["message"], "PermissionRequired",
        "{response}"
    );
    server
        .remove_session_dir(&session.session_id, &path)
        .unwrap();
    let mut revoked = query;
    revoked["operationId"] = serde_json::json!("revoked-session-root");
    let response = glob_call(&server, &mut connection, 4, "file/search/glob", revoked);
    assert_eq!(
        response["error"]["message"], "PermissionRequired",
        "{response}"
    );
    server.close_connection(connection);
}

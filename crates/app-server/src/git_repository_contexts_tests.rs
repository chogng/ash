use super::*;
use crate::server::DirGrantPolicy;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use serde_json::json;

fn initialize_repository(root: &std::path::Path, branch: &str, remote: &str) {
    std::fs::create_dir_all(root).unwrap();
    for args in [
        vec!["init", "-b", branch],
        vec!["remote", "add", "origin", remote],
    ] {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn historical_session_repository_contexts_use_its_grant_without_environment_fallback() {
    let directories = tempfile::tempdir().unwrap();
    let primary = directories.path().join("primary");
    let history = directories.path().join("history");
    initialize_repository(&primary, "primary", "https://github.com/primary/wrong.git");
    initialize_repository(
        &history,
        "history",
        "https://token@github.com/historical/right.git",
    );
    initialize_repository(
        &history.join("nested"),
        "nested",
        "git@github.com:nested/second.git",
    );
    let server = server()
        .with_ephemeral_env_state()
        .with_local_env_host(
            None,
            DirGrantPolicy::HostSelectedDirs(GrantSource::HostConfiguration),
        )
        .unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(&primary).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::InspectRepository]),
    );
    server
        .activate_local_dirs(vec![("primary".into(), grant)])
        .unwrap();
    let mut connection = server.product_host_connection();
    let initialized = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "clientInfo":{"name":"historical-session-fixture","version":"1"},
            "capabilities":{"directoryGrantsHost":{"version":1}}
        }}),
    );
    assert!(initialized.get("error").is_none(), "{initialized}");
    let session = create_session(&server, &mut connection, 2, "history-session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let created = create_thread(&server, &mut connection, 3, "history-thread", session_id, 0);
    assert!(created.get("error").is_none(), "{created}");
    let added = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":4,"method":"session/dirs/add","params":{"sessionId":session_id,"path":history,"permissions":["inspectRepository"]}}),
    );
    assert!(added.get("error").is_none(), "{added}");
    let query = |session_id: &str, request_id: u64| json!({"jsonrpc":"2.0","id":request_id,"method":"git/repositoryContexts","params":{"sessionDirectory":{"sessionId":session_id,"path":history}}});
    let read = call(&server, &mut connection, query(session_id, 5));
    assert!(read.get("error").is_none(), "{read}");
    let repositories = read["result"]["repositories"].as_array().unwrap();
    assert_eq!(repositories.len(), 2, "{read}");
    let historical = repositories
        .iter()
        .find(|repository| repository["path"] == "")
        .unwrap();
    assert_eq!(
        historical["rootPath"],
        dunce::canonicalize(&history)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    );
    assert_eq!(historical["head"]["name"], "history");
    assert_eq!(historical["remotes"][0]["identity"]["owner"], "historical");
    assert_eq!(historical["remotes"][0]["identity"]["repository"], "right");
    assert!(
        !read.to_string().contains("token"),
        "wire context must not contain credentials"
    );
    assert!(
        !read.to_string().contains("wrong"),
        "do not consult the primary environment repository"
    );
    let again = call(&server, &mut connection, query(session_id, 6));
    assert!(again.get("error").is_none(), "{again}");
    assert_eq!(
        again["result"], read["result"],
        "read-only projection must preserve repository identity without a cursor"
    );
    let other = create_session(&server, &mut connection, 7, "other-session");
    let other_id = other["result"]["session"]["sessionId"].as_str().unwrap();
    create_thread(&server, &mut connection, 8, "other-thread", other_id, 0);
    let denied = call(&server, &mut connection, query(other_id, 9));
    assert!(
        denied.get("error").is_some(),
        "Session grants must not cross identities: {denied}"
    );
    assert_eq!(denied["error"]["code"], -32064, "{denied}");
    let revoked = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":10,"method":"session/directoryGrants/set","params":{"sessionId":session_id,"path":history,"expectedRevision":added["result"]["revision"],"permissions":[]}}),
    );
    assert!(revoked.get("error").is_none(), "{revoked}");
    let retired = call(&server, &mut connection, query(session_id, 11));
    assert!(
        retired.get("error").is_some(),
        "revoked historical scope must not fall back to primary: {retired}"
    );
    assert_eq!(retired["error"]["code"], -32064, "{retired}");
    server.close_connection(connection);
}

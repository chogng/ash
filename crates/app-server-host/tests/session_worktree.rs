use ash_app_server::AppServerOptions;
use ash_app_server::SessionStateMode;
use ash_app_server::open_app_server;
use std::path::Path;
use std::process::Command;

fn git(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(directory)
        .args([
            "-c",
            "user.name=Binding test",
            "-c",
            "user.email=binding@example.test",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn session_create_pins_a_pull_request_worktree_without_copying_source_changes() {
    let profile = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    git(source.path(), &["init", "-b", "main"]);
    std::fs::write(source.path().join("note"), "base").unwrap();
    git(source.path(), &["add", "note"]);
    git(source.path(), &["commit", "-m", "base"]);
    let base = git(source.path(), &["rev-parse", "HEAD"]);
    git(source.path(), &["switch", "-c", "review"]);
    std::fs::write(source.path().join("note"), "pull request").unwrap();
    git(source.path(), &["commit", "-am", "review"]);
    let head = git(source.path(), &["rev-parse", "HEAD"]);
    git(
        source.path(),
        &[
            "push",
            remote.path().to_str().unwrap(),
            "HEAD:refs/pull/7/head",
        ],
    );
    git(source.path(), &["switch", "main"]);
    std::fs::write(source.path().join("note"), "unsaved source edit").unwrap();

    // Git invokes the real upload-pack process against a synthetic remote without networking.
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let transport = profile.path().join("ssh.sh");
    std::fs::write(
        &transport,
        format!(
            "exec git upload-pack {}
",
            quote(remote.path().to_str().unwrap())
        ),
    )
    .unwrap();
    git(
        source.path(),
        &[
            "config",
            "core.sshCommand",
            &format!("sh {}", quote(transport.to_str().unwrap())),
        ],
    );
    git(source.path(), &["config", "ssh.variant", "simple"]);
    git(
        source.path(),
        &["remote", "add", "origin", "ssh://ash-test/owner/repo.git"],
    );

    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_codex_home(profile.path().join("codex"))
            .without_built_in_skills()
            .with_session_state_mode(SessionStateMode::Ephemeral)
            .with_dir_root(source.path()),
    )
    .unwrap();
    let mut connection = server.connection();
    let mut id = 0;
    let mut call = |method: &str, params: serde_json::Value| -> serde_json::Value {
        id += 1;
        serde_json::from_str(
            &server.handle_json(
                &mut connection,
                &serde_json::json!({
                    "jsonrpc":"2.0", "id":id, "method":method, "params":params,
                })
                .to_string(),
            ),
        )
        .unwrap()
    };
    call(
        "initialize",
        serde_json::json!({"clientInfo":{"name":"pr-worktree-test","version":"1"},"capabilities":{}}),
    );
    let mut params = serde_json::json!({
        "commandId":"new-pr-session",
        "title":"#7 Review",
        "executionTarget":{"type":"local","root":source.path()},
        "branchName":"ash/pr-7",
        "worktreeStart":{"remote":"origin","remoteIdentity":"ash-test/owner/repo","reference":"refs/pull/7/head","commit":base},
    });
    assert!(
        call("session/create", params.clone())
            .get("error")
            .is_some()
    );
    assert!(git(source.path(), &["branch", "--list", "ash/pr-7"]).is_empty());
    params["worktreeStart"]["commit"] = serde_json::json!(head);
    let first = call("session/create", params.clone());
    assert!(first.get("error").is_none(), "{first}");
    assert_eq!(first["result"]["worktreeStartApplied"], true);
    let worktrees = git(source.path(), &["worktree", "list", "--porcelain"]);
    let checkout = worktrees
        .split("\n\n")
        .find(|entry| entry.lines().any(|line| line == format!("HEAD {head}")))
        .and_then(|entry| entry.lines().next())
        .and_then(|line| line.strip_prefix("worktree "))
        .unwrap();
    assert_eq!(git(Path::new(checkout), &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(Path::new(checkout).join("note")).unwrap(),
        "pull request"
    );
    assert_eq!(git(source.path(), &["rev-parse", "HEAD"]), base);
    assert_eq!(
        std::fs::read_to_string(source.path().join("note")).unwrap(),
        "unsaved source edit"
    );
    assert_eq!(
        call("session/create", params)["result"]["session"]["sessionId"],
        first["result"]["session"]["sessionId"]
    );
    assert!(git(source.path(), &["for-each-ref", "refs/ash/fetch"]).is_empty());
}

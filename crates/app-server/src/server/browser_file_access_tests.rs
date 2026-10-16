use super::*;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::PathAccess;
use ash_file_access::PathAccessPolicy;
use ash_file_access::PathAccessRule;
use ash_file_access::Permissions;

thread_local! {
    static SNAPSHOT_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

pub(super) fn before_read_snapshot() {
    let hook = SNAPSHOT_READ_HOOK.with(|hook| hook.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

fn task(server: &crate::AppServer, name: &str) -> (ThreadId, TurnId) {
    let created = server
        .threads
        .start_thread(
            &ash_core::NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                execution_target: None,
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: ash_protocol::CommandId::new(format!("create-{name}")).unwrap(),
                title: name.into(),
            },
        )
        .unwrap();
    let turn = server
        .threads
        .start_turn(
            &created.thread_id,
            ash_core::StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: ash_protocol::CommandId::new(format!("turn-{name}")).unwrap(),
                expected_sequence: core_api::SequenceExpectation::Exact(1),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![ash_protocol::UserInput::Text {
                    text: "upload".into(),
                }],
            },
        )
        .unwrap();
    (created.thread_id, turn.turn_id)
}

#[cfg(unix)]
#[test]
fn browser_upload_denies_sensitive_symlink_replacement_before_snapshot() {
    for (alias, allowed, denied) in [
        ("upload.txt", "allowed.txt", ".env"),
        ("alias/file.txt", "allowed", ".env"),
    ] {
        let mut server = crate::tests::server();
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let leaf = Path::new(alias).file_name().unwrap();
        for (target, bytes) in [(allowed, b"public"), (denied, b"secret")] {
            let mut target = root_path.join(target);
            if alias.contains('/') {
                std::fs::create_dir(&target).unwrap();
                target.push(leaf);
            }
            std::fs::write(target, bytes).unwrap();
        }
        let replaced = root_path.join(Path::new(alias).components().next().unwrap());
        std::os::unix::fs::symlink(allowed, &replaced).unwrap();
        let dir = Dir::open_local(&root_path).unwrap();
        server.env_runtime_mut().selected_grant = Some(Grant::for_environment(
            dir.clone(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::ReadFiles]),
        ));
        let (thread, turn) = task(&server, "sensitive-race");
        let paths = [root_path.join(alias).to_str().unwrap().to_owned()];
        let source = CancellationSource::new();
        let upload = || {
            read(
                &server.env_runtime,
                &server.env_config,
                &server.threads,
                &thread,
                &turn,
                &paths,
                &source.token(),
            )
        };
        let files = upload().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&files[0].data_base64)
                .unwrap(),
            b"public"
        );
        // Establish that the earlier local check accepts the object before the writer runs.
        let resolved = dir.resolve_existing(alias).unwrap();
        crate::local_tools::ensure_local_file_access(&dir, &resolved).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(0);
        let (replaced_tx, replaced_rx) = std::sync::mpsc::sync_channel(0);
        SNAPSHOT_READ_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                ready_tx.send(()).unwrap();
                replaced_rx
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
            }));
        });
        let result = std::thread::scope(|scope| {
            scope.spawn(move || {
                ready_rx
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                std::fs::remove_file(&replaced).unwrap();
                std::os::unix::fs::symlink(denied, &replaced).unwrap();
                replaced_tx.send(()).unwrap();
            });
            upload()
        });
        assert!(
            result.is_err(),
            "uploaded sensitive replacement for {alias}"
        );
    }
}

#[test]
fn browser_upload_denies_hard_link_replacement_before_snapshot() {
    let mut server = crate::tests::server();
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let path = root_path.join("upload.txt");
    let secret = root_path.join(".env");
    std::fs::write(&path, b"public").unwrap();
    std::fs::write(&secret, b"secret").unwrap();
    server.env_runtime_mut().selected_grant = Some(Grant::for_environment(
        Dir::open_local(&root_path).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let (thread, turn) = task(&server, "hard-link-race");
    let paths = [path.to_str().unwrap().to_owned()];
    let source = CancellationSource::new();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(0);
    let (replaced_tx, replaced_rx) = std::sync::mpsc::sync_channel(0);
    SNAPSHOT_READ_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            ready_tx.send(()).unwrap();
            replaced_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }));
    });
    let result = std::thread::scope(|scope| {
        scope.spawn(move || {
            ready_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            std::fs::remove_file(&path).unwrap();
            std::fs::hard_link(&secret, &path).unwrap();
            replaced_tx.send(()).unwrap();
        });
        read(
            &server.env_runtime,
            &server.env_config,
            &server.threads,
            &thread,
            &turn,
            &paths,
            &source.token(),
        )
    });
    assert!(result.is_err(), "uploaded a multiply linked replacement");
}

#[test]
fn browser_upload_uses_live_path_permissions_and_denies_escapes_sensitive_files_and_revocation() {
    let mut server = crate::tests::server();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let outside_path = outside.path().canonicalize().unwrap();
    for (name, content) in [
        ("allowed.txt", "allowed bytes"),
        ("denied.txt", "denied bytes"),
        (".env", "secret"),
        (".env.local", "allowed suffix"),
    ] {
        std::fs::write(root_path.join(name), content).unwrap();
    }
    std::fs::create_dir(root_path.join("nested")).unwrap();
    std::fs::write(root_path.join("nested/.env"), "nested secret").unwrap();
    std::fs::write(outside_path.join("secret.txt"), "outside secret").unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(&root_path).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    )
    .with_path_policy(
        PathAccessPolicy::new(
            PathAccess::ReadWrite,
            vec![PathAccessRule {
                pattern: "denied.txt".into(),
                access: PathAccess::Denied,
            }],
        )
        .unwrap(),
    );
    server.env_runtime_mut().selected_grant = Some(grant.clone());
    let (thread, turn) = task(&server, "first");
    let source = CancellationSource::new();
    let read_paths = |paths: Vec<std::path::PathBuf>| {
        read(
            &server.env_runtime,
            &server.env_config,
            &server.threads,
            &thread,
            &turn,
            &paths
                .iter()
                .map(|path| path.to_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            &source.token(),
        )
    };
    let allowed = read_paths(vec![root_path.join("allowed.txt")]).unwrap();
    assert_eq!(allowed[0].name, "allowed.txt");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(&allowed[0].data_base64)
            .unwrap(),
        b"allowed bytes"
    );
    assert!(read_paths(vec![root_path.join(".env.local")]).is_ok());
    for path in [
        outside_path.join("secret.txt"),
        root_path.join("denied.txt"),
        root_path.join(".env"),
        root_path.join("nested/.env"),
        root_path.join("../secret.txt"),
        root_path.clone(),
    ] {
        assert!(read_paths(vec![path]).is_err());
    }
    // A mixed batch never publishes its allowed subset if another path fails authorization.
    assert!(
        read_paths(vec![
            root_path.join("allowed.txt"),
            outside_path.join("secret.txt")
        ])
        .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside_path.join("secret.txt"), root_path.join("escape"))
            .unwrap();
        std::os::unix::fs::symlink(root_path.join("denied.txt"), root_path.join("alias")).unwrap();
        std::os::unix::fs::symlink(root_path.join(".env"), root_path.join("secret-alias")).unwrap();
        assert!(read_paths(vec![root_path.join("escape")]).is_err());
        assert!(read_paths(vec![root_path.join("alias")]).is_err());
        assert!(read_paths(vec![root_path.join("secret-alias")]).is_err());
        std::fs::hard_link(outside_path.join("secret.txt"), root_path.join("hardlink")).unwrap();
        assert!(read_paths(vec![root_path.join("hardlink")]).is_err());
    }
    grant.revoke();
    assert!(read_paths(vec![root_path.join("allowed.txt")]).is_err());
}

#[test]
fn browser_upload_cannot_borrow_another_thread_directory_or_outlive_cancellation() {
    let server = crate::tests::server();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    std::fs::write(first.path().join("file"), "first").unwrap();
    std::fs::write(second.path().join("file"), "second").unwrap();
    let (thread, turn) = task(&server, "first");
    let (other, _) = task(&server, "second");
    let dirs = server.env_runtime.read().unwrap().dir_grants.clone();
    dirs.bind_thread_dir(thread.clone(), Dir::open_local(first.path()).unwrap());
    dirs.bind_thread_dir(other, Dir::open_local(second.path()).unwrap());
    let source = CancellationSource::new();
    let read_path = |path: &Path| {
        read(
            &server.env_runtime,
            &server.env_config,
            &server.threads,
            &thread,
            &turn,
            &[path.to_str().unwrap().into()],
            &source.token(),
        )
    };
    assert!(read_path(&first.path().join("file")).is_ok());
    assert!(read_path(&second.path().join("file")).is_err());
    source.cancel();
    assert!(read_path(&first.path().join("file")).is_err());
}

#[test]
fn browser_upload_observes_live_profile_rules_and_batch_limits() {
    let mut server = crate::tests::server();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file.txt");
    std::fs::write(&path, "allowed").unwrap();
    server.env_runtime_mut().selected_grant = Some(Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let (thread, turn) = task(&server, "profile");
    let source = CancellationSource::new();
    let paths = [path.to_str().unwrap().to_owned()];
    let read_paths = |paths: &[String]| {
        read(
            &server.env_runtime,
            &server.env_config,
            &server.threads,
            &thread,
            &turn,
            paths,
            &source.token(),
        )
    };
    assert!(read_paths(&paths).is_ok());
    assert!(read_paths(&vec![paths[0].clone(); 17]).is_err());
    std::fs::write(root.path().join("large.bin"), vec![0; MAX_UPLOAD_BYTES + 1]).unwrap();
    assert!(read_paths(&[root.path().join("large.bin").to_str().unwrap().into()]).is_err());
    let mut config = ash_config::ResolvedConfig::default();
    config.permissions.default_profile = Some("limited".into());
    config.permissions.profiles.insert(
        "limited".into(),
        ash_config::PermissionProfileConfig {
            extends: Some(":fullAccess".into()),
            paths: vec![PathAccessRule {
                pattern: "file.txt".into(),
                access: PathAccess::Denied,
            }],
            ..Default::default()
        },
    );
    server.env_config.write().unwrap().tools =
        crate::local_tools::LocalToolConfig::from_resolved(&config);
    assert!(read_paths(&paths).is_err());
}

#[test]
fn browser_upload_authorizes_before_host_dispatch_and_transports_only_approved_file_bytes() {
    use ash_app_server_protocol::protocol::common::BrowserCapability as HostCapability;
    use core_api::BrowserCapability;
    use serde_json::json;
    let mut server = crate::tests::server();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "approved").unwrap();
    std::fs::write(outside.path().join("secret"), "unapproved").unwrap();
    server.env_runtime_mut().selected_grant = Some(Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let (thread, turn) = task(&server, "upload");
    let outbound = crate::server::notification_queue::NotificationQueue::default();
    server.browser_host.register(
        7,
        HostCapability {
            version: 4,
            observe: true,
            input: true,
        },
        outbound.clone(),
    );
    server
        .client_host
        .submit_turn(
            &thread,
            Some(7),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(core_api::TurnReceipt {
                    turn_id: turn.clone(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    server
        .browser_host
        .configure(
            7,
            &ash_app_server_protocol::protocol::browser::BrowserConfigureParams {
                enabled: true,
                cdp_enabled: true,
            },
        )
        .unwrap();
    let host = server.browser_host.for_turn(&thread, &turn).unwrap();
    std::thread::scope(|scope| {
        let create = scope.spawn(|| {
            host.create_target(
                core_api::CreateBrowserTargetRequest {
                    url: "about:blank".into(),
                },
                &CancellationSource::new().token(),
            )
        });
        assert!(outbound.listener().wait());
        let request = outbound.listener().drain().remove(0);
        server
            .client_host
            .handle_response(
                7,
                json!({"jsonrpc":"2.0","id":request["id"],"result":{"targetId":"page"}}),
            )
            .unwrap();
        create.join().unwrap().unwrap();
        let action = |path: &Path| core_api::BrowserAction::Cdp {
            target_id: core_api::BrowserTargetId("page".into()),
            operation: core_api::BrowserCdpOperation::Command {
                method: "DOM.setFileInputFiles".into(),
                params: json!({"files":[path],"backendNodeId":1})
                    .as_object()
                    .unwrap()
                    .clone(),
                session_id: None,
            },
        };
        let allowed = action(&root.path().join("file.txt"));
        let send = scope.spawn(|| host.perform(allowed, &CancellationSource::new().token()));
        assert!(outbound.listener().wait());
        let request = outbound.listener().drain().remove(0);
        assert_eq!(
            request["params"]["uploads"],
            json!([{"name":"file.txt","dataBase64":"YXBwcm92ZWQ="}])
        );
        server.client_host.handle_response(7, json!({"jsonrpc":"2.0","id":request["id"],"result":{"targetId":"page","output":"{}"}})).unwrap();
        send.join().unwrap().unwrap();
        assert!(
            host.perform(
                action(&outside.path().join("secret")),
                &CancellationSource::new().token()
            )
            .is_err()
        );
        assert!(outbound.listener().drain().is_empty());
    });
}

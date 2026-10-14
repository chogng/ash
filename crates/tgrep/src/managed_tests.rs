use super::*;
use crate::Query;
use crate::Registration;
use crate::Session as SearchSession;
use crate::tests::git;
use ash_install_context::InstallContext;
use std::fs;

fn fixture() -> (tempfile::TempDir, tempfile::TempDir, SearchSession) {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    fs::write(root.path().join("source.rs"), "before_marker\n").unwrap();
    commit(root.path());
    let index = tempfile::tempdir().unwrap();
    let session = SearchSession::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &CancellationSource::new().token(),
    )
    .unwrap();
    assert!(matches!(session.registration, Registration::Managed(_)));
    (root, index, session)
}
fn commit(root: &Path) {
    git(root, &["add", "."]);
    git(
        root,
        &[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=search@example.test",
            "commit",
            "-m",
            "checkpoint",
        ],
    );
}
fn search(session: &SearchSession, pattern: &str) -> crate::SearchResult {
    session
        .search(
            &Query {
                pattern,
                scope: Path::new(""),
                case_insensitive: false,
                include: &[],
                exclude: &[],
                max_results: 100,
                current: false,
            },
            &CancellationSource::new().token(),
        )
        .unwrap()
}
fn client(session: &SearchSession) -> &Arc<Session> {
    let Registration::Managed(client) = &session.registration else {
        panic!("expected managed registration")
    };
    client
}

#[test]
fn managed_search_keeps_filenames_and_acknowledged_edits_on_one_registration() {
    let (root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    let hello = session
        .process
        .rpc(
            "hello",
            json!({}),
            &token,
            Instant::now() + super::super::TIMEOUT,
        )
        .unwrap();
    assert_eq!(hello["storage"], "managed");
    assert_eq!(hello["policy"]["policy"]["retention"]["mode"], "bounded");
    assert_eq!(hello["policy"]["policy"]["advancement"]["mode"], "fixed");
    assert_eq!(
        session.file_fuzzy("source", 10, &token).unwrap().matches[0].path,
        Path::new("source.rs")
    );
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    fs::write(root.path().join("source.rs"), "latest_marker\n").unwrap();
    fs::write(root.path().join("new.rs"), "latest_marker\n").unwrap();
    session.paths_changed(&[session.root.join("source.rs"), session.root.join("new.rs")]);
    assert_eq!(
        session.file_fuzzy("new", 10, &token).unwrap().matches.len(),
        1
    );
    assert_eq!(search(&session, "latest_marker").matches.len(), 2);
    assert!(search(&session, "before_marker").matches.is_empty());
    for pattern in [r"\b", r"\s|\<"] {
        assert_eq!(search(&session, pattern).matches.len(), 2);
    }
}

#[test]
fn managed_independent_owners_detach_and_drain_before_worktree_removal() {
    let (root, index, mut first) = fixture();
    let token = CancellationSource::new().token();
    let mut second = SearchSession::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    assert!(Arc::ptr_eq(&first.process, &second.process));
    assert_ne!(
        client(&first).owner().unwrap(),
        client(&second).owner().unwrap()
    );
    assert_eq!(search(&first, "before_marker").matches.len(), 1);
    first.close(&token).unwrap();
    assert_eq!(search(&second, "before_marker").matches.len(), 1);
    second.close(&token).unwrap();
    fs::remove_dir_all(root.path()).unwrap();
}

#[test]
fn managed_rebuild_advances_exact_base_and_restart_reuses_its_generation() {
    let (root, index, mut session) = fixture();
    let token = CancellationSource::new().token();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    let previous = client(&session)
        .lookup(&token, Instant::now() + super::super::TIMEOUT)
        .unwrap();
    fs::write(root.path().join("source.rs"), "committed_marker\n").unwrap();
    commit(root.path());
    session.paths_changed(&[session.root.join("source.rs")]);
    session.rebuild(&token).unwrap();
    let advanced = client(&session)
        .lookup(&token, Instant::now() + super::super::TIMEOUT)
        .unwrap();
    assert_ne!(previous["commit"], advanced["commit"]);
    assert_eq!(
        advanced["version"].as_u64().unwrap(),
        previous["version"].as_u64().unwrap() + 1
    );
    assert_eq!(search(&session, "committed_marker").matches.len(), 1);
    session.close(&token).unwrap();
    drop(session);
    let session = SearchSession::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    assert_eq!(search(&session, "committed_marker").matches.len(), 1);
    let restored = client(&session)
        .lookup(&token, Instant::now() + super::super::TIMEOUT)
        .unwrap();
    assert_eq!(advanced["commit"], restored["commit"]);
    assert_eq!(advanced["generation"], restored["generation"]);
}

#[test]
fn managed_filename_pages_keep_membership_epochs_separate_from_content() {
    let (root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    for number in 0..1030 {
        fs::write(root.path().join(format!("file_{number:04}.txt")), "text\n").unwrap();
    }
    session.paths_changed(&[session.root.clone()]);
    let mut cursor = session.file_cursor(&token).unwrap();
    assert!(session.next_file(&mut cursor, &token).unwrap().is_some());
    fs::write(root.path().join("added.txt"), "added\n").unwrap();
    session.paths_changed(&[session.root.join("added.txt")]);
    assert_eq!(
        session
            .file_fuzzy("added", 10, &token)
            .unwrap()
            .matches
            .len(),
        1
    );
    while !cursor.buffered.as_slice().is_empty() {
        session.next_file(&mut cursor, &token).unwrap();
    }
    assert!(session.next_file(&mut cursor, &token).is_err());
}

fn operation(client: &Session, method: &str, request: Value) -> Value {
    let token = CancellationSource::new().token();
    let deadline = Instant::now() + super::super::TIMEOUT;
    let mut op = client.prepare(method, request).unwrap();
    client.submit(&mut op, &token, deadline).unwrap();
    client.finish(&op, &token, deadline).unwrap()
}

#[test]
fn managed_collection_preserves_other_views_then_reclaims_an_obsolete_base() {
    let (root, index, session) = fixture();
    let token = CancellationSource::new().token();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    let previous = client(&session)
        .lookup(&token, Instant::now() + super::super::TIMEOUT)
        .unwrap();
    let other = tempfile::tempdir().unwrap();
    let checkout = other.path().join("worktree");
    git(
        root.path(),
        &["worktree", "add", "--detach", checkout.to_str().unwrap()],
    );
    let mut second = SearchSession::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        &checkout,
        index.path(),
        &token,
    )
    .unwrap();
    assert_eq!(search(&second, "before_marker").matches.len(), 1);
    fs::write(root.path().join("source.rs"), "successor_marker\n").unwrap();
    commit(root.path());
    session.rebuild(&token).unwrap();
    let hello = session
        .process
        .rpc(
            "hello",
            json!({}),
            &token,
            Instant::now() + super::super::TIMEOUT,
        )
        .unwrap();
    let mut settings = hello["policy"]["policy"].clone();
    settings["retention"] = json!({"mode":"bounded","target_bytes":1});
    settings["collection"]["schedule"] = json!({"mode":"disabled"});
    settings["collection"]["on_pressure"] = json!(false);
    settings["collection"]["checkpoint_grace_ms"] = json!(0);
    settings["collection"]["generation_grace_ms"] = json!(0);
    operation(
        client(&session),
        "metadata.start",
        json!({"method":"policy","params":{"expected_version":hello["policy"]["version"],"policy":settings}}),
    );
    let namespace = fs::read_dir(index.path().join("tgrep-managed-v2"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = namespace
        .join("objects")
        .join(previous["incarnation"].as_str().unwrap());
    assert!(original.is_dir());
    let collect = |cursor: Value| {
        let status = session
            .process
            .rpc(
                "namespace.status",
                json!({}),
                &token,
                Instant::now() + super::super::TIMEOUT,
            )
            .unwrap();
        operation(
            client(&session),
            "collections.start",
            json!({"policy_version":status["policy"]["version"],"allocation_version":1,
            "bounds":{"max_duration_ms":200,"max_examined":128,"max_removed":16,"max_delete_bytes":16777216,"max_pages":16},"cursor":cursor}),
        )
    };
    collect(Value::Null);
    assert!(
        original.is_dir(),
        "a ready worktree still references the original generation"
    );
    assert_eq!(search(&second, "before_marker").matches.len(), 1);
    second.close(&token).unwrap();
    let mut cursor = Value::Null;
    let mut reclaimed = 0;
    for _ in 0..64 {
        let progress = collect(cursor);
        assert_eq!(progress["errors"], 0, "{progress}");
        reclaimed += progress["logical_bytes_reclaimed"].as_u64().unwrap();
        assert_eq!(search(&session, "successor_marker").matches.len(), 1);
        if !original.exists() {
            break;
        }
        cursor = progress["next"].clone();
    }
    assert!(!original.exists(), "obsolete base was not collected");
    assert!(reclaimed > 0);
}

#[test]
fn managed_operations_replay_the_same_persisted_intent_after_a_lost_response() {
    let (_root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    let client = client(&session);
    let deadline = Instant::now() + super::super::TIMEOUT;
    let pin = client.lookup(&token, deadline).unwrap();
    let mut op=client.prepare("views.refresh",json!({"view":pin["view"],"expected_version":pin["version"],"owner":client.owner().unwrap(),"allocation_version":1})).unwrap();
    let first = client.submit(&mut op, &token, deadline).unwrap();
    op.id = None;
    let replay = client.submit(&mut op, &token, deadline).unwrap();
    assert_eq!(first["id"], replay["id"]);
    client.finish(&op, &token, deadline).unwrap();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    assert_eq!(
        client.rpc("status", json!({}), &token, deadline).unwrap()["status"]["leases"],
        1
    );
}

#[cfg(unix)]
#[test]
fn managed_daemon_retires_after_its_host_is_killed_and_can_be_restarted() {
    const CHILD_ROOT: &str = "ASH_MANAGED_TEST_PARENT_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let index = PathBuf::from(std::env::var_os("ASH_MANAGED_TEST_PARENT_INDEX").unwrap());
        if std::env::var("ASH_MANAGED_TEST_PREPARE_ONLY").as_deref() == Ok("1") {
            let token = CancellationSource::new().token();
            let server = process::Server::shared(
                &Executable::resolve(&InstallContext::current()).unwrap(),
                &dunce::canonicalize(&root).unwrap(),
                &index,
                &token,
                process::Runtime::Managed,
            )
            .unwrap();
            server
                .rpc(
                    "owners.prepare",
                    json!({"token":"interrupted-bootstrap","ash_parent":true}),
                    &token,
                    Instant::now() + super::super::TIMEOUT,
                )
                .unwrap();
            fs::write(index.join("host-ready"), b"prepared").unwrap();
            std::thread::sleep(Duration::from_secs(60));
            drop(server);
            panic!("test host was not terminated");
        }
        let session = SearchSession::open(
            Executable::resolve(&InstallContext::current()).unwrap(),
            &root,
            &index,
            &CancellationSource::new().token(),
        )
        .unwrap();
        assert_eq!(search(&session, "before_marker").matches.len(), 1);
        fs::write(index.join("host-ready"), b"ready").unwrap();
        if std::env::var("ASH_MANAGED_TEST_NORMAL_EXIT").as_deref() == Ok("1") {
            while !index.join("exit-now").exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
            std::process::exit(0);
        }
        std::thread::sleep(Duration::from_secs(60));
        panic!("test host was not terminated");
    }
    for (prepared_only, normal_exit) in [(true, false), (false, false), (false, true)] {
        let (root, index, mut initial) = fixture();
        let token = CancellationSource::new().token();
        initial.close(&token).unwrap();
        drop(initial);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "managed::tests::managed_daemon_retires_after_its_host_is_killed_and_can_be_restarted",
        ])
        .env(CHILD_ROOT, root.path())
        .env("ASH_MANAGED_TEST_NORMAL_EXIT", if normal_exit { "1" } else { "0" })
        .env("ASH_MANAGED_TEST_PREPARE_ONLY", if prepared_only { "1" } else { "0" })
        .env("ASH_MANAGED_TEST_PARENT_INDEX", index.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !index.path().join("host-ready").exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "managed test host exited before readiness"
            );
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("managed host startup timed out");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let marker = root.path().join(".git/tgrep-daemon-v2.json");
        struct OrphanCleanup {
            marker: PathBuf,
            registration: Vec<u8>,
            pid: u64,
        }
        impl Drop for OrphanCleanup {
            fn drop(&mut self) {
                // The test owns this daemon. Do not act on a replacement registration.
                if fs::read(&self.marker).ok().as_ref() == Some(&self.registration) {
                    let _ = std::process::Command::new("kill")
                        .arg(self.pid.to_string())
                        .status();
                }
            }
        }
        let registration = fs::read(&marker).unwrap();
        let pid = serde_json::from_slice::<Value>(&registration).unwrap()["pid"]
            .as_u64()
            .unwrap();
        let _cleanup = OrphanCleanup {
            marker: marker.clone(),
            registration,
            pid,
        };
        if normal_exit {
            fs::write(index.path().join("exit-now"), b"exit").unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("normal managed host exit timed out");
                }
                std::thread::sleep(Duration::from_millis(25));
            };
            assert!(status.success(), "normal host exited with {status}");
        } else {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            // Marker cleanup precedes final namespace-lock release. Wait for this owned
            // process to finish as well; a zombie has already released all OS handles.
            let status = std::process::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .unwrap();
            let alive = status.status.success()
                && !status.stdout.is_empty()
                && !String::from_utf8_lossy(&status.stdout)
                    .trim_start()
                    .starts_with('Z');
            if !marker.exists() && !alive {
                break;
            }
            assert!(Instant::now() < deadline, "orphan daemon did not retire");
            std::thread::sleep(Duration::from_millis(25));
        }
        let session = SearchSession::open(
            Executable::resolve(&InstallContext::current()).unwrap(),
            root.path(),
            index.path(),
            &token,
        )
        .unwrap();
        assert_eq!(search(&session, "before_marker").matches.len(), 1);
    }
}

#[cfg(unix)]
#[test]
fn managed_filenames_and_cancelled_waiters_do_not_wait_for_blocked_content() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let shims = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    fs::write(root.path().join("source.rs"), "content_marker\n").unwrap();
    commit(root.path());
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let git_path = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("git"))
        .find(|path| path.is_file())
        .unwrap();
    let release = shims.path().join("release");
    struct ReleaseOnDrop(PathBuf);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "release");
        }
    }
    let _release = ReleaseOnDrop(release.clone());
    let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    let shim = shims.path().join("git");
    fs::write(&shim, format!("#!/bin/sh\nfor argument in \"$@\"; do\nif [ \"$argument\" = cat-file ]; then\nwhile [ ! -f {} ]; do sleep 0.02; done\nfi\ndone\nexec {} \"$@\"\n", quote(&release), quote(&git_path))).unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    let wrapper = shims.path().join("tgrep");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexport PATH={}:\"$PATH\"\nexec {} \"$@\"\n",
            quote(shims.path()),
            quote(&executable.0)
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let token = CancellationSource::new().token();
    let mut session = SearchSession::open(
        Executable::from_path(&wrapper).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    assert_eq!(
        session
            .file_fuzzy("source", 10, &token)
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(!session.status(&token).unwrap().ready);
    fs::write(root.path().join("late.rs"), "late_marker\n").unwrap();
    session.paths_changed(&[session.root.join("late.rs")]);
    assert_eq!(
        session
            .file_fuzzy("late", 10, &token)
            .unwrap()
            .matches
            .len(),
        1
    );
    let first = CancellationSource::new();
    let second = CancellationSource::new();
    std::thread::scope(|scope| {
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = scope.spawn(|| {
            client(&session)
                .wait_ready(&first.token(), Instant::now() + super::super::INDEX_TIMEOUT)
        });
        // Wait until the first reader owns the content gate, then cancel another waiter.
        let deadline = Instant::now() + Duration::from_secs(5);
        while client(&session).content.try_lock().is_ok() {
            if Instant::now() >= deadline {
                first.cancel();
                fs::write(&release, "release").unwrap();
                panic!("content reader did not acquire its gate");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let second_token = second.token();
        let waiting_client = client(&session);
        scope.spawn(move || {
            sender
                .send(
                    waiting_client
                        .wait_ready(&second_token, Instant::now() + super::super::INDEX_TIMEOUT),
                )
                .unwrap();
        });
        second.cancel();
        let result = receiver.recv_timeout(Duration::from_secs(2));
        // Always release the blocked reader before assertions can unwind the scoped threads.
        first.cancel();
        fs::write(&release, "release").unwrap();
        assert!(matches!(result.unwrap(), Err(Error::Cancelled(_))));
        assert!(matches!(worker.join().unwrap(), Err(Error::Cancelled(_))));
    });
    assert_eq!(search(&session, "late_marker").matches.len(), 1);
    session.close(&token).unwrap();
    fs::remove_dir_all(root.path()).unwrap();
}

#[test]
fn managed_pending_intent_and_lost_acknowledgment_resume_without_a_new_token() {
    let (_root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    let client = client(&session);
    let deadline = Instant::now() + super::super::TIMEOUT;
    let pin = client.lookup(&token, deadline).unwrap();
    let request = json!({"view":pin["view"],"expected_version":pin["version"],"owner":client.owner().unwrap(),"allocation_version":1});
    let op = client.prepare("views.refresh", request.clone()).unwrap();
    let sequence = op.sequence;
    // The connection failed before submission; only durable intent is available.
    *client.pending.lock().unwrap() = Some(op);
    client.wait_ready(&token, deadline).unwrap();
    assert!(
        !client
            .journal
            .join(format!("{sequence}.request.json"))
            .exists()
    );
    let mut op = client.prepare("views.refresh", request).unwrap();
    client.submit(&mut op, &token, deadline).unwrap();
    let receipt = loop {
        check(&token, deadline).unwrap();
        let receipt = client.inspect(&op, &token, deadline).unwrap();
        if receipt["state"] == "completed" {
            break receipt;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    persist(
        &client.journal.join(format!("{}.result.json", op.sequence)),
        &receipt,
    )
    .unwrap();
    loop {
        check(&token, deadline).unwrap();
        match client.process.rpc(
            "operations.acknowledge",
            json!({"scope":client.owner().unwrap(),"through":op.sequence}),
            &token,
            deadline,
        ) {
            Err(Error::Management(error))
                if error.reason_code == "operation-result-still-in-use" =>
            {
                std::thread::sleep(Duration::from_millis(25))
            }
            result => {
                result.unwrap();
                break;
            }
        }
    }
    // The acknowledgment committed but its response was lost. The receipt can have
    // expired upstream; the durable local terminal record still makes completion safe.
    *client.pending.lock().unwrap() = Some(op);
    client.wait_ready(&token, deadline).unwrap();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
}

#[test]
fn managed_content_recovers_when_an_ash_hint_batch_exceeds_the_engine_queue() {
    let (root, _index, session) = fixture();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    let mut changed = Vec::new();
    for number in 0..96 {
        let name = format!("added_{number:03}.rs");
        fs::write(root.path().join(&name), "bulk_marker\n").unwrap();
        changed.push(session.root.join(name));
    }
    session.paths_changed(&changed);
    assert_eq!(search(&session, "bulk_marker").matches.len(), 96);
}

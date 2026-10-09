use super::*;
use ash_async_utils::CancellationSource;
use std::fs;

fn git(root: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Session) {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=search@example.test",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    );
    let index = tempfile::tempdir().unwrap();
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let session = Session::open(
        executable,
        root.path(),
        index.path(),
        &CancellationSource::new().token(),
    )
    .unwrap();
    (root, index, session)
}
fn search(session: &Session, pattern: &str) -> SearchResult {
    session
        .search(
            &Query {
                pattern,
                scope: Path::new(""),
                case_insensitive: false,
                include: &[],
                max_results: 100,
                current: false,
                exclude: &["**/.env"],
            },
            &CancellationSource::new().token(),
        )
        .unwrap()
}

#[test]
fn file_view_includes_binary_hidden_and_unicode_paths_and_acknowledges_changes() {
    let (root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    fs::write(root.path().join(".gitignore"), "ignored.png\n").unwrap();
    fs::write(root.path().join("ignored.png"), [0, 255, 0]).unwrap();
    fs::write(root.path().join(".hidden.png"), [0, 255, 0]).unwrap();
    fs::write(root.path().join("中文.png"), [0, 255, 0]).unwrap();
    session.paths_changed(&[
        session.root.join(".gitignore"),
        session.root.join("ignored.png"),
        session.root.join(".hidden.png"),
        session.root.join("中文.png"),
    ]);
    let mut files = session.files(&token).unwrap();
    files.sort();
    assert_eq!(
        files,
        [
            PathBuf::from(".gitignore"),
            PathBuf::from(".hidden.png"),
            PathBuf::from("中文.png")
        ]
    );
    fs::rename(
        root.path().join("中文.png"),
        root.path().join("renamed.png"),
    )
    .unwrap();
    fs::remove_file(root.path().join(".hidden.png")).unwrap();
    fs::write(root.path().join("new.txt"), "new_marker\n").unwrap();
    session.paths_changed(&[
        session.root.join("中文.png"),
        session.root.join("renamed.png"),
        session.root.join(".hidden.png"),
        session.root.join("new.txt"),
    ]);
    let mut files = session.files(&token).unwrap();
    files.sort();
    assert_eq!(
        files,
        [
            PathBuf::from(".gitignore"),
            PathBuf::from("new.txt"),
            PathBuf::from("renamed.png")
        ]
    );
    assert_eq!(search(&session, "new_marker").matches.len(), 1);
}

#[test]
fn file_pages_are_bounded_include_large_files_and_reject_a_changed_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    for number in 0..1050 {
        fs::write(root.path().join(format!("file_{number:04}.txt")), "content").unwrap();
    }
    let large = fs::File::create(root.path().join("large.bin")).unwrap();
    large.set_len(128 * 1024 * 1024).unwrap();
    drop(large);
    let token = CancellationSource::new().token();
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let session = Session::open(executable, root.path(), index.path(), &token).unwrap();
    let mut cursor = session.file_cursor(&token).unwrap();
    assert_eq!(
        session.next_file(&mut cursor, &token).unwrap(),
        Some(PathBuf::from("file_0000.txt"))
    );
    assert_eq!(cursor.buffered.len(), 1023);
    fs::write(root.path().join("new.txt"), "new_marker").unwrap();
    session.paths_changed(&[session.root.join("new.txt")]);
    let files = session.files(&token).unwrap();
    assert_eq!(files.len(), 1052);
    assert!(files.contains(&PathBuf::from("large.bin")));
    assert!(files.contains(&PathBuf::from("new.txt")));
    while !cursor.buffered.as_slice().is_empty() {
        session.next_file(&mut cursor, &token).unwrap();
    }
    assert!(matches!(
        session.next_file(&mut cursor, &token),
        Err(Error::NotReady(_))
    ));
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert!(matches!(
        session.next_file(&mut cursor, &cancelled.token()),
        Err(Error::Cancelled(_))
    ));
}

#[test]
fn file_view_reports_a_failed_content_initialization_without_waiting_for_background_retries() {
    let (root, index, initial) = fixture();
    drop(initial);
    fs::write(root.path().join("source.rs"), "content_marker\n").unwrap();
    git(root.path(), &["add", "source.rs"]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=search@example.test",
            "commit",
            "-m",
            "content",
        ],
    );
    let blob = std::process::Command::new("git")
        .args(["rev-parse", "HEAD:source.rs"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(blob.status.success());
    let blob = String::from_utf8(blob.stdout).unwrap();
    let blob = blob.trim();
    // Remove a loose blob only inside this fixture; the working file and its tree stay intact.
    fs::remove_file(
        root.path()
            .join(".git/objects")
            .join(&blob[..2])
            .join(&blob[2..]),
    )
    .unwrap();
    let token = CancellationSource::new().token();
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let session = Session::open(executable, root.path(), index.path(), &token).unwrap();
    assert_eq!(session.files(&token).unwrap(), [PathBuf::from("source.rs")]);
    let start = Instant::now();
    let result = session.search(
        &Query {
            pattern: "content_marker",
            scope: Path::new(""),
            case_insensitive: false,
            include: &[],
            max_results: 100,
            current: false,
            exclude: &[],
        },
        &token,
    );
    assert!(matches!(result, Err(Error::Failed(_))));
    assert!(start.elapsed() < Duration::from_secs(10));
}

#[cfg(unix)]
#[test]
fn file_view_and_edits_remain_available_during_a_blocked_content_rebuild() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let shims = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    fs::write(root.path().join("source.rs"), "content_marker\n").unwrap();
    git(root.path(), &["add", "."]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=search@example.test",
            "commit",
            "-m",
            "fixture",
        ],
    );
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
    let release_guard = ReleaseOnDrop(release.clone());
    let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    let git_shim = shims.path().join("git");
    fs::write(&git_shim, format!("#!/bin/sh\nfor argument in \"$@\"; do\nif [ \"$argument\" = cat-file ]; then\nwhile [ ! -f {} ]; do sleep 0.02; done\nfi\ndone\nexec {} \"$@\"\n", quote(&release), quote(&git_path))).unwrap();
    fs::set_permissions(&git_shim, fs::Permissions::from_mode(0o755)).unwrap();
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
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let _release = release_guard;
        scope.spawn(|| {
            let token = CancellationSource::new().token();
            let session = Session::open(
                Executable::from_path(&wrapper).unwrap(),
                root.path(),
                index.path(),
                &token,
            )
            .unwrap();
            let files = session.files(&token).unwrap();
            sender.send((session, files)).unwrap();
        });
        let result = receiver.recv_timeout(Duration::from_secs(10));
        if result.is_err() {
            fs::write(&release, "release").unwrap();
        }
        let (session, files) = result.expect("file names must not wait for Git blob indexing");
        assert_eq!(files, [PathBuf::from("source.rs")]);
        let status = session.status(&CancellationSource::new().token()).unwrap();
        assert!(status.files_ready);
        assert!(!status.ready);
        let token = CancellationSource::new().token();
        session.paths_changed(&[session.root.join("source.rs")]);
        std::thread::scope(|scope| {
            let _release = ReleaseOnDrop(release.clone());
            let session = &session;
            let token = &token;
            let (rebuilt_tx, rebuilt_rx) = std::sync::mpsc::channel();
            scope.spawn(move || {
                rebuilt_tx.send(session.rebuild(&token)).unwrap();
            });
            // The listener records invalidation before queuing the blocked content RPC.
            // This proves rebuild captured its notification revision before the later write.
            let deadline = Instant::now() + Duration::from_secs(5);
            while session.status(&token).unwrap().files_ready {
                assert!(
                    Instant::now() < deadline,
                    "rebuild did not reach the engine"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let late = session.root.join("late.rs");
            fs::write(&late, "late_marker\n").unwrap();
            let (changed_tx, changed_rx) = std::sync::mpsc::channel();
            scope.spawn(move || {
                session.paths_changed(&[late]);
                changed_tx.send(()).unwrap();
            });
            changed_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("write notifications must not wait for content refresh");
            let (files_tx, files_rx) = std::sync::mpsc::channel();
            scope.spawn(move || {
                files_tx.send(session.files(&token)).unwrap();
            });
            assert_eq!(
                files_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("filenames must not wait for content refresh")
                    .unwrap(),
                [PathBuf::from("late.rs"), PathBuf::from("source.rs")]
            );
            assert!(matches!(
                rebuilt_rx.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ));
            struct CleanupLifetime(std::sync::Arc<AtomicBool>);
            impl Drop for CleanupLifetime {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
            let cleaned = std::sync::Arc::new(AtomicBool::new(false));
            drop(PendingAttachment {
                process: std::sync::Arc::clone(&session.process),
                params: Some(
                    json!({"root":session.root,"revision":"HEAD","profile":profile(),
                    "lease":"interrupted-while-rebuilding","mode":"paths"}),
                ),
                lifetime: Some(Box::new(CleanupLifetime(std::sync::Arc::clone(&cleaned)))),
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !cleaned.load(Ordering::SeqCst) {
                assert!(
                    Instant::now() < deadline,
                    "a nonfinal lease must release without waiting for another caller's refresh"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                session.rpc("status", json!({}), token, deadline).unwrap()["leases"],
                1
            );
            fs::write(&release, "release").unwrap();
            rebuilt_rx
                .recv_timeout(Duration::from_secs(15))
                .unwrap()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !cleaned.load(Ordering::SeqCst) {
                assert!(
                    Instant::now() < deadline,
                    "cleanup did not release caller resources"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                session.rpc("status", json!({}), token, deadline).unwrap()["leases"],
                1
            );
        });
        {
            let changed = session.changed.lock().unwrap();
            assert_eq!(changed.content_ack, 1);
            assert_eq!(changed.files_ack, 2);
            assert_eq!(changed.paths.get(Path::new("late.rs")), Some(&2));
        }
        assert_eq!(search(&session, "late_marker").matches.len(), 1);
        assert_eq!(search(&session, "content_marker").matches.len(), 1);
        assert!(session.changed.lock().unwrap().paths.is_empty());
    });
}

fn benchmark_repository() -> (tempfile::TempDir, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    for number in 0..10_000 {
        let dir = root.path().join(format!("src/component_{number:05}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("main.rs"),
            format!("pub fn operation_{number}() {{}}\n").repeat(64),
        )
        .unwrap();
    }
    git(root.path(), &["add", "."]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=search@example.test",
            "commit",
            "-m",
            "fixture",
        ],
    );
    (root, index)
}

#[test]
#[ignore = "manual cold registration and warm file view measurement"]
fn shared_file_view_benchmark() {
    let (root, index) = benchmark_repository();
    let token = CancellationSource::new().token();
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    #[cfg(unix)]
    let wrapper = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let executable = unwatched_engine(wrapper.path(), &executable);
    let start = Instant::now();
    let session = Session::open(executable, root.path(), index.path(), &token).unwrap();
    let files = session.files(&token).unwrap();
    let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(files.len(), 10_000);
    let mut timings = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        assert_eq!(session.files(&token).unwrap().len(), files.len());
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    timings.sort_by(f64::total_cmp);
    eprintln!(
        "paths={} cold_registration_and_files_ms={cold_ms:.3} warm_files_ms median={:.3} p95={:.3}",
        files.len(),
        timings[10],
        timings[18]
    );
    let expected = ash_file_search::Service
        .fuzzy(root.path().to_path_buf(), "main", 100, &token)
        .unwrap();
    let mut fuzzy_timings = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let found = session.file_fuzzy("main", 100, &token).unwrap();
        fuzzy_timings.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(found.total_match_count, expected.total_match_count);
        assert_eq!(
            found
                .matches
                .into_iter()
                .map(|matched| ash_file_search::PathMatch {
                    score: matched.score,
                    path: matched.path,
                    indices: matched.indices,
                })
                .collect::<Vec<_>>(),
            expected.matches
        );
    }
    fuzzy_timings.sort_by(f64::total_cmp);
    let mut cursor = Value::Null;
    let mut page_bytes = 0;
    loop {
        let page = session
            .rpc(
                "files/page",
                json!({"page_size":1024,"cursor":cursor}),
                &token,
                Instant::now() + TIMEOUT,
            )
            .unwrap();
        page_bytes += serde_json::to_vec(&page).unwrap().len();
        cursor = page["cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    let fuzzy = session
        .rpc(
            "files/fuzzy",
            json!({"query":"main","max_results":100}),
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    let fuzzy_bytes = serde_json::to_vec(&fuzzy).unwrap().len();
    let before = session
        .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
        .unwrap();
    let mut edit_timings = Vec::new();
    let path = root.path().join("src/component_00000/main.rs");
    for number in 0..20 {
        fs::write(&path, format!("pub fn changed_{number}() {{}}\n")).unwrap();
        session.paths_changed(&[session.root.join("src/component_00000/main.rs")]);
        let start = Instant::now();
        session.file_fuzzy("main", 100, &token).unwrap();
        edit_timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    edit_timings.sort_by(f64::total_cmp);
    let after = session
        .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
        .unwrap();
    eprintln!(
        "fuzzy_ms median={:.3} p95={:.3} page_payload_bytes={page_bytes} fuzzy_payload_bytes={fuzzy_bytes} edits_fuzzy_ms median={:.3} p95={:.3} full_walks_before={} after={} paths_checked={}",
        fuzzy_timings[10],
        fuzzy_timings[18],
        edit_timings[10],
        edit_timings[18],
        before["file_catalog"]["full_reconciliations"],
        after["file_catalog"]["full_reconciliations"],
        after["file_catalog"]["paths_checked"]
    );
}

#[test]
fn real_server_searches_in_path_order_with_one_global_limit_and_scope() {
    let (root, _index, session) = fixture();
    fs::create_dir(root.path().join("src")).unwrap();
    fs::write(root.path().join("a.rs"), "needle\n".repeat(75)).unwrap();
    fs::write(root.path().join("src/b.rs"), "needle\n".repeat(75)).unwrap();
    fs::write(root.path().join(".env"), "needle private\n").unwrap();
    #[cfg(windows)]
    let literal_name = "src/[odd].rs";
    #[cfg(not(windows))]
    let literal_name = "src/[odd]*?.rs";
    fs::write(root.path().join(literal_name), "rare_marker\n").unwrap();
    session.rebuild(&CancellationSource::new().token()).unwrap();
    let result = search(&session, "needle");
    assert!(result.indexed && result.limit_hit);
    assert_eq!(result.matches.len(), 100);
    assert_eq!(result.matches[0].path, Path::new("a.rs"));
    assert_eq!(result.matches[99].path, Path::new("src/b.rs"));
    assert_eq!(result.matches[99].line_number, 25);
    assert_eq!(search(&session, "rare_marker").matches.len(), 1);
    let result = session
        .search(
            &Query {
                pattern: "needle",
                scope: Path::new("src"),
                case_insensitive: false,
                include: &[],
                max_results: 100,
                current: false,
                exclude: &["**/.env"],
            },
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(result.matches.len(), 75);
    assert!(!result.limit_hit);
}

#[test]
fn ash_edits_and_new_files_are_visible_without_waiting_for_watcher() {
    let (root, _index, session) = fixture();
    let path = root.path().join("source.rs");
    fs::write(&path, "before_marker\n").unwrap();
    session.rebuild(&CancellationSource::new().token()).unwrap();
    assert_eq!(search(&session, "before_marker").matches.len(), 1);
    fs::write(&path, "after_marker\n").unwrap();
    let new = root.path().join("new.rs");
    fs::write(&new, "after_marker\n").unwrap();
    // File tools notify canonical paths; macOS temporary directories may use the /var alias.
    session.paths_changed(&[
        fs::canonicalize(&path).unwrap(),
        fs::canonicalize(&new).unwrap(),
    ]);
    assert!(search(&session, "before_marker").matches.is_empty());
    assert_eq!(search(&session, "after_marker").matches.len(), 2);
    fs::remove_file(&new).unwrap();
    session.paths_changed(&[session.root.join("new.rs")]);
    assert_eq!(search(&session, "after_marker").matches.len(), 1);
}

#[test]
fn scanning_honors_globs_unicode_denials_and_literal_file_paths() {
    let (root, _index, session) = fixture();
    fs::write(root.path().join(".gitignore"), "ignored.rs\n").unwrap();
    fs::write(root.path().join("ignored.rs"), "Ünicode marker\n").unwrap();
    fs::write(root.path().join("normal.txt"), "Ünicode marker\n").unwrap();
    fs::write(root.path().join(".env"), "Ünicode marker\n").unwrap();
    let request = Query {
        pattern: "ünicode",
        scope: Path::new(""),
        case_insensitive: true,
        include: &["*.rs"],
        max_results: 100,
        current: true,
        exclude: &["**/.env"],
    };
    let result = session
        .search(&request, &CancellationSource::new().token())
        .unwrap();
    assert!(!result.indexed);
    assert_eq!(
        result
            .matches
            .iter()
            .map(|m| m.path.clone())
            .collect::<Vec<_>>(),
        vec![PathBuf::from("ignored.rs")]
    );
    let result = session
        .search(
            &Query {
                scope: Path::new("normal.txt"),
                include: &[],
                max_results: 100,
                current: false,
                ..request
            },
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(result.matches.len(), 1);
}

#[test]
fn indexed_globs_keep_corpus_admission_and_bound_filtered_matches() {
    let (root, _index, session) = fixture();
    fs::create_dir(root.path().join("src")).unwrap();
    fs::write(root.path().join(".gitignore"), "ignored.rs\n").unwrap();
    fs::create_dir(root.path().join("src/skip")).unwrap();
    fs::write(root.path().join("src/skip/d.rs"), "glob_marker\n").unwrap();
    fs::write(root.path().join("src/ignored.rs"), "glob_marker\n").unwrap();
    fs::write(root.path().join("src/.hidden.rs"), "glob_marker\n").unwrap();
    fs::write(root.path().join("src/a.txt"), "glob_marker\n".repeat(200)).unwrap();
    fs::write(root.path().join("src/b.rs"), "glob_marker\n".repeat(3)).unwrap();
    fs::write(root.path().join("src/c.rs"), "glob_marker\n").unwrap();
    let token = CancellationSource::new().token();
    let request = Query {
        pattern: "glob_marker",
        scope: Path::new("src"),
        case_insensitive: false,
        include: &["*.rs"],
        exclude: &["c.rs", "skip"],
        max_results: 2,
        current: false,
    };
    // Compare explicit disk scanning with the same indexed query and admission rules.
    let mut scan = session
        .scan(
            &request,
            &[session.root.join("src")],
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    scan.matches.truncate(request.max_results);
    assert!(scan.limit_hit && scan.index_stats.is_none());
    assert_eq!(
        scan.matches
            .iter()
            .map(|m| (m.path.as_path(), m.line_number))
            .collect::<Vec<_>>(),
        [(Path::new("src/b.rs"), 1), (Path::new("src/b.rs"), 2)]
    );
    session.rebuild(&token).unwrap();
    let indexed = session.search(&request, &token).unwrap();
    assert!(indexed.indexed && indexed.limit_hit);
    assert_eq!(indexed.matches, scan.matches);
    let stats = indexed.index_stats.unwrap();
    assert!(!stats.query_plan.is_empty());
    assert_eq!(stats.candidates, 1);
    assert!(stats.candidates <= stats.raw_candidates && stats.raw_candidates <= stats.total_files);
    fs::write(root.path().join("src/b.rs"), "glob_marker edited\n").unwrap();
    session.paths_changed(&[
        session.root.join("src/b.rs"),
        session.root.join("src/a.txt"),
        session.root.join("src/c.rs"),
        session.root.join("src/ignored.rs"),
        session.root.join("src/.hidden.rs"),
        session.root.join("src/skip/d.rs"),
    ]);
    let edited = session.search(&request, &token).unwrap();
    assert!(edited.indexed && !edited.limit_hit);
    assert_eq!(edited.matches.len(), 1);
    assert_eq!(edited.matches[0].content, "glob_marker edited");
    let current = session
        .search(
            &Query {
                current: true,
                max_results: 100,
                ..request
            },
            &token,
        )
        .unwrap();
    assert!(!current.indexed && current.index_stats.is_none());
    assert!(
        current
            .matches
            .iter()
            .any(|m| m.path == Path::new("src/ignored.rs"))
    );
}

#[test]
fn indexed_explicit_hidden_directory_preserves_visibility_during_scan_and_edits() {
    let (root, _index, session) = fixture();
    fs::create_dir(root.path().join(".github")).unwrap();
    fs::write(root.path().join(".github/workflow.yml"), "scope_marker\n").unwrap();
    fs::write(root.path().join(".github/.secret.yml"), "scope_marker\n").unwrap();
    let token = CancellationSource::new().token();
    let request = Query {
        pattern: "scope_marker",
        scope: Path::new(".github"),
        case_insensitive: false,
        include: &["*.yml"],
        exclude: &[],
        max_results: 100,
        current: false,
    };
    let scan = session
        .scan(
            &request,
            &[session.root.join(".github")],
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    assert_eq!(scan.matches.len(), 1);
    session.rebuild(&token).unwrap();
    assert_eq!(
        session.search(&request, &token).unwrap().matches,
        scan.matches
    );
    fs::write(
        root.path().join(".github/workflow.yml"),
        "scope_marker edited\n",
    )
    .unwrap();
    session.paths_changed(&[
        session.root.join(".github/workflow.yml"),
        session.root.join(".github/.secret.yml"),
    ]);
    let edited = session.search(&request, &token).unwrap();
    assert_eq!(edited.matches.len(), 1);
    assert_eq!(edited.matches[0].content, "scope_marker edited");
}

#[test]
fn cancellation_invalid_regex_and_outside_paths_fail_explicitly() {
    let (_root, _index, session) = fixture();
    let cancellation = CancellationSource::new();
    cancellation.cancel();
    let request = Query {
        pattern: "x",
        scope: Path::new(""),
        case_insensitive: false,
        include: &[],
        max_results: 100,
        current: false,
        exclude: &[],
    };
    assert!(matches!(
        session.search(&request, &cancellation.token()),
        Err(Error::Cancelled(_))
    ));
    assert!(
        session
            .search(
                &Query {
                    pattern: "[",
                    ..request
                },
                &CancellationSource::new().token()
            )
            .is_err()
    );
    assert!(
        session
            .search(
                &Query {
                    scope: Path::new("../escape"),
                    ..request
                },
                &CancellationSource::new().token()
            )
            .is_err()
    );
}

#[test]
fn dropping_session_reaps_server_and_allows_reopening_index() {
    let (root, index, session) = fixture();
    let info: Value =
        serde_json::from_slice(&fs::read(root.path().join(".git/tgrep-daemon-v1.json")).unwrap())
            .unwrap();
    let port = info["port"].as_u64().unwrap() as u16;
    drop(session);
    assert!(std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    let session = Session::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &CancellationSource::new().token(),
    )
    .unwrap();
    assert!(search(&session, "absent").matches.is_empty());
}

#[test]
fn edited_paths_still_obey_ignore_rules_and_denials() {
    let (root, _index, session) = fixture();
    fs::write(root.path().join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir(root.path().join("ignored")).unwrap();
    session.rebuild(&CancellationSource::new().token()).unwrap();
    let mut changed = Vec::new();
    for name in ["ignored/new.rs", ".secret", "private.rs", "public.rs"] {
        let path = root.path().join(name);
        fs::write(&path, "edited_marker\n").unwrap();
        changed.push(fs::canonicalize(path).unwrap());
    }
    session.paths_changed(&changed);
    let result = session
        .search(
            &Query {
                pattern: "edited_marker",
                scope: Path::new(""),
                case_insensitive: false,
                include: &[],
                max_results: 100,
                current: false,
                exclude: &["private.rs"],
            },
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(
        result
            .matches
            .iter()
            .map(|m| m.path.as_path())
            .collect::<Vec<_>>(),
        vec![Path::new("public.rs")]
    );
}

#[test]
fn indexed_case_insensitive_search_preserves_unicode_folding() {
    let (root, _index, session) = fixture();
    fs::write(root.path().join("unicode.txt"), "Kelvin\n").unwrap();
    fs::write(root.path().join("ascii.txt"), "Kelvin\n").unwrap();
    session.rebuild(&CancellationSource::new().token()).unwrap();
    let query = Query {
        pattern: ".*kelvin.*",
        scope: Path::new(""),
        case_insensitive: true,
        include: &[],
        max_results: 100,
        current: false,
        exclude: &[],
    };
    let result = session
        .search(&query, &CancellationSource::new().token())
        .unwrap();
    assert!(result.indexed);
    assert_eq!(result.matches.len(), 2);
    let result = session
        .search(
            &Query {
                pattern: "(?-i)Kelvin",
                ..query
            },
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert!(result.indexed);
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, Path::new("ascii.txt"));
}

#[test]
fn indexed_case_flags_match_current_search() {
    let (root, _index, session) = fixture();
    fs::write(
        root.path().join("source.txt"),
        "SHELLSHOCK\nſhellſhocK\nBaShDoOr\nPREFIXhelloSUFFIX\nprefixHELLOsuffix\nprefixÉsuffix\nprefixésuffix\n",
    )
    .unwrap();
    session.rebuild(&CancellationSource::new().token()).unwrap();
    for (pattern, case_insensitive, expected_lines) in [
        ("shellshock|bashdoor", true, vec![1, 2, 3]),
        ("(?i)shellshock|bashdoor", false, vec![1, 2, 3]),
        ("PREFIX(?i:hello)SUFFIX", false, vec![4]),
        ("prefix(?-i:HELLO)suffix", true, vec![5]),
        ("(?i)prefix(?-i:HELLO)suffix", false, vec![5]),
        ("prefixésuffix", true, vec![6, 7]),
    ] {
        let query = Query {
            pattern,
            scope: Path::new(""),
            case_insensitive,
            include: &[],
            max_results: 100,
            current: false,
            exclude: &[],
        };
        let indexed = session
            .search(&query, &CancellationSource::new().token())
            .unwrap();
        assert!(indexed.indexed, "{pattern}");
        assert_eq!(
            indexed
                .matches
                .iter()
                .map(|found| found.line_number)
                .collect::<Vec<_>>(),
            expected_lines,
            "{pattern}"
        );
        let current = session
            .search(
                &Query {
                    current: true,
                    ..query
                },
                &CancellationSource::new().token(),
            )
            .unwrap();
        assert!(!current.indexed);
        assert_eq!(indexed.matches, current.matches, "{pattern}");
    }
}

#[test]
fn linked_worktrees_share_one_process_and_keep_committed_changes_private() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(root.path(), &["config", "user.name", "Search Test"]);
    git(
        root.path(),
        &["config", "user.email", "search@example.test"],
    );
    fs::write(root.path().join("source.rs"), "base_marker\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "base"]);
    let linked = tempfile::tempdir().unwrap();
    let worktree = linked.path().join("worktree");
    git(
        root.path(),
        &["worktree", "add", "-b", "agent", worktree.to_str().unwrap()],
    );
    let index = tempfile::tempdir().unwrap();
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let token = CancellationSource::new().token();
    let first = Session::open(executable.clone(), root.path(), index.path(), &token).unwrap();
    let second = Session::open(executable, &worktree, index.path(), &token).unwrap();
    assert!(std::sync::Arc::ptr_eq(&first.process, &second.process));
    match (&first.registration, &second.registration) {
        (Registration::Shared { view: first, .. }, Registration::Shared { view: second, .. }) => {
            assert_ne!(first, second)
        }
        _ => panic!("expected shared registrations"),
    }
    assert_eq!(fs::read_dir(index.path().join("bases")).unwrap().count(), 1);
    fs::write(worktree.join("source.rs"), "branch_marker\n").unwrap();
    git(&worktree, &["add", "."]);
    git(&worktree, &["commit", "-m", "branch change"]);
    second.paths_changed(&[second.root.join("source.rs")]);
    assert!(search(&second, "base_marker").matches.is_empty());
    assert_eq!(search(&second, "branch_marker").matches.len(), 1);
    assert_eq!(search(&first, "base_marker").matches.len(), 1);
    drop(first);
    assert_eq!(search(&second, "branch_marker").matches.len(), 1);
}

#[test]
fn plain_and_unborn_directories_use_the_single_directory_service() {
    for unborn in [false, true] {
        let root = tempfile::tempdir().unwrap();
        if unborn {
            git(root.path(), &["init", "-b", "main"]);
        }
        fs::write(root.path().join("source.txt"), "plain_marker\n".repeat(120)).unwrap();
        fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.path().join("ignored.txt"), "plain_marker\n").unwrap();
        let index = tempfile::tempdir().unwrap();
        let token = CancellationSource::new().token();
        let executable = Executable::resolve(&InstallContext::current()).unwrap();
        assert_eq!(
            executable.directory_identity(root.path(), &token).unwrap(),
            fs::canonicalize(root.path()).unwrap()
        );
        let session = Session::open(executable, root.path(), index.path(), &token).unwrap();
        assert!(matches!(session.registration, Registration::Directory));
        let result = search(&session, "plain_marker");
        assert!(result.indexed && result.limit_hit);
        assert_eq!(result.matches.len(), 100);
        assert!(
            result
                .matches
                .iter()
                .all(|m| m.path == Path::new("source.txt"))
        );
        fs::write(root.path().join("source.txt"), "updated_marker\n").unwrap();
        session.paths_changed(&[session.root.join("source.txt")]);
        assert!(search(&session, "plain_marker").matches.is_empty());
        assert_eq!(search(&session, "updated_marker").matches.len(), 1);
    }
}

#[test]
fn independent_leases_release_only_their_own_registration() {
    let (root, index, first) = fixture();
    let token = CancellationSource::new().token();
    let second =
        Session::open(first.executable.clone(), root.path(), index.path(), &token).unwrap();
    let (first_view, first_lease, generation) = match &first.registration {
        Registration::Shared {
            root: wire_root,
            view,
            lease,
            generation,
        } => {
            assert_eq!(wire_root, &fs::canonicalize(root.path()).unwrap());
            (view, lease, generation)
        }
        _ => panic!("expected shared registration"),
    };
    match &second.registration {
        Registration::Shared { view, lease, .. } => {
            assert_eq!(view, first_view);
            assert_ne!(lease, first_lease);
        }
        _ => panic!("expected shared registration"),
    }
    let original = first.process.rpc("attach", json!({"root":first.root,"revision":"HEAD","profile":profile(),"lease":"recoverable-test"}), &token, Instant::now()+TIMEOUT).unwrap();
    let replayed = first.process.rpc("attach", json!({"root":first.root,"revision":"HEAD","profile":profile(),"lease":"recoverable-test"}), &token, Instant::now()+TIMEOUT).unwrap();
    assert_eq!(original["view"], replayed["view"]);
    assert_eq!(original["generation"], *generation);
    first
        .process
        .rpc(
            "detach",
            json!({"root":first.root,"view":first_view,"lease":"recoverable-test"}),
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    drop(first);
    fs::write(root.path().join("source.rs"), "lease_marker\n").unwrap();
    second.paths_changed(&[second.root.join("source.rs")]);
    assert_eq!(search(&second, "lease_marker").matches.len(), 1);
    let process = std::sync::Arc::clone(&second.process);
    drop(second);
    assert!(!root.path().join(".git/tgrep-view-v1.json").exists());
    assert!(
        process
            .rpc(
                "lookup",
                json!({"root":fs::canonicalize(root.path()).unwrap()}),
                &token,
                Instant::now() + TIMEOUT
            )
            .is_err()
    );
}

#[test]
fn packaged_fixed_string_queries_preserve_unicode_case_folding() {
    let (root, _index, session) = fixture();
    fs::write(
        root.path().join("unicode.txt"),
        "CAFÉ\ncafé\nſhellſhocK\nSHELLSHOCK\n",
    )
    .unwrap();
    let token = CancellationSource::new().token();
    session.rebuild(&token).unwrap();
    for pattern in ["café", "shellshock"] {
        let value = session
            .rpc(
                "search",
                json!({"pattern":pattern,"fixed_string":true,"case_insensitive":true,
            "max_count":3,"max_results":3,"detail":false,"positions":false,"stats":true}),
                &token,
                Instant::now() + TIMEOUT,
            )
            .unwrap();
        assert_eq!(rows(&value).unwrap().len(), 2, "{pattern}: {value}");
    }
}

#[test]
fn interrupted_attachment_releases_its_recoverable_lease() {
    let (_root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    let params = json!({"root":session.root,"revision":"HEAD","profile":profile(),"lease":"interrupted-test"});
    let pending = PendingAttachment {
        process: std::sync::Arc::clone(&session.process),
        params: Some(params.clone()),
        lifetime: None,
    };
    // Model a completed request whose response the caller lost before publishing its Session.
    session
        .process
        .rpc("attach", params, &token, Instant::now() + TIMEOUT)
        .unwrap();
    assert_eq!(
        session
            .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
            .unwrap()["leases"],
        2
    );
    drop(pending);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = session.rpc("status", json!({}), &token, deadline).unwrap();
        if status["leases"] == 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "attachment lease was not released: {status}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn detach_can_be_retried_after_the_engine_released_the_lease() {
    let (root, _index, mut session) = fixture();
    let token = CancellationSource::new().token();
    let Registration::Shared {
        root: wire_root,
        view,
        lease,
        ..
    } = &session.registration
    else {
        panic!("expected shared registration")
    };
    // The reply was delivered to the socket but lost before the caller recorded completion.
    session
        .process
        .rpc(
            "detach",
            json!({"root":wire_root,"view":view,"lease":lease}),
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    assert!(!root.path().join(".git/tgrep-view-v1.json").exists());
    session.close(&token).unwrap();
    assert!(matches!(session.registration, Registration::Released));
    session.close(&token).unwrap();
}

#[cfg(unix)]
#[test]
fn packaged_index_reads_reject_directory_links_after_indexing() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("root");
    let outside = temporary.path().join("outside");
    let index = temporary.path().join("index");
    fs::create_dir_all(root.join("src/nested")).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("src/nested/file.txt"), "needle inside\n").unwrap();
    fs::write(root.join("kept.txt"), "needle kept\n").unwrap();
    fs::write(outside.join("file.txt"), "needle OUTSIDE_SENTINEL\n").unwrap();
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let built = std::process::Command::new(&executable.0)
        .arg("--index-path")
        .arg(&index)
        .arg("--no-require-git")
        .arg("index")
        .arg(&root)
        .output()
        .unwrap();
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    fs::rename(root.join("src/nested"), temporary.path().join("saved")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("src/nested")).unwrap();
    for scope in [&root, &root.join("src")] {
        let result = std::process::Command::new(&executable.0)
            .arg("--index-path")
            .arg(&index)
            .arg("--stats")
            .arg("--")
            .arg("needle")
            .arg(scope)
            .output()
            .unwrap();
        let output = String::from_utf8(result.stdout).unwrap();
        let error = String::from_utf8(result.stderr).unwrap();
        assert_eq!(
            result.status.code(),
            Some(if scope == &root { 0 } else { 1 }),
            "{error}"
        );
        assert!(!output.contains("OUTSIDE_SENTINEL"), "{output}");
        assert!(
            error.contains("Query plan:"),
            "must exercise the index: {error}"
        );
        assert!(error.contains("cannot read indexed file"), "{error}");
        if scope == &root {
            assert!(output.contains("needle kept"), "{output}");
        }
    }
}

#[cfg(unix)]
#[test]
fn cold_process_startup_waits_only_for_its_repository_and_observes_cancellation() {
    use std::os::unix::fs::PermissionsExt;
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_index = tempfile::tempdir().unwrap();
    let second_index = tempfile::tempdir().unwrap();
    let shims = tempfile::tempdir().unwrap();
    for root in [first.path(), second.path()] {
        git(root, &["init", "-b", "main"]);
        git(
            root,
            &[
                "-c",
                "user.name=Search Test",
                "-c",
                "user.email=search@example.test",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        fs::write(root.join("source.rs"), "needle").unwrap();
    }
    let packaged = Executable::resolve(&InstallContext::current()).unwrap();
    let entered = shims.path().join("entered");
    let release = shims.path().join("release");
    let once = shims.path().join("once");
    struct ReleaseOnDrop(PathBuf);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "release");
        }
    }
    let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    let wrapper = shims.path().join("tgrep");
    fs::write(&wrapper, format!(
        "#!/bin/sh\nif [ \"$1\" = --version ] && mkdir {} 2>/dev/null; then\n: > {}\nwhile [ ! -f {} ]; do sleep 0.02; done\nfi\nexec {} \"$@\"\n",
        quote(&once), quote(&entered), quote(&release), quote(&packaged.0))).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let executable = Executable::from_path(&wrapper).unwrap();
    let token = CancellationSource::new().token();
    std::thread::scope(|scope| {
        let _release = ReleaseOnDrop(release.clone());
        let executable = &executable;
        let token = &token;
        let first_root = first.path();
        let second_root = second.path();
        let first_index = first_index.path();
        let second_index = second_index.path();
        let (first_tx, first_rx) = std::sync::mpsc::channel();
        scope.spawn(move || {
            first_tx
                .send(Session::open(
                    executable.clone(),
                    first_root,
                    first_index,
                    token,
                ))
                .unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !entered.is_file() {
            assert!(
                Instant::now() < deadline,
                "first process did not reach startup"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let (second_tx, second_rx) = std::sync::mpsc::channel();
        scope.spawn(move || {
            second_tx
                .send(Session::open(
                    executable.clone(),
                    second_root,
                    second_index,
                    token,
                ))
                .unwrap();
        });
        let second_session = second_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("another repository must not wait for the first process")
            .unwrap();
        assert_eq!(
            second_session.files(token).unwrap(),
            [PathBuf::from("source.rs")]
        );
        let cancellation = CancellationSource::new();
        let cancelled_token = cancellation.token();
        cancellation.cancel();
        let (wait_tx, wait_rx) = std::sync::mpsc::channel();
        scope.spawn(move || {
            wait_tx
                .send(process::Server::shared(
                    executable,
                    first_root,
                    first_index,
                    &cancelled_token,
                ))
                .unwrap();
        });
        assert!(matches!(
            wait_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(Error::Cancelled(_))
        ));
        fs::write(&release, "release").unwrap();
        let first_session = first_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert!(!std::sync::Arc::ptr_eq(
            &first_session.process,
            &second_session.process
        ));
        assert_eq!(
            first_session.files(token).unwrap(),
            [PathBuf::from("source.rs")]
        );
    });
}

#[test]
fn closing_a_stopped_server_releases_its_registration() {
    let (_root, _index, mut session) = fixture();
    let token = CancellationSource::new().token();
    session.process.stop().unwrap();
    session.close(&token).unwrap();
    assert!(matches!(session.registration, Registration::Released));
}

#[test]
fn engine_fuzzy_returns_top_k_with_the_shared_ranker_scores_and_highlights() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("src")).unwrap();
    for number in 0..1050 {
        fs::write(
            root.path().join(format!("src/file_picker_{number:04}.rs")),
            "content",
        )
        .unwrap();
    }
    for path in ["FILEPICKER.rs", "src/中文-é.rs", ".hidden-filepicker.bin"] {
        fs::write(root.path().join(path), [0, 255, 0]).unwrap();
    }
    for directory in [".ash", "node_modules", "target"] {
        fs::create_dir_all(root.path().join(directory)).unwrap();
        fs::write(
            root.path().join(directory).join("filepicker.rs"),
            "excluded",
        )
        .unwrap();
    }
    fs::write(root.path().join(".gitignore"), "ignored-filepicker.rs\n").unwrap();
    fs::write(root.path().join("ignored-filepicker.rs"), "ignored").unwrap();
    let token = CancellationSource::new().token();
    let session = Session::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    for query in [
        "",
        "filepicker",
        "^src",
        "'picker",
        "!bin",
        "中é",
        "é",
        "no-such-file",
    ] {
        for limit in [1, 7, 100] {
            let engine = session.file_fuzzy(query, limit, &token).unwrap();
            let expected = ash_file_search::Service
                .fuzzy(root.path().to_path_buf(), query, limit, &token)
                .unwrap();
            assert_eq!(
                engine.total_match_count, expected.total_match_count,
                "{query}"
            );
            assert_eq!(engine.scanned_file_count, expected.scanned_file_count);
            assert!(engine.matches.len() <= limit);
            assert_eq!(
                engine
                    .matches
                    .into_iter()
                    .map(|matched| ash_file_search::PathMatch {
                        score: matched.score,
                        path: matched.path,
                        indices: matched.indices
                    })
                    .collect::<Vec<_>>(),
                expected.matches,
                "{query}"
            );
        }
    }
    assert_eq!(
        session.file_fuzzy("filepicker", 1, &token).unwrap().matches[0].path,
        Path::new("FILEPICKER.rs")
    );
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert!(matches!(
        session.file_fuzzy("file", 10, &cancelled.token()),
        Err(Error::Cancelled(_))
    ));
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

#[cfg(unix)]
fn unwatched_engine(directory: &Path, engine: &Executable) -> Executable {
    use std::os::unix::fs::PermissionsExt;
    let wrapper = directory.join("tgrep");
    fs::write(&wrapper, format!("#!/bin/sh\nfor argument in \"$@\"; do\nif [ \"$argument\" = serve ]; then\nexec {} \"$@\" --no-watch\nfi\ndone\nexec {} \"$@\"\n", shell_quote(&engine.0), shell_quote(&engine.0))).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    Executable::from_path(wrapper).unwrap()
}

#[test]
#[ignore = "manual hinted content refresh measurement"]
fn shared_content_refresh_benchmark() {
    let (root, index) = benchmark_repository();
    let token = CancellationSource::new().token();
    let engine = Executable::resolve(&InstallContext::current()).unwrap();
    #[cfg(unix)]
    let wrapper = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let engine = unwatched_engine(wrapper.path(), &engine);
    let session = Session::open(engine, root.path(), index.path(), &token).unwrap();
    session.rebuild(&token).unwrap();
    let mut timings = Vec::new();
    let path = session.root.join("src/component_00000/main.rs");
    for number in 0..20 {
        let marker = format!("content_edit_{number}");
        fs::write(&path, format!("pub fn {marker}() {{}}\n")).unwrap();
        session.paths_changed(std::slice::from_ref(&path));
        let start = Instant::now();
        let result = search(&session, &marker);
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
        assert!(result.indexed);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(
            result.matches[0].path,
            Path::new("src/component_00000/main.rs")
        );
    }
    timings.sort_by(f64::total_cmp);
    let status = session
        .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
        .unwrap();
    eprintln!(
        "content_refresh runtime={VERSION} paths=10000 edits=20 median_ms={:.3} p95_ms={:.3} last_reconcile={}",
        timings[10], timings[18], status["last_reconcile"]
    );
}

#[cfg(unix)]
fn content_fixture(
    files: &[(&str, &str)],
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    tempfile::TempDir,
    Session,
) {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let wrapper = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    for (path, content) in files {
        let path = root.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    git(root.path(), &["add", "."]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=search@example.test",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    let engine = Executable::resolve(&InstallContext::current()).unwrap();
    let token = CancellationSource::new().token();
    let session = Session::open(
        unwatched_engine(wrapper.path(), &engine),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    session.rebuild(&token).unwrap();
    (root, index, wrapper, session)
}

#[cfg(unix)]
fn content_stats(session: &Session) -> Value {
    session
        .rpc(
            "status",
            json!({}),
            &CancellationSource::new().token(),
            Instant::now() + TIMEOUT,
        )
        .unwrap()["last_reconcile"]
        .clone()
}

#[cfg(unix)]
#[test]
fn content_hints_check_only_changed_files_and_preserve_verified_siblings() {
    let (_root, _index, _wrapper, session) = content_fixture(&[
        ("dir/a.rs", "before_marker"),
        ("dir/b.rs", "unchanged_marker"),
        ("directory/other.rs", "neighbor_marker"),
    ]);
    let path = session.root.join("dir/a.rs");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "edited_marker").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    session.paths_changed(std::slice::from_ref(&path));
    assert_eq!(search(&session, "edited_marker").matches.len(), 1);
    assert!(search(&session, "before_marker").matches.is_empty());
    assert_eq!(search(&session, "unchanged_marker").matches.len(), 1);
    assert_eq!(search(&session, "neighbor_marker").matches.len(), 1);
    let stats = content_stats(&session);
    assert_eq!(stats["full"], false);
    assert_eq!(stats["files_discovered"], 1);
    assert_eq!(stats["metadata_files_checked"], 1);
    assert_eq!(stats["files_read"], 1);
    assert_eq!(stats["content_reads_avoided"], 2);

    let added = session.root.join("NewUpper.rs");
    fs::write(&added, "addition_marker").unwrap();
    session.paths_changed(std::slice::from_ref(&added));
    let found = search(&session, "addition_marker");
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].path, Path::new("NewUpper.rs"));
    assert_eq!(content_stats(&session)["metadata_files_checked"], 1);

    let renamed = session.root.join("Renamed.rs");
    fs::rename(&added, &renamed).unwrap();
    session.paths_changed(&[added, renamed.clone()]);
    let found = search(&session, "addition_marker");
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].path, Path::new("Renamed.rs"));
    assert_eq!(content_stats(&session)["metadata_files_checked"], 1);
    fs::remove_file(&renamed).unwrap();
    session.paths_changed(&[renamed]);
    assert!(search(&session, "addition_marker").matches.is_empty());
    assert_eq!(content_stats(&session)["metadata_files_checked"], 0);

    fs::write(&path, [0, 0, 255]).unwrap();
    session.paths_changed(std::slice::from_ref(&path));
    assert!(search(&session, "edited_marker").matches.is_empty());
    fs::write(&path, "restored_marker").unwrap();
    session.paths_changed(std::slice::from_ref(&path));
    assert_eq!(search(&session, "restored_marker").matches.len(), 1);
    assert_eq!(content_stats(&session)["metadata_files_checked"], 1);

    // Explicit full repair remains the recovery path for an event the host never received.
    fs::write(&path, "missed_event_marker").unwrap();
    session.rebuild(&CancellationSource::new().token()).unwrap();
    assert_eq!(search(&session, "missed_event_marker").matches.len(), 1);
    assert!(search(&session, "restored_marker").matches.is_empty());
    let stats = content_stats(&session);
    assert_eq!(stats["full"], true);
    assert_eq!(stats["metadata_files_checked"], 3);
}

#[cfg(unix)]
#[test]
fn content_directory_hints_repair_only_the_subtree_and_retire_replaced_ancestors() {
    let (_root, _index, _wrapper, session) = content_fixture(&[
        ("dir/a.rs", "subtree_marker"),
        ("dir/nested/b.rs", "subtree_marker"),
        ("directory/other.rs", "outside_marker"),
    ]);
    let dir = session.root.join("dir");
    let moved = session.root.join("Moved");
    fs::rename(&dir, &moved).unwrap();
    session.paths_changed(&[dir.clone(), moved.clone()]);
    let found = search(&session, "subtree_marker");
    assert_eq!(found.matches.len(), 2);
    assert!(
        found
            .matches
            .iter()
            .all(|hit| hit.path.starts_with("Moved"))
    );
    let stats = content_stats(&session);
    assert_eq!(stats["full"], false);
    assert_eq!(stats["metadata_files_checked"], 2);
    assert_eq!(stats["content_reads_avoided"], 1);
    assert_eq!(search(&session, "outside_marker").matches.len(), 1);

    fs::remove_dir_all(&moved).unwrap();
    fs::write(&moved, "replacement_marker").unwrap();
    session.paths_changed(&[moved.join("nested/b.rs")]);
    assert!(search(&session, "subtree_marker").matches.is_empty());
    let found = search(&session, "replacement_marker");
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].path, Path::new("Moved"));
    assert_eq!(content_stats(&session)["metadata_files_checked"], 1);

    fs::remove_file(&moved).unwrap();
    std::os::unix::fs::symlink(session.root.join("directory"), &moved).unwrap();
    session.paths_changed(&[moved.join("other.rs")]);
    assert!(search(&session, "replacement_marker").matches.is_empty());
    let found = search(&session, "outside_marker");
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].path, Path::new("directory/other.rs"));
    assert_eq!(content_stats(&session)["metadata_files_checked"], 0);

    fs::remove_file(&moved).unwrap();
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("new.rs"), "new_directory_marker").unwrap();
    session.paths_changed(&[dir.clone()]);
    assert_eq!(search(&session, "new_directory_marker").matches.len(), 1);
    assert_eq!(content_stats(&session)["metadata_files_checked"], 1);
    fs::remove_dir_all(&dir).unwrap();
    session.paths_changed(&[dir.join("new.rs")]);
    assert!(search(&session, "new_directory_marker").matches.is_empty());
    assert_eq!(content_stats(&session)["metadata_files_checked"], 0);
}

#[cfg(unix)]
#[test]
fn content_hints_rebuild_admission_when_ignore_sources_appear_change_or_disappear() {
    let (_root, _index, _wrapper, session) = content_fixture(&[
        ("dir/public.rs", "policy_marker"),
        ("dir/private.secret", "policy_marker"),
        ("outside.rs", "outside_marker"),
    ]);
    let dir = session.root.join("dir");
    fs::write(dir.join(".ignore"), "*.secret\n").unwrap();
    session.paths_changed(&[dir.join("private.secret")]);
    let found = search(&session, "policy_marker");
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].path, Path::new("dir/public.rs"));
    assert_eq!(content_stats(&session)["full"], true);

    fs::write(dir.join("public.rs"), "changed_policy_marker").unwrap();
    session.paths_changed(&[dir.join("public.rs")]);
    assert_eq!(search(&session, "changed_policy_marker").matches.len(), 1);
    let stats = content_stats(&session);
    assert_eq!(stats["full"], false);
    assert_eq!(stats["metadata_files_checked"], 1);

    fs::write(dir.join(".ignore"), "*.rs\n").unwrap();
    session.paths_changed(&[dir.join("private.secret")]);
    let found = search(&session, "policy_marker");
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].path, Path::new("dir/private.secret"));
    assert_eq!(content_stats(&session)["full"], true);

    fs::remove_file(dir.join(".ignore")).unwrap();
    session.paths_changed(&[dir.join("public.rs")]);
    assert_eq!(search(&session, "policy_marker").matches.len(), 2);
    assert_eq!(content_stats(&session)["full"], true);
    fs::write(dir.join(".ignore"), "*.secret\n").unwrap();
    session.paths_changed(std::slice::from_ref(&dir));
    assert_eq!(search(&session, "policy_marker").matches.len(), 1);
    fs::remove_dir_all(&dir).unwrap();
    session.paths_changed(&[dir.join("public.rs")]);
    assert!(search(&session, "policy_marker").matches.is_empty());
    assert_eq!(content_stats(&session)["full"], true);
    assert_eq!(search(&session, "outside_marker").matches.len(), 1);
}

#[cfg(unix)]
#[test]
fn content_hints_follow_changes_in_the_tracked_ignorecase_exemption() {
    let (_root, _index, _wrapper, session) = content_fixture(&[
        ("source.rs", "tracked_marker"),
        ("outside.rs", "outside_marker"),
    ]);
    git(&session.root, &["config", "core.ignorecase", "true"]);
    fs::write(session.root.join(".gitignore"), "SOURCE.RS\n").unwrap();
    session.paths_changed(&[session.root.join(".gitignore")]);
    assert_eq!(search(&session, "tracked_marker").matches.len(), 1);
    git(&session.root, &["rm", "--cached", "source.rs"]);
    session.paths_changed(&[session.root.join("outside.rs")]);
    assert!(search(&session, "tracked_marker").matches.is_empty());
    assert_eq!(content_stats(&session)["full"], true);
    git(&session.root, &["add", "--force", "source.rs"]);
    session.paths_changed(&[session.root.join("outside.rs")]);
    assert_eq!(search(&session, "tracked_marker").matches.len(), 1);
    assert_eq!(content_stats(&session)["full"], true);
}

#[cfg(unix)]
#[test]
fn content_hints_reverify_case_aliases_and_discover_new_case_spellings() {
    let (_root, _index, _wrapper, session) = content_fixture(&[
        ("dir/one.rs", "old_case_marker"),
        ("dir/two.rs", "sibling_marker"),
        ("outside.rs", "outside_marker"),
    ]);
    fs::write(session.root.join("dir/one.rs"), "new_case_marker").unwrap();
    session.paths_changed(&[session.root.join("DIR")]);
    assert_eq!(search(&session, "new_case_marker").matches.len(), 1);
    let stats = content_stats(&session);
    assert_eq!(stats["full"], false);
    assert_eq!(stats["metadata_files_checked"], 2);
    assert_eq!(stats["content_reads_avoided"], 1);

    let upper = session.root.join("dir/ONE.rs");
    if !upper.exists() {
        // A hard link with a separate case-sensitive name still needs its own indexed path.
        fs::hard_link(session.root.join("dir/one.rs"), &upper).unwrap();
        session.paths_changed(&[upper]);
        let found = search(&session, "new_case_marker");
        assert_eq!(found.matches.len(), 2);
        assert!(
            found
                .matches
                .iter()
                .any(|hit| hit.path == Path::new("dir/ONE.rs"))
        );
        assert_eq!(content_stats(&session)["full"], true);
    }
}

#[cfg(unix)]
#[test]
fn filename_repairs_keep_content_edits_local_and_reconcile_directory_and_ignore_changes() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let wrapper = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("src")).unwrap();
    fs::write(root.path().join("src/a.rs"), "initial").unwrap();
    fs::write(root.path().join("src/b.rs"), "initial").unwrap();
    fs::write(root.path().join("src-other.rs"), "prefix neighbor").unwrap();
    fs::write(root.path().join(".ignore"), "*.ignored\n").unwrap();
    let engine = Executable::resolve(&InstallContext::current()).unwrap();
    let token = CancellationSource::new().token();
    let session = Session::open(
        unwatched_engine(wrapper.path(), &engine),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    session.files(&token).unwrap();
    let status = || {
        session
            .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
            .unwrap()
    };
    let initial = status()["file_catalog"].clone();
    let initial_page = session
        .rpc(
            "files/page",
            json!({"page_size":1024,"cursor":null}),
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    for number in 0..20 {
        fs::write(root.path().join("src/a.rs"), format!("edit {number}")).unwrap();
        session.paths_changed(&[session.root.join("src/a.rs")]);
        assert_eq!(
            session
                .file_fuzzy("a.rs", 10, &token)
                .unwrap()
                .matches
                .len(),
            1
        );
    }
    let edited = status()["file_catalog"].clone();
    assert_eq!(
        edited["full_reconciliations"],
        initial["full_reconciliations"]
    );
    assert_eq!(edited["paths_checked"].as_u64().unwrap(), 20);
    let edited_page = session
        .rpc(
            "files/page",
            json!({"page_size":1024,"cursor":null}),
            &token,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
    assert_eq!(
        initial_page["epoch"], edited_page["epoch"],
        "content changes preserve file cursor identity"
    );
    fs::write(root.path().join("new.ignored"), "ignored").unwrap();
    fs::write(root.path().join("new.bin"), [0, 255]).unwrap();
    session.paths_changed(&[
        session.root.join("new.ignored"),
        session.root.join("new.bin"),
    ]);
    let files = session.files(&token).unwrap();
    assert!(!files.contains(&PathBuf::from("new.ignored")));
    assert!(files.contains(&PathBuf::from("new.bin")));
    fs::rename(root.path().join("src"), root.path().join("src-new")).unwrap();
    session.paths_changed(&[session.root.join("src"), session.root.join("src-new")]);
    let files = session.files(&token).unwrap();
    assert!(!files.iter().any(|path| path.starts_with("src")));
    assert!(files.contains(&PathBuf::from("src-new/a.rs")));
    assert!(files.contains(&PathBuf::from("src-other.rs")));
    assert_eq!(
        status()["file_catalog"]["full_reconciliations"],
        initial["full_reconciliations"]
    );
    fs::write(root.path().join(".ignore"), "src-new/\n").unwrap();
    session.paths_changed(&[session.root.join(".ignore")]);
    let files = session.files(&token).unwrap();
    assert!(!files.iter().any(|path| path.starts_with("src-new")));
    assert!(files.contains(&PathBuf::from("new.ignored")));
    assert_eq!(
        status()["file_catalog"]["full_reconciliations"]
            .as_u64()
            .unwrap(),
        initial["full_reconciliations"].as_u64().unwrap() + 1
    );
    fs::create_dir(root.path().join("nested")).unwrap();
    fs::write(root.path().join("nested/.ignore"), "*.secret\n").unwrap();
    fs::write(root.path().join("nested/visible.rs"), "visible").unwrap();
    fs::write(root.path().join("nested/hidden.secret"), "hidden").unwrap();
    session.paths_changed(&[session.root.join("nested")]);
    let files = session.files(&token).unwrap();
    assert!(files.contains(&PathBuf::from("nested/visible.rs")));
    assert!(!files.contains(&PathBuf::from("nested/hidden.secret")));
    fs::create_dir(root.path().join("leaf-only")).unwrap();
    fs::write(root.path().join("leaf-only/.ignore"), "*.secret\n").unwrap();
    fs::write(root.path().join("leaf-only/visible.rs"), "visible").unwrap();
    fs::write(root.path().join("leaf-only/hidden.secret"), "hidden").unwrap();
    session.paths_changed(&[session.root.join("leaf-only/hidden.secret")]);
    let files = session.files(&token).unwrap();
    assert!(files.contains(&PathBuf::from("leaf-only/visible.rs")));
    assert!(!files.contains(&PathBuf::from("leaf-only/hidden.secret")));
    std::os::unix::fs::symlink(root.path().join("nested"), root.path().join("link")).unwrap();
    session.paths_changed(&[session.root.join("link/visible.rs")]);
    assert!(
        !session
            .files(&token)
            .unwrap()
            .contains(&PathBuf::from("link/visible.rs"))
    );
}

#[cfg(unix)]
#[test]
fn shared_worktrees_refresh_independently_while_final_detach_waits_for_cancelled_reads() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let linked = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let shims = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(root.path(), &["config", "user.name", "Search Test"]);
    git(
        root.path(),
        &["config", "user.email", "search@example.test"],
    );
    fs::write(root.path().join("source.rs"), "base_marker\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "base"]);
    let worktree = linked.path().join("worktree");
    git(
        root.path(),
        &["worktree", "add", "-b", "agent", worktree.to_str().unwrap()],
    );
    let canonical_root = fs::canonicalize(root.path()).unwrap();
    let engine = Executable::resolve(&InstallContext::current()).unwrap();
    let git_path = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("git"))
        .find(|path| path.is_file())
        .unwrap();
    let block = shims.path().join("block");
    let entered = shims.path().join("entered");
    let release = shims.path().join("release");
    let git_shim = shims.path().join("git");
    fs::write(&git_shim, format!("#!/bin/sh\nif [ \"$PWD\" = {} ] && [ -f {} ]; then\nfor argument in \"$@\"; do\nif [ \"$argument\" = --absolute-git-dir ]; then\ntouch {}\nwhile [ ! -f {} ]; do sleep 0.02; done\nfi\ndone\nfi\nexec {} \"$@\"\n", shell_quote(&canonical_root), shell_quote(&block), shell_quote(&entered), shell_quote(&release), shell_quote(&git_path))).unwrap();
    fs::set_permissions(&git_shim, fs::Permissions::from_mode(0o755)).unwrap();
    let wrapper = shims.path().join("tgrep");
    fs::write(&wrapper, format!("#!/bin/sh\nexport PATH={}:\"$PATH\"\nfor argument in \"$@\"; do\nif [ \"$argument\" = serve ]; then\nexec {} \"$@\" --no-watch\nfi\ndone\nexec {} \"$@\"\n", shell_quote(shims.path()), shell_quote(&engine.0), shell_quote(&engine.0))).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let token = CancellationSource::new().token();
    let a = Session::open(
        Executable::from_path(&wrapper).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    let b = Session::open(
        Executable::from_path(&wrapper).unwrap(),
        &worktree,
        index.path(),
        &token,
    )
    .unwrap();
    a.rebuild(&token).unwrap();
    b.rebuild(&token).unwrap();
    assert!(std::sync::Arc::ptr_eq(&a.process, &b.process));
    let params = match &a.registration {
        Registration::Shared {
            root, view, lease, ..
        } => json!({"root":root,"view":view,"lease":lease,"full":true}),
        _ => panic!("expected shared registration"),
    };
    let revision = a
        .executable
        .identity(&a.root, &token)
        .unwrap()
        .revision
        .unwrap();
    fs::write(&block, "block").unwrap();
    struct ReleaseOnDrop(PathBuf);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "release");
        }
    }
    std::thread::scope(|scope| {
        let _release = ReleaseOnDrop(release.clone());
        let cancelled = CancellationSource::new();
        let (refresh_tx, refresh_rx) = std::sync::mpsc::channel();
        let cancellation = cancelled.token();
        let a = &a;
        let params = &params;
        scope.spawn(move || {
            refresh_tx
                .send(a.process.rpc(
                    "refresh",
                    params.clone(),
                    &cancellation,
                    Instant::now() + TIMEOUT,
                ))
                .unwrap()
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !entered.exists() {
            assert!(
                Instant::now() < deadline,
                "refresh did not enter root reads"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(worktree.join("source.rs"), "worktree_b_marker\n").unwrap();
        b.paths_changed(&[b.root.join("source.rs")]);
        let (other_tx, other_rx) = std::sync::mpsc::channel();
        let b = &b;
        scope.spawn(move || other_tx.send(search(b, "worktree_b_marker")).unwrap());
        assert_eq!(
            other_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("another worktree must refresh while A is blocked")
                .matches
                .len(),
            1
        );
        cancelled.cancel();
        assert!(matches!(
            refresh_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(Error::Cancelled(_))
        ));
        struct CleanupLifetime(std::sync::Arc<AtomicBool>);
        impl Drop for CleanupLifetime {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let cleaned = std::sync::Arc::new(AtomicBool::new(false));
        drop(PendingAttachment {
            process: std::sync::Arc::clone(&a.process),
            params: Some(
                json!({"root":a.root,"revision":revision,"profile":profile(),"lease":params["lease"],"mode":"paths"}),
            ),
            lifetime: Some(Box::new(CleanupLifetime(std::sync::Arc::clone(&cleaned)))),
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !cleaned.load(Ordering::SeqCst),
            "final detach must retain root resources after socket cancellation"
        );
        assert_eq!(b.file_fuzzy("source", 10, &token).unwrap().matches.len(), 1);
        fs::write(&release, "release").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cleaned.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "final detach did not complete after reads ended"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(search(b, "worktree_b_marker").matches.len(), 1);
    });
}

#[test]
fn pending_hints_are_bounded_and_full_revisions_survive_independent_acknowledgements() {
    let mut changed = PendingChanges {
        revision: 1,
        ..Default::default()
    };
    for number in 0..=PendingChanges::PATH_LIMIT {
        changed.record(PathBuf::from(format!("file-{number}.rs")), 1);
    }
    assert!(changed.paths.is_empty());
    assert!(matches!(changed.since(0), Changes::Full));
    changed.files_ack = 1;
    changed.prune();
    assert!(matches!(changed.since(changed.content_ack), Changes::Full));
    assert!(matches!(changed.since(changed.files_ack), Changes::None));
    // A refresh captures revision 1; acknowledgement must not consume a later write.
    changed.revision = 2;
    changed.record(PathBuf::from("late.rs"), 2);
    changed.content_ack = 1;
    changed.prune();
    assert_eq!(changed.full_revision, 0);
    let Changes::Paths(paths) = changed.since(1) else {
        panic!("later write lost")
    };
    assert_eq!(paths, [PathBuf::from("late.rs")]);
    changed.content_ack = 2;
    changed.files_ack = 2;
    changed.prune();
    assert!(changed.paths.is_empty());
    assert_eq!(changed.path_bytes, 0);

    changed.revision = 3;
    for number in 0..400 {
        changed.record(PathBuf::from(format!("{number}-{}.rs", "x".repeat(200))), 3);
    }
    assert!(changed.paths.is_empty());
    assert!(matches!(changed.since(2), Changes::Full));
}

#[test]
fn filename_only_writes_remain_bounded_and_the_next_content_query_recovers() {
    let (_root, _index, session) = fixture();
    let token = CancellationSource::new().token();
    session.file_fuzzy("", 100, &token).unwrap();
    for batch in 0..3 {
        let paths = (0..=PendingChanges::PATH_LIMIT)
            .map(|number| session.root.join(format!("batch-{batch}-file-{number}.rs")))
            .collect::<Vec<_>>();
        let last = paths.last().unwrap();
        fs::write(last, format!("batch_marker_{batch}\n")).unwrap();
        session.paths_changed(&paths);
        assert_eq!(
            session
                .file_fuzzy(&format!("^batch-{batch}-"), 100, &token)
                .unwrap()
                .matches
                .len(),
            1
        );
        let changed = session.changed.lock().unwrap();
        assert!(changed.paths.len() <= PendingChanges::PATH_LIMIT);
        assert!(changed.path_bytes <= PendingChanges::BYTE_LIMIT);
        assert_eq!(changed.content_ack, 0);
        assert!(matches!(changed.since(0), Changes::Full));
    }
    assert_eq!(search(&session, "batch_marker_2").matches.len(), 1);
    let changed = session.changed.lock().unwrap();
    assert!(changed.paths.is_empty());
    assert_eq!(changed.full_revision, 0);
    assert_eq!(changed.content_ack, changed.files_ack);
}

#[cfg(unix)]
#[test]
fn disconnected_filename_requests_stop_active_and_queued_catalog_work() {
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpStream;

    let (root, index, original) = fixture();
    drop(original);
    fs::write(root.path().join("source.rs"), "marker\n").unwrap();
    let wrappers = tempfile::tempdir().unwrap();
    let engine = Executable::resolve(&InstallContext::current()).unwrap();
    let token = CancellationSource::new().token();
    let session = Session::open(
        unwatched_engine(wrappers.path(), &engine),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    session.rebuild(&token).unwrap();
    session.file_fuzzy("source", 1, &token).unwrap();
    let before = session
        .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
        .unwrap()["file_catalog"]
        .clone();
    let discovery: Value =
        serde_json::from_slice(&fs::read(root.path().join(".git/tgrep-daemon-v1.json")).unwrap())
            .unwrap();
    let params = match &session.registration {
        Registration::Shared {
            root, view, lease, ..
        } => json!({"root":root,"view":view,"lease":lease,"full":true}),
        _ => panic!("expected shared registration"),
    };
    let config = root.path().join(".git/config");
    let contents = fs::read(&config).unwrap();
    fs::remove_file(&config).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&config)
            .status()
            .unwrap()
            .success()
    );
    let pipe = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config)
        .unwrap();
    struct ReleaseRead {
        path: PathBuf,
        contents: Vec<u8>,
        pipe: Option<fs::File>,
    }
    impl Drop for ReleaseRead {
        fn drop(&mut self) {
            // Restore valid configuration before letting the interrupted metadata walk proceed.
            let _ = fs::remove_file(&self.path);
            let _ = fs::write(&self.path, &self.contents);
            if let Some(mut pipe) = self.pipe.take() {
                let _ = pipe.write_all(&self.contents);
            }
        }
    }
    std::thread::scope(|scope| {
        let _release = ReleaseRead {
            path: config,
            contents,
            pipe: Some(pipe),
        };
        let cancel = CancellationSource::new();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let session = &session;
        let params = &params;
        let refresh_cancellation = cancel.token();
        let refresh_completed = completed_tx.clone();
        scope.spawn(move || {
            refresh_completed
                .send(
                    session
                        .process
                        .rpc(
                            "files/refresh",
                            params.clone(),
                            &refresh_cancellation,
                            Instant::now() + TIMEOUT,
                        )
                        .map(|_| ()),
                )
                .unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = session
                .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
                .unwrap();
            if status["files_ready"] == false {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "refresh did not invalidate the catalog before its controlled read"
            );
        }
        let fuzzy_cancellation = cancel.token();
        scope.spawn(move || {
            completed_tx
                .send(
                    session
                        .file_fuzzy("source", 1, &fuzzy_cancellation)
                        .map(|_| ()),
                )
                .unwrap();
        });
        // One worker is inside metadata I/O; the other waits for its catalog repair lock.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut probe =
                TcpStream::connect(("127.0.0.1", discovery["port"].as_u64().unwrap() as u16))
                    .unwrap();
            probe
                .set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            let request = json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{},"protocol":discovery["protocol"],"instance":discovery["instance"],"repository":discovery["repository"]});
            writeln!(probe, "{request}").unwrap();
            match probe.read(&mut [0]) {
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Ok(_) => assert!(
                    Instant::now() < deadline,
                    "query workers did not enter the controlled reads"
                ),
                Err(error) => panic!("query probe: {error}"),
            }
        }
        let mut queued =
            TcpStream::connect(("127.0.0.1", discovery["port"].as_u64().unwrap() as u16)).unwrap();
        let request = json!({"jsonrpc":"2.0","id":1,"method":"files/refresh","params":params,"cancellable":true,"protocol":discovery["protocol"],"instance":discovery["instance"],"repository":discovery["repository"]});
        writeln!(queued, "{request}").unwrap();
        drop(queued);
        cancel.cancel();
        for _ in 0..2 {
            assert!(matches!(
                completed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
                Err(Error::Cancelled(_))
            ));
        }
        // The waiting query and queued disconnected refresh must free a worker even before I/O resumes.
        session
            .process
            .rpc(
                "hello",
                json!({}),
                &token,
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap();
    });
    let after = session
        .rpc("status", json!({}), &token, Instant::now() + TIMEOUT)
        .unwrap();
    assert_eq!(
        after["file_catalog"], before,
        "cancelled active and queued refreshes must not publish discovery"
    );
    assert_eq!(
        after["files_ready"], false,
        "an interrupted repair must remain pending"
    );
    assert_eq!(
        session
            .file_fuzzy("source", 1, &token)
            .unwrap()
            .matches
            .len(),
        1
    );
}

#[test]
fn filename_root_is_admitted_even_when_its_name_is_an_excluded_directory() {
    let parent = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let root = parent.path().join("target");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("source.rs"), "content").unwrap();
    fs::create_dir(root.join("target")).unwrap();
    fs::write(root.join("target/hidden.rs"), "excluded").unwrap();
    let token = CancellationSource::new().token();
    let session = Session::open(
        Executable::resolve(&InstallContext::current()).unwrap(),
        &root,
        index.path(),
        &token,
    )
    .unwrap();
    let indexed = session.file_fuzzy("", 100, &token).unwrap();
    let disk = ash_file_search::Service
        .fuzzy(root, "", 100, &token)
        .unwrap();
    assert_eq!(indexed.scanned_file_count, disk.scanned_file_count);
    assert_eq!(indexed.matches.len(), 1);
    assert_eq!(indexed.matches[0].path, Path::new("source.rs"));
}

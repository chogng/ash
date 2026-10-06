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
            view,
            lease,
            generation,
        } => (view, lease, generation),
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

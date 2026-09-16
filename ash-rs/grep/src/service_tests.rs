use super::*;
use crate::JobError;
use crate::Jobs;
use crate::Owner;
use ash_async_utils::CancellationSource;
use ash_install_context::ExecutableCandidates;
use ash_install_context::ManagedExecutable;
use std::fs;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

fn ripgrep() -> RipgrepExecutable {
    match InstallContext::current().executable_candidates(ManagedExecutable::Ripgrep) {
        ExecutableCandidates::ExplicitOverride(value) => {
            RipgrepExecutable::from_path(value.path()).unwrap()
        }
        ExecutableCandidates::SearchPaths(paths) => {
            RipgrepExecutable::discover_candidates(paths).unwrap()
        }
    }
}
fn fixture() -> (tempfile::TempDir, Dir) {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir(temporary.path().join(".git")).unwrap();
    let root = Dir::open_local(temporary.path()).unwrap();
    (temporary, root)
}
fn query(text: &str) -> Query {
    Query {
        query: text.into(),
        pattern: Pattern::Regex,
        case_sensitivity: CaseSensitivity::Sensitive,
        scope: PathBuf::new(),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results: 100,
        freshness: Freshness::Indexed,
    }
}

#[test]
fn both_engines_share_literals_unicode_filters_limits_and_current_reads() {
    let (_tmp, root) = fixture();
    fs::write(
        root.canonical_path().join("a.rs"),
        "let 搜索 = \"Kelvin\";\na.b\naxb\n",
    )
    .unwrap();
    fs::write(root.canonical_path().join("b.rs"), "Kelvin\n").unwrap();
    fs::write(root.canonical_path().join("c.txt"), "Kelvin\n").unwrap();
    let service = Service::new(Backend::Tgrep, ripgrep(), None).unwrap();
    let cancellation = CancellationSource::new();
    service.rebuild_index(&root, &cancellation.token()).unwrap();
    for backend in [Backend::Tgrep, Backend::Ripgrep] {
        service.configure(backend).unwrap();
        let mut q = query("kelvin");
        q.case_sensitivity = CaseSensitivity::Insensitive;
        q.include_patterns = vec!["a.rs".into(), "b.rs".into()];
        q.exclude_patterns = vec!["b.rs".into()];
        let result = service.search(&root, &q, &cancellation.token()).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, Path::new("a.rs"));
        assert_eq!(
            result.matches[0].ranges,
            [MatchRange { start: 14, end: 22 }]
        );
        let mut q = query("a.b");
        q.pattern = Pattern::Literal;
        q.freshness = Freshness::Current;
        let result = service.search(&root, &q, &cancellation.token()).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line_number, 2);
        assert_eq!(result.freshness, Freshness::Current);
        let mut q = query(".");
        q.max_results = 2;
        let result = service.search(&root, &q, &cancellation.token()).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert!(result.limit_hit);
        q.scope = "b.rs".into();
        q.max_results = 1;
        assert!(
            !service
                .search(&root, &q, &cancellation.token())
                .unwrap()
                .limit_hit
        );
    }
}

#[test]
fn consumers_share_one_session_and_observed_writes_across_backend_changes() {
    let (_tmp, root) = fixture();
    let profile = tempfile::tempdir().unwrap();
    let storage = Arc::new(StateRuntime::open(profile.path()).unwrap());
    let path = root.canonical_path().join("source.rs");
    fs::write(&path, "before_marker\n").unwrap();
    let service = Arc::new(Service::new(Backend::Tgrep, ripgrep(), Some(storage.clone())).unwrap());
    let caller_a: Arc<dyn Search> = service.clone();
    let caller_b: Arc<dyn Search> = service.clone();
    let token = CancellationSource::new().token();
    assert!(!service.index_status(&root, &token).unwrap().active);
    service.rebuild_index(&root, &token).unwrap();
    assert_eq!(
        caller_a
            .search(&root, &query("before_marker"), &token)
            .unwrap()
            .matches
            .len(),
        1
    );
    service.configure(Backend::Ripgrep).unwrap();
    fs::write(&path, "latest_marker\n").unwrap();
    service.paths_changed(&root, &[path]);
    service.configure(Backend::Tgrep).unwrap();
    assert_eq!(
        caller_b
            .search(&root, &query("latest_marker"), &token)
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(
        caller_a
            .search(&root, &query("before_marker"), &token)
            .unwrap()
            .matches
            .is_empty()
    );
    service.configure(Backend::Ripgrep).unwrap();
    assert_eq!(
        service.index_status(&root, &token).unwrap(),
        IndexStatus::default()
    );
    assert_eq!(
        storage.clear_index(&root.id(), DirIndexKind::Grep).unwrap(),
        ash_state::ClearOutcome::Cleared
    );
}

#[test]
fn rejects_invalid_scopes_patterns_and_honors_cancellation_before_starting() {
    let (_tmp, root) = fixture();
    let service = Service::new(Backend::Tgrep, ripgrep(), None).unwrap();
    let token = CancellationSource::new().token();
    for q in [
        query("("),
        Query {
            scope: "../outside".into(),
            ..query("needle")
        },
        Query {
            include_patterns: vec!["!src".into()],
            ..query("needle")
        },
    ] {
        assert!(matches!(
            service.search(&root, &q, &token),
            Err(Error::InvalidInput(_))
        ));
    }
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert!(matches!(
        service.search(&root, &query("needle"), &cancelled.token()),
        Err(Error::Cancelled(_))
    ));
    assert!(!service.index_status(&root, &token).unwrap().active);
}

#[test]
fn jobs_page_more_than_agent_limit_and_enforce_ownership() {
    let (_tmp, root) = fixture();
    fs::write(
        root.canonical_path().join("source.rs"),
        "needle\n".repeat(151),
    )
    .unwrap();
    let service = Arc::new(Service::new(Backend::Tgrep, ripgrep(), None).unwrap());
    let jobs = Jobs::new(root, service);
    let id = jobs
        .start(
            Owner::new(1),
            Query {
                max_results: 150,
                freshness: Freshness::Current,
                ..query("needle")
            },
        )
        .unwrap();
    assert_eq!(
        jobs.read(Owner::new(2), &id, 0, 100),
        Err(JobError::NotOwner)
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let page = jobs.read(Owner::new(1), &id, 0, 100).unwrap();
        if !page.matches.is_empty() {
            assert!(
                !page.completed,
                "unread pages must remain available to clients"
            );
            assert_eq!(page.error, None);
            assert_eq!(page.matches.len(), 100);
            assert!(page.limit_hit);
            assert_eq!(page.freshness, Some(Freshness::Current));
            let last = jobs.read(Owner::new(1), &id, page.next_match, 100).unwrap();
            assert_eq!(last.matches.len(), 50);
            assert!(last.completed);
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    jobs.cancel(Owner::new(1), &id).unwrap();
    assert_eq!(
        jobs.read(Owner::new(1), &id, 0, 100),
        Err(JobError::NotFound)
    );
}

#[cfg(unix)]
#[test]
fn cancelling_a_running_ripgrep_query_reaps_its_process() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, root) = fixture();
    let executable = root.canonical_path().join("slow-search");
    let marker = root.canonical_path().join("pid");
    fs::write(&executable, "#!/bin/sh\necho $$ > pid\nexec sleep 30\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let service = Service::new(
        Backend::Ripgrep,
        RipgrepExecutable::from_path(&executable).unwrap(),
        None,
    )
    .unwrap();
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let worker = std::thread::spawn(move || service.search(&root, &query("needle"), &token));
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid = loop {
        if let Some(pid) = fs::read_to_string(&marker)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    cancellation.cancel();
    assert!(matches!(worker.join().unwrap(), Err(Error::Cancelled(_))));
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn cancelling_one_owner_does_not_cancel_another_owners_running_query() {
    use std::sync::Mutex;
    use std::sync::mpsc;

    struct ControlledSearch {
        started: mpsc::Sender<String>,
        stopped: mpsc::Sender<String>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl Search for ControlledSearch {
        fn search(
            &self,
            _: &Dir,
            query: &Query,
            cancellation: &CancellationToken,
        ) -> Result<SearchResult, Error> {
            self.started.send(query.query.clone()).unwrap();
            if query.query == "cancel-me" {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !cancellation.is_cancelled() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert!(
                    cancellation.is_cancelled(),
                    "job cancellation was not forwarded"
                );
                self.stopped.send(query.query.clone()).unwrap();
                return Err(Error::Cancelled("caller cancelled".into()));
            }
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            assert!(
                !cancellation.is_cancelled(),
                "another caller cancelled this query"
            );
            Ok(SearchResult {
                matches: vec![Match {
                    path: "source.rs".into(),
                    line_number: 1,
                    content: query.query.clone(),
                    ranges: vec![MatchRange {
                        start: 0,
                        end: query.query.len(),
                    }],
                }],
                limit_hit: false,
                freshness: Freshness::Current,
            })
        }
    }
    let (_temporary, root) = fixture();
    let (started_tx, started_rx) = mpsc::channel();
    let (stopped_tx, stopped_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let jobs = Jobs::new(
        root,
        Arc::new(ControlledSearch {
            started: started_tx,
            stopped: stopped_tx,
            release: Mutex::new(release_rx),
        }),
    );
    let first = jobs.start(Owner::new(1), query("cancel-me")).unwrap();
    let second = jobs.start(Owner::new(2), query("keep-me")).unwrap();
    let mut started = (0..2)
        .map(|_| started_rx.recv_timeout(Duration::from_secs(5)).unwrap())
        .collect::<Vec<_>>();
    started.sort();
    assert_eq!(started, ["cancel-me", "keep-me"]);
    assert_eq!(jobs.cancel(Owner::new(2), &first), Err(JobError::NotOwner));
    assert_eq!(
        jobs.read(Owner::new(1), &second, 0, 100),
        Err(JobError::NotOwner)
    );
    jobs.cancel(Owner::new(1), &first).unwrap();
    assert_eq!(
        stopped_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        "cancel-me"
    );
    assert_eq!(
        jobs.read(Owner::new(1), &first, 0, 100),
        Err(JobError::NotFound)
    );
    assert!(!jobs.read(Owner::new(2), &second, 0, 100).unwrap().completed);
    release_tx.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let page = jobs.read(Owner::new(2), &second, 0, 100).unwrap();
        if page.completed {
            assert_eq!(page.error, None);
            assert_eq!(page.matches.len(), 1);
            assert_eq!(page.matches[0].content, "keep-me");
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    jobs.cancel(Owner::new(2), &second).unwrap();
}

#[test]
fn revoking_directory_authorization_cancels_jobs_and_blocks_further_reads() {
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    struct Blocking {
        started: AtomicBool,
        stopped: AtomicBool,
    }
    impl Search for Blocking {
        fn search(
            &self,
            _: &Dir,
            _: &Query,
            cancellation: &CancellationToken,
        ) -> Result<SearchResult, Error> {
            self.started.store(true, Ordering::Release);
            while !cancellation.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
            self.stopped.store(true, Ordering::Release);
            Err(Error::Cancelled("revoked".into()))
        }
    }
    let (_temporary, root) = fixture();
    let grant = Grant::for_environment(
        root,
        GrantSource::HostConfiguration,
        Permissions::new([Permission::SearchFiles]),
    );
    let search = Arc::new(Blocking {
        started: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
    });
    let jobs = Jobs::new_authorized(
        grant.authorize(Permission::SearchFiles).unwrap(),
        search.clone(),
    )
    .unwrap();
    let id = jobs.start(Owner::new(1), query("needle")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !search.started.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    grant.revoke();
    while !search.stopped.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        jobs.read(Owner::new(1), &id, 0, 100),
        Err(JobError::Unavailable)
    );
    assert_eq!(
        jobs.start(Owner::new(1), query("needle")),
        Err(JobError::Unavailable)
    );
}

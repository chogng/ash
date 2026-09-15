use super::*;
use crate::FastRegexCaseSensitivity;
use crate::FastRegexPattern;
use std::fs;
use test_binary_support::TestBinary;

fn worker_binary() -> TestBinary {
    TestBinary::test(module_path!(), "worker_process_entrypoint").unwrap()
}

#[test]
#[ignore = "started by the worker process test"]
fn worker_process_entrypoint() {
    worker_binary().dispatch(|| serve_worker_from_environment().map(|()| 0));
}

#[test]
fn worker_owns_rebuild_refresh_and_search() {
    let dir = tempfile::tempdir().expect("dir");
    let storage = tempfile::tempdir().expect("storage");
    fs::write(dir.path().join("alpha.txt"), "worker needle\n").expect("source");
    #[cfg(target_os = "linux")]
    let non_utf8_path = {
        use std::os::unix::ffi::OsStringExt;

        let path = PathBuf::from(OsString::from_vec(b"non-utf8-\xff.txt".to_vec()));
        fs::write(dir.path().join(&path), "encoded path marker\n").expect("non-UTF-8 source");
        path
    };
    let root = Dir::open_local(dir.path()).expect("root");
    let binary = worker_binary();
    let command = FastRegexWorkerCommand::new(binary.executable(), binary.arguments());
    let client = Arc::new(
        FastRegexWorkerClient::open(
            command,
            &root,
            storage.path(),
            FastRegexSearchLimits::default(),
        )
        .expect("client"),
    );

    assert_eq!(client.snapshot().unwrap().generation, 0);
    let rebuilt = client.rebuild().expect("rebuild");
    assert_eq!(rebuilt.generation, 1);
    let result = client
        .search(&FastRegexQuery {
            query: "needle".to_owned(),
            pattern: FastRegexPattern::Literal,
            case_sensitivity: FastRegexCaseSensitivity::Sensitive,
            scope: PathBuf::new(),
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            max_results: 10,
        })
        .expect("search");
    assert_eq!(result.matches.len(), 1);
    let searches = (0..8)
        .map(|_| {
            let client = Arc::clone(&client);
            thread::spawn(move || {
                client.search(&FastRegexQuery {
                    query: "needle".to_owned(),
                    pattern: FastRegexPattern::Literal,
                    case_sensitivity: FastRegexCaseSensitivity::Sensitive,
                    scope: PathBuf::new(),
                    include_patterns: Vec::new(),
                    exclude_patterns: Vec::new(),
                    max_results: 10,
                })
            })
        })
        .collect::<Vec<_>>();
    for search in searches {
        assert_eq!(
            search.join().expect("search thread").unwrap().matches.len(),
            1
        );
    }

    #[cfg(target_os = "linux")]
    {
        let encoded = client
            .search(&FastRegexQuery {
                query: "encoded path marker".to_owned(),
                pattern: FastRegexPattern::Literal,
                case_sensitivity: FastRegexCaseSensitivity::Sensitive,
                scope: PathBuf::new(),
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                max_results: 10,
            })
            .expect("search non-UTF-8 path");
        assert_eq!(encoded.matches[0].path, non_utf8_path);
    }

    fs::write(dir.path().join("alpha.txt"), "changed value\n").expect("change");
    let outcome = client
        .refresh_observed_paths(&[dir.path().join("alpha.txt")])
        .expect("refresh");
    assert!(matches!(outcome, FastRegexUpdateOutcome::Published(_)));
    let endpoint_directory = client.endpoint_directory.clone();
    drop(client);
    assert!(
        !endpoint_directory.exists(),
        "worker endpoint directory must be released and removed"
    );
}

#[test]
fn shutdown_wakes_an_idle_listener_and_exits_successfully() {
    let dir = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let binary = worker_binary();
    let client = FastRegexWorkerClient::open(
        FastRegexWorkerCommand::new(binary.executable(), binary.arguments()),
        &Dir::open_local(dir.path()).unwrap(),
        storage.path(),
        FastRegexSearchLimits::default(),
    )
    .unwrap();
    assert!(matches!(
        client.request(WorkerRequest::Shutdown).unwrap(),
        WorkerValue::Shutdown
    ));
    let mut child = client.child.lock().unwrap().take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "worker must exit gracefully: {status}");
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("shutdown failed to wake accept");
        }
        thread::sleep(Duration::from_millis(5));
    }
    let endpoint = client.endpoint_directory.clone();
    drop(client);
    assert!(!endpoint.exists());
}

#[test]
fn query_paths_use_compact_text_and_preserve_non_unicode_paths() {
    let mut query = FastRegexQuery {
        query: "alpha".into(),
        pattern: FastRegexPattern::Regex,
        case_sensitivity: FastRegexCaseSensitivity::Sensitive,
        scope: PathBuf::from("src/解析器.rs"),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results: 100,
    };
    let encoded = serde_json::to_value(&query).unwrap();
    assert_eq!(encoded["scope"], "src/解析器.rs");
    assert_eq!(
        serde_json::from_value::<FastRegexQuery>(encoded).unwrap(),
        query
    );
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        query.scope = PathBuf::from(OsString::from_vec(b"source-\xff.rs".to_vec()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        query.scope = PathBuf::from(OsString::from_wide(&[b's' as u16, 0xD800]));
    }
    let encoded = serde_json::to_value(&query).unwrap();
    assert!(encoded["scope"].is_array());
    assert_eq!(
        serde_json::from_value::<FastRegexQuery>(encoded).unwrap(),
        query
    );
}

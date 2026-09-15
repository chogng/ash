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

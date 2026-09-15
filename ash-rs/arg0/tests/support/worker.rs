use ash_fast_regex_search::FastRegexCaseSensitivity;
use ash_fast_regex_search::FastRegexPattern;
use ash_fast_regex_search::FastRegexQuery;
use ash_fast_regex_search::FastRegexSearchLimits;
use ash_fast_regex_search::FastRegexWorkerClient;
use ash_file_access::Dir;
use std::path::Path;
use std::path::PathBuf;

pub fn assert_worker(executable: &Path) {
    let directory = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("source.txt"), "entrypoint needle\n").unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let worker = FastRegexWorkerClient::open(
        arg0::fast_regex_worker_command(executable),
        &root,
        storage.path(),
        FastRegexSearchLimits::default(),
    )
    .unwrap();
    assert_eq!(worker.snapshot().unwrap().generation, 0);
    assert_eq!(worker.rebuild().unwrap().generation, 1);
    let query = FastRegexQuery {
        query: "needle".into(),
        pattern: FastRegexPattern::Literal,
        case_sensitivity: FastRegexCaseSensitivity::Sensitive,
        scope: PathBuf::new(),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results: 10,
    };
    assert_eq!(worker.search(&query).unwrap().matches.len(), 1);
    drop(worker);
    let restarted = FastRegexWorkerClient::open(
        arg0::fast_regex_worker_command(executable),
        &root,
        storage.path(),
        FastRegexSearchLimits::default(),
    )
    .unwrap();
    assert_eq!(restarted.search(&query).unwrap().matches.len(), 1);
}

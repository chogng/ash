use super::*;
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[test]
fn handle_streams_scored_paths_and_highlight_indices() {
    let directory = TestWorkspace::new();
    directory.write("docs/src-notes.md");
    directory.write("tests/s_r_c.rs");
    directory.write("src/lib.rs");
    let (handle, snapshots) = crate::Service
        .start(directory.path.clone(), PathSearchOptions::default())
        .unwrap();

    let revision = handle.update_query("src");
    let snapshot = wait_for_snapshot(&snapshots, "src", |snapshot| snapshot.search_complete);

    assert_eq!(snapshot.query_revision, revision);
    let contiguous = snapshot
        .matches
        .iter()
        .find(|matched| matched.path == Path::new("docs/src-notes.md"))
        .unwrap();
    let spread = snapshot
        .matches
        .iter()
        .find(|matched| matched.path == Path::new("tests/s_r_c.rs"))
        .unwrap();
    assert_eq!(contiguous.indices, vec![5, 6, 7]);
    assert!(
        contiguous.score > spread.score,
        "a contiguous basename match should outrank a spread subsequence"
    );
    assert!(
        snapshot
            .matches
            .windows(2)
            .all(|pair| pair[0].score >= pair[1].score),
        "Nucleo snapshots should already be ordered by descending score"
    );
}

#[test]
fn query_updates_reuse_the_handle_and_publish_the_latest_query() {
    let directory = TestWorkspace::new();
    directory.write("src/alpha.rs");
    directory.write("src/beta.rs");
    let (handle, snapshots) = crate::Service
        .start(directory.path.clone(), PathSearchOptions::default())
        .unwrap();

    let first_revision = handle.update_query("alpha");
    let first = wait_for_snapshot(&snapshots, "alpha", |snapshot| snapshot.search_complete);
    let second_revision = handle.update_query("beta");
    let snapshot = wait_for_snapshot(&snapshots, "beta", |snapshot| snapshot.search_complete);

    assert_eq!(first.query_revision, first_revision);
    assert_eq!(snapshot.query_revision, second_revision);
    assert!(second_revision > first_revision);
    assert_eq!(snapshot.matches.len(), 1);
    assert_eq!(snapshot.matches[0].path, Path::new("src/beta.rs"));
}

#[test]
fn walker_respects_gitignore_and_skips_generated_directories() {
    let directory = TestWorkspace::new();
    fs::create_dir(directory.path.join(".git")).unwrap();
    fs::write(directory.path.join(".gitignore"), "ignored.rs\n").unwrap();
    directory.write("src/lib.rs");
    directory.write("ignored.rs");
    directory.write("target/debug/ash");
    directory.write("node_modules/package/index.js");
    let (handle, snapshots) = crate::Service
        .start(directory.path.clone(), PathSearchOptions::default())
        .unwrap();

    handle.update_query("");
    let snapshot = wait_for_snapshot(&snapshots, "", |snapshot| snapshot.search_complete);
    let paths = snapshot
        .matches
        .iter()
        .map(|matched| matched.path.as_path())
        .collect::<Vec<_>>();

    assert!(paths.contains(&Path::new(".gitignore")));
    assert!(paths.contains(&Path::new("src/lib.rs")));
    assert!(!paths.contains(&Path::new("ignored.rs")));
    assert!(!paths.iter().any(|path| path.starts_with("target")));
    assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
}

fn wait_for_snapshot(
    snapshots: &Receiver<PathSearchSnapshot>,
    query: &str,
    predicate: impl Fn(&PathSearchSnapshot) -> bool,
) -> PathSearchSnapshot {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let snapshot = snapshots
            .recv_timeout(remaining)
            .unwrap_or_else(|error| panic!("timed out waiting for path-search snapshot: {error}"));
        if snapshot.query == query && predicate(&snapshot) {
            return snapshot;
        }
    }
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct TestWorkspace {
    path: PathBuf,
}

impl TestWorkspace {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-path-search-tests-{}-{}-{sequence}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn write(&self, relative: impl AsRef<Path>) {
        let target = self.path.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, "contents").unwrap();
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn disk_and_streaming_queries_select_stable_prefixes_before_truncation() {
    let root = TestWorkspace::new();
    for path in [
        "aa.rs",
        "z.rs",
        "b.rs",
        "src/main.rs",
        "node_modules/main.rs",
        "target/main.rs",
    ] {
        root.write(path);
    }
    let token = ash_async_utils::CancellationSource::new().token();
    for query in ["", "rs", "main"] {
        let all = Service
            .fuzzy(root.path.clone(), query, 100, &token)
            .unwrap();
        for limit in [1, 2] {
            let disk = Service
                .fuzzy(root.path.clone(), query, limit, &token)
                .unwrap();
            let (handle, snapshots) = Service
                .start(
                    root.path.clone(),
                    PathSearchOptions::default()
                        .with_result_limit(NonZeroUsize::new(limit).unwrap()),
                )
                .unwrap();
            handle.update_query(query);
            let streamed =
                wait_for_snapshot(&snapshots, query, |snapshot| snapshot.search_complete);
            let end = limit.min(all.matches.len());
            assert_eq!(disk.matches, all.matches[..end], "{query}");
            assert_eq!(streamed.matches, disk.matches, "{query}");
            assert_eq!(streamed.scanned_file_count, disk.scanned_file_count);
            assert_eq!(streamed.total_match_count, disk.total_match_count);
        }
    }
    assert_eq!(
        Service
            .fuzzy(root.path.clone(), "", 1, &token)
            .unwrap()
            .matches[0]
            .path,
        Path::new("aa.rs")
    );
}

#[test]
fn disk_query_validates_input_and_cancellation_before_discovery() {
    let token = ash_async_utils::CancellationSource::new().token();
    for (query, limit) in [("query", 0), ("query", 5001), ("\0", 1)] {
        assert!(matches!(
            Service.fuzzy(PathBuf::from("missing-directory"), query, limit, &token),
            Err(Error::InvalidInput(_))
        ));
    }
    let cancel = ash_async_utils::CancellationSource::new();
    cancel.cancel();
    assert!(matches!(
        Service.fuzzy(
            PathBuf::from("missing-directory"),
            "query",
            1,
            &cancel.token()
        ),
        Err(Error::Cancelled(_))
    ));
}

#[test]
fn disk_and_streaming_walks_apply_gitignore_outside_a_repository() {
    let root = TestWorkspace::new();
    root.write("source.rs");
    root.write("ignored.rs");
    fs::write(root.path.join(".gitignore"), "ignored.rs\n").unwrap();
    let token = ash_async_utils::CancellationSource::new().token();
    let disk = Service.fuzzy(root.path.clone(), "rs", 100, &token).unwrap();
    let (handle, snapshots) = Service
        .start(root.path.clone(), PathSearchOptions::default())
        .unwrap();
    handle.update_query("rs");
    let streamed = wait_for_snapshot(&snapshots, "rs", |snapshot| snapshot.search_complete);
    assert_eq!(disk.matches, streamed.matches);
    assert_eq!(
        disk.matches
            .iter()
            .map(|matched| matched.path.as_path())
            .collect::<Vec<_>>(),
        [Path::new("source.rs")]
    );
}

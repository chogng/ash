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

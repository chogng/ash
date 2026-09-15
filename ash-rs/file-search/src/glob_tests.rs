use super::*;
use ash_async_utils::CancellationSource;
use std::fs;
use std::fs::File;
use std::fs::FileTimes;
use std::time::SystemTime;

fn write(root: &Path, path: &str, seconds: u64) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "contents are irrelevant to path search").unwrap();
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
        )
        .unwrap();
}

fn query() -> GlobQuery {
    GlobQuery {
        scope: PathBuf::new(),
        include_patterns: Vec::new(),
        exclude_patterns: vec![".git".into()],
        max_results: 100,
    }
}

#[test]
fn enumeration_and_globs_preserve_ignore_overrides_and_newest_first_limits() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let root = dir.canonical_path();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
    write(root, "src/older.rs", 1);
    write(root, "src/newer.rs", 2);
    write(root, "ignored.rs", 3);
    write(root, "hidden/.private", 4);
    let cancellation = CancellationSource::new();
    let mut q = query();
    assert_eq!(
        Service.glob(&dir, &q, &cancellation.token()).unwrap(),
        GlobResult {
            paths: vec!["src/newer.rs".into(), "src/older.rs".into()],
            total_matches: 2,
        }
    );
    q.include_patterns = vec!["**/*.rs".into()];
    q.max_results = 2;
    assert_eq!(
        Service.glob(&dir, &q, &cancellation.token()).unwrap(),
        GlobResult {
            paths: vec!["ignored.rs".into(), "src/newer.rs".into()],
            total_matches: 3,
        }
    );
    q.exclude_patterns.push("ignored.rs".into());
    q.scope = "src".into();
    assert_eq!(
        Service.glob(&dir, &q, &cancellation.token()).unwrap().paths,
        vec![PathBuf::from("src/newer.rs"), PathBuf::from("src/older.rs")]
    );
}

#[test]
fn validates_scope_patterns_limits_and_cancellation() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let cancellation = CancellationSource::new();
    for pattern in ["[", "../*.rs", "/tmp/*", "!*.rs", ""] {
        let mut q = query();
        q.include_patterns.push(pattern.into());
        assert!(
            matches!(
                Service.glob(&dir, &q, &cancellation.token()),
                Err(Error::InvalidInput(_))
            ),
            "{pattern}"
        );
    }
    for scope in [PathBuf::from(".."), temp.path().to_path_buf()] {
        let mut q = query();
        q.scope = scope;
        assert!(matches!(
            Service.glob(&dir, &q, &cancellation.token()),
            Err(Error::InvalidInput(_))
        ));
    }
    let mut q = query();
    q.max_results = 0;
    assert!(matches!(
        Service.glob(&dir, &q, &cancellation.token()),
        Err(Error::InvalidInput(_))
    ));
    cancellation.cancel();
    assert!(matches!(
        Service.glob(&dir, &query(), &cancellation.token()),
        Err(Error::Cancelled(_))
    ));
}

#[cfg(unix)]
#[test]
fn does_not_follow_links_and_rejects_scope_outside_the_authorized_root() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "secret.rs", 1);
    std::os::unix::fs::symlink(outside.path(), temp.path().join("escape")).unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let cancellation = CancellationSource::new();
    let mut q = query();
    assert!(
        Service
            .glob(&dir, &q, &cancellation.token())
            .unwrap()
            .paths
            .is_empty()
    );
    q.scope = "escape".into();
    assert!(matches!(
        Service.glob(&dir, &q, &cancellation.token()),
        Err(Error::InvalidInput(_))
    ));
}

use super::*;
use ash_async_utils::CancellationSource;
use std::fs;

fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Session) {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join(".git")).unwrap();
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
                include: None,
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
    fs::write(root.path().join("src/[odd]*?.rs"), "rare_marker\n").unwrap();
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
                include: None,
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
    session.paths_changed(&[
        fs::canonicalize(&path).unwrap(),
        fs::canonicalize(&new).unwrap(),
    ]);
    assert!(search(&session, "before_marker").matches.is_empty());
    assert_eq!(search(&session, "after_marker").matches.len(), 2);
    fs::remove_file(&new).unwrap();
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
        include: Some("*.rs"),
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
                include: None,
                ..request
            },
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(result.matches.len(), 1);
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
        include: None,
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
        serde_json::from_slice(&fs::read(index.path().join("serve.json")).unwrap()).unwrap();
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
                include: None,
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
        include: None,
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

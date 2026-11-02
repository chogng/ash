use super::*;
use serde_json::json;

fn entry(message: &str) -> HostLogEntry {
    HostLogEntry {
        timestamp_millis: 123,
        level: HostLogLevel::Information,
        category: "test".into(),
        message: message.into(),
        error: None,
    }
}

fn open(directory: &tempfile::TempDir) -> Store {
    Store::open(
        directory.path().to_str().unwrap(),
        5 * 1024 * 1024,
        2,
        std::process::id(),
    )
    .unwrap()
}

#[test]
fn quiet_source_and_first_record_share_a_cursor() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = open(&directory);
    assert!(valid_session(
        store.session.file_name().unwrap().to_str().unwrap()
    ));
    let files = store.list("window-7", None).unwrap();
    assert_eq!(files.len(), 1);
    assert!(files[0].current_window);
    let empty = store.read(&files[0].id, None).unwrap();
    assert!(empty.text.is_empty());
    store.append("window-7", entry("中文日志")).unwrap();
    let next = store.read(&files[0].id, Some(empty.cursor)).unwrap();
    assert!(!next.gap);
    let record: serde_json::Value = serde_json::from_str(&next.text).unwrap();
    assert_eq!(record["message"], "中文日志");
    assert_eq!(record["processId"], std::process::id());
    assert_eq!(record["source"], "window-7");
    store.close().unwrap();
    assert!(
        !store
            .session
            .join(format!(".active-{}", std::process::id()))
            .exists()
    );
    assert!(matches!(
        store.append("main", entry("late")),
        Err(Error::NotOpen)
    ));
}

#[test]
fn rotation_preserves_three_files_and_reports_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().to_str().unwrap(), 400, 2, 1).unwrap();
    store
        .append("main", entry(&format!("{}1", "x".repeat(200))))
        .unwrap();
    let id = format!(
        "{}/main.log",
        store.session.file_name().unwrap().to_str().unwrap()
    );
    let first = store.read(&id, None).unwrap();
    for index in 2..=5 {
        store
            .append("main", entry(&format!("{}{index}", "x".repeat(200))))
            .unwrap();
    }
    let next = store.read(&id, Some(first.cursor)).unwrap();
    assert!(next.gap);
    assert!(next.text.contains(&format!("{}5", "x".repeat(200))));
    for (suffix, index) in [("log.2", 3), ("log.1", 4), ("log", 5)] {
        let text = fs::read_to_string(store.session.join(format!("main.{suffix}"))).unwrap();
        assert!(text.contains(&format!("{}{index}", "x".repeat(200))));
        assert!(text.len() <= 400);
    }
}

#[test]
fn incomplete_unicode_record_is_not_consumed_until_the_newline() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = open(&directory);
    let id = store.list("window-1", None).unwrap().remove(0).id;
    let bytes = "中文日志\n".as_bytes();
    let path = store.session.join("window-1.log");
    fs::write(&path, &bytes[..1]).unwrap();
    let first = store.read(&id, None).unwrap();
    assert_eq!(first.cursor.offset, 0);
    assert!(first.text.is_empty());
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(&bytes[1..])
        .unwrap();
    let next = store.read(&id, Some(first.cursor)).unwrap();
    assert_eq!(next.text, "中文日志\n");
    assert!(!next.gap);
}

#[test]
fn bounded_tail_skips_partial_first_line_and_reads_the_daemon_source_in_place() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = open(&directory);
    let daemon = directory.path().join("daemon.log");
    fs::write(
        &daemon,
        format!("{}\ntail 中文\n", "x".repeat(MAX_READ_BYTES as usize)),
    )
    .unwrap();
    let files = store
        .list("window-1", Some(daemon.to_str().unwrap().into()))
        .unwrap();
    assert_eq!(files[0].id, "app-server");
    let first = store.read("app-server", None).unwrap();
    assert!(first.gap);
    assert_eq!(first.text, "tail 中文\n");
    OpenOptions::new()
        .append(true)
        .open(&daemon)
        .unwrap()
        .write_all(b"next\n")
        .unwrap();
    let next = store.read("app-server", Some(first.cursor)).unwrap();
    assert_eq!(next.text, "next\n");
    assert!(!next.gap);
    assert!(fs::metadata(daemon).unwrap().len() > MAX_READ_BYTES);
}

#[test]
fn cleanup_preserves_active_sessions_and_unrelated_directories() {
    let directory = tempfile::tempdir().unwrap();
    let mut previous = open(&directory);
    previous.append("main", entry("previous session")).unwrap();
    let mut current = Store::open(directory.path().to_str().unwrap(), 1024, 1, 1).unwrap();
    let unrelated = directory.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    current.clean_up().unwrap();
    assert!(previous.session.exists());
    let historic = current
        .list("window-1", None)
        .unwrap()
        .into_iter()
        .find(|source| !source.live)
        .unwrap();
    assert!(
        current
            .read(&historic.id, None)
            .unwrap()
            .text
            .contains("previous session")
    );
    previous.close().unwrap();
    current.clean_up().unwrap();
    assert!(!previous.session.exists());
    assert!(current.session.exists());
    assert!(unrelated.exists());
}

#[test]
fn source_and_cursor_validation_cannot_escape_the_log_root() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = open(&directory);
    for source in ["../outside", "window-0", "window-01", "window-", "MAIN"] {
        assert!(matches!(
            store.append(source, entry("bad")),
            Err(Error::Invalid(_))
        ));
    }
    for id in ["../outside.log", "a/b/c", "app-server", ""] {
        assert!(matches!(store.read(id, None), Err(Error::Invalid(_))));
    }
    assert!(Store::open("relative", 1024, 1, 1).is_err());
    assert!(Store::open(directory.path().to_str().unwrap(), 0, 1, 1).is_err());
    assert!(
        serde_json::from_value::<HostLogRequest>(
            json!({ "op": "read", "id": "x", "cursor": { "generation": "a", "offset": -1 }})
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn redirected_sessions_and_files_are_rejected() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut store = open(&directory);
    let session = "20250101T000000000-00000000-0000-0000-0000-000000000000";
    fs::write(outside.path().join("main.log"), "private\n").unwrap();
    symlink(outside.path(), directory.path().join(session)).unwrap();
    assert!(matches!(
        store.read(&format!("{session}/main.log"), None),
        Err(Error::Invalid(_))
    ));
    symlink(
        outside.path().join("main.log"),
        store.session.join("window-9.log"),
    )
    .unwrap();
    assert!(matches!(
        store.append("window-9", entry("overwrite")),
        Err(Error::Invalid(_))
    ));
    assert!(
        store
            .list("window-1", None)
            .unwrap()
            .iter()
            .all(|source| source.source != "window-9")
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("main.log")).unwrap(),
        "private\n"
    );
}

#[test]
fn failed_write_remains_visible_at_flush_and_close_still_releases_the_session() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = open(&directory);
    fs::create_dir(store.session.join("main.log.2")).unwrap();
    store.max_file_bytes = 400;
    store.append("main", entry(&"x".repeat(200))).unwrap();
    assert!(store.append("main", entry(&"x".repeat(200))).is_err());
    assert!(store.flush().is_err());
    assert!(store.close().is_err());
    assert!(
        !store
            .session
            .join(format!(".active-{}", std::process::id()))
            .exists()
    );
}

#[test]
fn private_pipe_orders_commands_and_closes_without_a_business_server() {
    let directory = tempfile::tempdir().unwrap();
    let commands = [
        json!({ "op": "initialize", "logsHome": directory.path(), "maxFileBytes": 1024, "retainedSessions": 2, "processId": 7 }),
        json!({ "op": "list", "windowSource": "window-1", "appServerLog": null }),
        json!({ "op": "flush" }),
        json!({ "op": "close" }),
    ];
    let input = commands
        .iter()
        .map(|command| format!("{command}\n"))
        .collect::<String>();
    let mut output = Vec::new();
    serve(io::Cursor::new(input), &mut output).unwrap();
    let replies: Vec<serde_json::Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        replies
            .iter()
            .map(|reply| reply["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialized", "listed", "ok", "ok"]
    );
    let session = PathBuf::from(replies[0]["sessionPath"].as_str().unwrap());
    assert!(
        !session
            .join(format!(".active-{}", std::process::id()))
            .exists()
    );
}

#[test]
fn malformed_frames_fail_boundedly_and_eof_releases_the_active_marker() {
    let directory = tempfile::tempdir().unwrap();
    let input = format!(
        "{}\n{{\"op\":\"unknown\"}}\n",
        json!({ "op": "initialize", "logsHome": directory.path(), "maxFileBytes": 1024, "retainedSessions": 2, "processId": 7 })
    );
    let mut output = Vec::new();
    serve(io::Cursor::new(input), &mut output).unwrap();
    let replies: Vec<serde_json::Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies[1]["reason"], "invalidRequest");
    assert!(
        !Path::new(replies[0]["sessionPath"].as_str().unwrap())
            .join(format!(".active-{}", std::process::id()))
            .exists()
    );
    assert!(
        serve(
            io::Cursor::new(vec![b'x'; MAX_FRAME_BYTES as usize + 1]),
            Vec::new()
        )
        .is_err()
    );
}

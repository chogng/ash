use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use serde_json::json;

use super::DebugAdapterCommand;
use super::DebugAdapterService;
use super::DebugAdapterState;
use super::push_message;
use super::read_buffered_state;

fn service(environment: HashMap<String, String>) -> DebugAdapterService {
    let root = Dir::open_local(std::env::temp_dir()).unwrap();
    let authorization = |permission| {
        Grant::for_environment(
            root.clone(),
            GrantSource::HostConfiguration,
            Permissions::new([permission]),
        )
        .authorize(permission)
        .unwrap()
    };
    DebugAdapterService::new(
        authorization(Permission::LoadConfig),
        authorization(Permission::ExecuteCommands),
        environment,
    )
    .unwrap()
}

#[test]
fn source_catalog_bursts_preserve_the_following_stop_without_expanding_the_byte_budget() {
    let shared = std::sync::Arc::new(std::sync::Mutex::new(DebugAdapterState::default()));
    for index in 0..5000 {
        push_message(
            &shared,
            json!({"seq":index,"type":"event","event":"loadedSource","body":{"reason":"new","source":{"path":format!("/workspace/{index}.ts")}}}),
        );
    }
    push_message(
        &shared,
        json!({"seq":5000,"type":"event","event":"stopped","body":{"threadId":1,"reason":"breakpoint"}}),
    );
    let mut state = shared.lock().unwrap();
    let mut cursor = 0;
    loop {
        let read = read_buffered_state(&mut state, cursor, 128).unwrap();
        assert!(!read.output_gap);
        if read.messages.is_empty() {
            break;
        }
        cursor = read.next_sequence;
        if cursor == 5001 {
            assert_eq!(read.messages.last().unwrap().message["event"], "stopped");
        }
    }
    assert_eq!(cursor, 5001);
    drop(state);
    for index in 5001..5004 {
        push_message(
            &shared,
            json!({"seq":index,"payload":"x".repeat(crate::MAX_MESSAGE_BYTES / 2)}),
        );
    }
    let mut state = shared.lock().unwrap();
    assert!(state.buffered_message_bytes <= crate::MAX_MESSAGE_BYTES);
    assert!(read_buffered_state(&mut state, 0, 128).unwrap().output_gap);
}

#[test]
fn buffered_messages_advance_only_through_the_returned_page() {
    let shared = std::sync::Arc::new(std::sync::Mutex::new(DebugAdapterState::default()));
    for index in 0..200 {
        push_message(&shared, json!({ "seq": index }));
    }
    let mut state = std::mem::take(&mut *shared.lock().unwrap());

    let first = read_buffered_state(&mut state, 0, 128).unwrap();
    assert_eq!(first.messages.len(), 128);
    assert_eq!(first.next_sequence, 128);

    let second = read_buffered_state(&mut state, first.next_sequence, 128).unwrap();
    assert_eq!(second.messages.len(), 72);
    assert_eq!(second.next_sequence, 200);
}

#[test]
fn adapter_cwd_uses_the_authorized_directory_canonical_form() {
    use super::DebugAdapterError;
    use std::path::PathBuf;

    let root = std::env::temp_dir();
    let service = service(std::env::vars().collect());
    let command = |cwd| {
        DebugAdapterCommand::new(
            std::env::current_exe().unwrap().to_string_lossy(),
            vec!["--list".into()],
        )
        .unwrap()
        .with_options(Some(cwd), Default::default())
        .unwrap()
    };
    for cwd in [root.clone(), PathBuf::from(".")] {
        let id = service.start(command(cwd)).unwrap();
        service.close(&id).unwrap();
    }
    assert!(matches!(
        service.start(command(root.parent().unwrap().to_path_buf())),
        Err(DebugAdapterError::InvalidCommand)
    ));
}

#[test]
fn process_exit_is_reported_after_the_final_response_and_stderr_are_read() {
    let response = json!({
        "seq": 2, "type": "response", "request_seq": 1, "command": "evaluate", "success": true,
        "body": {"result": "42", "variablesReference": 0}
    });
    let frame = String::from_utf8(crate::encode_message(&response).unwrap()).unwrap();
    let (program, arguments) = if cfg!(windows) {
        (
            "powershell.exe",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write($env:ASH_TEST_DAP_FRAME); [Console]::Error.Write('final adapter diagnostic'); exit 7",
            ],
        )
    } else {
        (
            "/bin/sh",
            vec![
                "-c",
                r#"printf '%s' "$ASH_TEST_DAP_FRAME"; printf '%s' 'final adapter diagnostic' >&2; exit 7"#,
            ],
        )
    };
    let command =
        DebugAdapterCommand::new(program, arguments.into_iter().map(String::from).collect())
            .unwrap()
            .with_options(
                None,
                HashMap::from([("ASH_TEST_DAP_FRAME".into(), Some(frame))]),
            )
            .unwrap();
    let mut service = service(std::env::vars().collect());
    // Keep the reader tasks idle until the child has exited and the first read polls its status.
    service.runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let id = service.start(command).unwrap();
    let session = service.session(&id).unwrap();
    let timeout = Duration::from_secs(10);
    let deadline = Instant::now() + timeout;
    {
        let mut process = session.process.try_lock().unwrap();
        let child = process.as_mut().unwrap();
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "Adapter process did not exit");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    let read = service.read(&id, 0, 128).unwrap();
    assert!(read.messages.is_empty());
    assert!(read.stderr.is_empty());
    assert!(!read.exited);
    assert_eq!(read.exit_code, None);

    service.runtime.block_on(async {
        let readers = session.readers.lock().await;
        tokio::time::timeout(timeout, async {
            while readers.iter().any(|reader| !reader.is_finished()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Adapter readers did not finish");
    });
    let read = service.read(&id, read.next_sequence, 128).unwrap();
    assert_eq!(read.messages.len(), 1);
    assert_eq!(read.messages[0].message, response);
    assert_eq!(read.stderr, "final adapter diagnostic");
    assert!(read.exited);
    assert_eq!(read.exit_code, Some(7));
    assert_eq!(read.protocol_error, None);
    service.close(&id).unwrap();
}

#[test]
fn connection_reader_reports_eof_and_frame_errors_without_inventing_exit_codes() {
    use super::DebugAdapterConnection;
    use std::io::Write;

    let service = service(HashMap::new());
    for invalid_frame in [false, true] {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(if invalid_frame { b"Content-Length: 20\r\n\r\n{}" } else { b"Content-Length: 45\r\n\r\n{\"seq\":0,\"type\":\"event\",\"event\":\"terminated\"}" }).unwrap();
        });
        let id = service
            .connect(DebugAdapterConnection::Server { port, host: None })
            .unwrap();
        peer.join().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let read = service.read(&id, 0, 1).unwrap();
            if read.exited {
                assert_eq!(read.exit_code, None);
                assert_eq!(read.protocol_error.is_some(), invalid_frame);
                if !invalid_frame {
                    assert_eq!(read.messages[0].message["event"], "terminated");
                }
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Closed connection was not observed"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        service.close(&id).unwrap();
    }
}

use serde_json::json;

use super::DebugAdapterState;
use super::push_message;
use super::read_buffered_state;

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
fn connection_reader_reports_eof_and_frame_errors_without_inventing_exit_codes() {
    use super::DebugAdapterConnection;
    use super::DebugAdapterService;
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use std::io::Write;
    use std::time::Duration;
    use std::time::Instant;

    let authorization = |permission| {
        Grant::for_environment(
            Dir::open_local(std::env::temp_dir()).unwrap(),
            GrantSource::HostConfiguration,
            Permissions::new([permission]),
        )
        .authorize(permission)
        .unwrap()
    };
    let service = DebugAdapterService::new(
        authorization(Permission::LoadConfig),
        authorization(Permission::ExecuteCommands),
        Default::default(),
    )
    .unwrap();
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

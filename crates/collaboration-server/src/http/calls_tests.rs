use super::*;
use ash_collaboration::SqliteDocumentCollaborationRooms;
use std::io::Write;
use std::net::TcpListener;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;

struct MediaServer {
    service: Arc<MediaService>,
    fail: Arc<Mutex<Option<String>>>,
    requests: Arc<Mutex<Vec<(String, bool)>>>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl MediaServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let service = Arc::new(
            MediaService::new(
                &url.replacen("http", "ws", 1),
                &url,
                "test".into(),
                ash_secrets::SecretValue::new(
                    b"test-secret-with-at-least-thirty-two-bytes".to_vec(),
                ),
            )
            .unwrap(),
        );
        let fail = Arc::new(Mutex::new(None::<String>));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let failure = fail.clone();
        let log = requests.clone();
        let stop = stopped.clone();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let request = match super::super::wire::read_request(&mut stream) {
                    Ok(request) => request,
                    // A cancelled retry may connect and close before sending a
                    // complete request. The fake server must keep serving later
                    // recovery attempts in that case.
                    Err(_) => continue,
                };
                let method = request.target.rsplit('/').next().unwrap().to_owned();
                let mut fail = failure.lock().unwrap();
                let failed = fail.as_ref() == Some(&method);
                if failed {
                    *fail = None;
                }
                drop(fail);
                log.lock().unwrap().push((method, failed));
                if failed {
                    let body = r#"{"code":"unavailable","msg":"temporary media outage"}"#;
                    let _ = write!(
                        stream,
                        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                } else {
                    // Empty protobuf encodes a successful empty response / default room.
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/protobuf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            }
        });
        Self {
            service,
            fail,
            requests,
            stopped,
            worker: Some(worker),
        }
    }
}
impl Drop for MediaServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

#[test]
fn recovery_completes_failed_rotations_without_another_client_request() {
    for failed_method in ["DeleteRoom", "CreateRoom"] {
        let server = MediaServer::start();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rooms.sqlite3");
        let calls = CallRuntime::open(&path, server.service.clone()).unwrap();
        let owner = MemberCredential::generate();
        let guest = MemberCredential::generate();
        let call = calls.store.create(&owner, "create").unwrap();
        let call = calls.reconcile(call).ok().unwrap();
        let call = calls
            .store
            .invite(&owner, "invite", call.revision, &guest, CallRole::Speaker)
            .unwrap();
        let guest_id = calls
            .store
            .read(&guest)
            .unwrap()
            .members
            .into_iter()
            .find(|member| member.role == CallRole::Speaker)
            .unwrap()
            .id;
        let rotating = calls
            .store
            .set_role(&owner, "role", call.revision, &guest_id, CallRole::Listener)
            .unwrap();
        *server.fail.lock().unwrap() = Some(failed_method.into());
        assert!(calls.reconcile(rotating.clone()).is_err());
        assert_eq!(
            calls.store.read(&owner).unwrap().media_state,
            rotating.media_state
        );
        assert!(matches!(
            calls.store.join(&guest, "device"),
            Err(CallError::NotReady)
        ));
        let options = crate::CollaborationServerOptions::new(
            "127.0.0.1:0".parse().unwrap(),
            path.clone(),
            "0123456789abcdef0123456789abcdef",
        );
        let mut host = HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(&path).unwrap(),
            options,
        );
        host.calls = Some(calls);
        let host = Arc::new(host);
        let generation = host.updates.current();
        let recovery = Recovery::start(&host).unwrap();
        let started = Instant::now();
        while host.updates.current() == generation {
            assert!(started.elapsed() < Duration::from_secs(5));
            host.updates
                .wait_for_change(generation, Duration::from_millis(50));
        }
        let calls = host.calls.as_ref().unwrap();
        let recovered = calls.store.read(&owner).unwrap();
        assert_eq!(recovered.media_state, MediaState::Ready);
        assert_eq!(recovered.media_epoch, rotating.media_epoch);
        assert_eq!(recovered.revision, rotating.revision + 1);
        assert!(!calls.store.join(&guest, "device").unwrap().microphone);
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(method, failed)| method == failed_method && *failed)
        );
        let count = server.requests.lock().unwrap().len();
        calls.recover(&host.updates).ok().unwrap();
        assert_eq!(
            server.requests.lock().unwrap().len(),
            count,
            "completed rooms must not be deleted again"
        );
        drop(recovery);
    }
}

#[test]
fn startup_keeps_pending_rooms_unjoinable_until_media_recovers() {
    let server = MediaServer::start();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rooms.sqlite3");
    let owner = MemberCredential::generate();
    {
        let store = CallStore::open(&path).unwrap();
        store.create(&owner, "create").unwrap();
    }
    *server.fail.lock().unwrap() = Some("CreateRoom".into());
    let calls = CallRuntime::open(&path, server.service.clone()).unwrap();
    let updates = super::super::UpdateSignal::default();
    calls.recover(&updates).ok().unwrap();
    assert!(matches!(
        calls.store.join(&owner, "device"),
        Err(CallError::NotReady)
    ));
    calls.recover(&updates).ok().unwrap();
    assert!(calls.store.join(&owner, "device").unwrap().microphone);
}

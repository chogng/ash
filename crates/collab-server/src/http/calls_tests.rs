use super::*;
use ash_collab::SqliteDocumentCollaborationRooms;
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
                // Match the product worker when accept inherits nonblocking mode on macOS.
                stream.set_nonblocking(false).unwrap();
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
        )
        .unwrap();
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
    // Recovery is a background retry loop. A slow or interrupted HTTP attempt must
    // leave the room pending until a later pass actually completes media creation.
    let options = crate::CollaborationServerOptions::new(
        "127.0.0.1:0".parse().unwrap(),
        path.clone(),
        "0123456789abcdef0123456789abcdef",
    );
    let mut host = HttpRuntime::new(
        SqliteDocumentCollaborationRooms::open_at(&path).unwrap(),
        options,
    )
    .unwrap();
    host.calls = Some(calls);
    let host = Arc::new(host);
    let recovery = Recovery::start(&host).unwrap();
    let calls = host.calls.as_ref().unwrap();
    let started = Instant::now();
    while calls.store.read(&owner).unwrap().media_state != MediaState::Ready {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "media recovery did not complete"
        );
        let generation = host.updates.current();
        host.updates
            .wait_for_change(generation, Duration::from_millis(50));
    }
    assert!(calls.store.join(&owner, "device").unwrap().microphone);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(method, failed)| method == "CreateRoom" && *failed)
    );
    drop(recovery);
}

#[test]
fn document_links_notify_call_members_without_granting_document_access() {
    let media = MediaServer::start();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rooms.sqlite3");
    let calls = CallRuntime::open(&path, media.service.clone()).unwrap();
    let owner = MemberCredential::generate();
    let guest = MemberCredential::generate();
    let call = calls.store.create(&owner, "create").unwrap();
    let call = calls.reconcile(call).ok().unwrap();
    let call = calls
        .store
        .invite(&owner, "invite", call.revision, &guest, CallRole::Listener)
        .unwrap();
    let options = crate::CollaborationServerOptions::new(
        "127.0.0.1:0".parse().unwrap(),
        path.clone(),
        "0123456789abcdef0123456789abcdef",
    );
    let mut host = HttpRuntime::new(
        SqliteDocumentCollaborationRooms::open_at(&path).unwrap(),
        options,
    )
    .unwrap();
    host.calls = Some(calls);
    let host = Arc::new(host);
    let document_owner = ash_collab::DocumentCollaborationPrincipal {
        id: "document-owner".into(),
        display_name: "Owner".into(),
    };
    let room = host.rooms.open_as(&document_owner, ash_collab::DocumentCollaborationOpenParams {
        room_id: None, client_id: "owner-client".into(), schema_id: "stanza-document-v1".into(),
        document: r#"{"format":"ash.document","version":1,"document":{"id":"document","type":"doc","attrs":{},"marks":[],"content":[]}}"#.into(),
    }).unwrap();
    let invitation = host
        .rooms
        .create_invite(
            &room.snapshot.room_id,
            &document_owner,
            "Document viewer",
            ash_collab::DocumentCollaborationRoomRole::Viewer,
        )
        .unwrap();
    let document = json!({"serverUrl":"https://documents.example","roomId":room.snapshot.room_id,"schemaId":"stanza-document-v1","contentType":"application/test-document","title":"Shared notes"});
    let body = json!({"operationId":"share","revision":call.revision,"change":{"type":"share","document":document}});
    let media_requests = media.requests.lock().unwrap().len();
    let generation = host.updates.current();
    let denied = http_call(&host, "POST", "/v1/calls/documents", guest.expose(), &body);
    assert_eq!(denied.0, 403);
    let accepted = http_call(&host, "POST", "/v1/calls/documents", owner.expose(), &body);
    assert_eq!(accepted.0, 200);
    assert_eq!(accepted.1["documents"], json!([document]));
    assert!(host.updates.current() > generation);
    assert_eq!(media.requests.lock().unwrap().len(), media_requests);
    let watched = http_call(
        &host,
        "GET",
        &format!("/v1/calls/watch?afterRevision={}", call.revision),
        guest.expose(),
        &Value::Null,
    );
    assert_eq!(watched.0, 200);
    assert_eq!(watched.1["documents"], accepted.1["documents"]);
    let doc_open = json!({"roomId":room.snapshot.room_id,"clientId":"guest","schemaId":"stanza-document-v1","document":"{}"});
    assert_eq!(
        http_call(
            &host,
            "POST",
            "/v1/document-collaboration/rooms/open",
            guest.expose(),
            &doc_open
        )
        .0,
        401
    );
    assert_eq!(
        http_call(
            &host,
            "POST",
            "/v1/document-collaboration/rooms/open",
            &invitation.access_token,
            &doc_open
        )
        .0,
        200
    );
    let mut invalid = body.clone();
    invalid["change"]["document"]["accessToken"] = json!("a-secret-must-not-enter-call-snapshots");
    assert_eq!(
        http_call(
            &host,
            "POST",
            "/v1/calls/documents",
            owner.expose(),
            &invalid
        )
        .0,
        400
    );
}

fn http_call(
    host: &Arc<HttpRuntime>,
    method: &str,
    path: &str,
    token: &str,
    body: &Value,
) -> (u16, Value) {
    use std::io::Read;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let host = host.clone();
    let worker = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        super::super::handle_connection(stream, &host).unwrap();
    });
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let body = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    worker.join().unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

#[test]
fn channel_calls_converge_and_retire_media_permissions_after_membership_changes() {
    use ash_collab::channels::*;
    let media = MediaServer::start();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("channels.sqlite");
    let channels = ChannelStore::open(&path).unwrap();
    let owner = ChannelCredential::generate().unwrap();
    let editor = ChannelCredential::generate().unwrap();
    let viewer = ChannelCredential::generate().unwrap();
    let mut state = channels.create(&owner, "Team", "Alice").unwrap();
    state = channels
        .edit(
            &owner,
            ChannelEditParams {
                space_id: state.id.clone(),
                revision: state.revision,
                change: ChannelChange::Create {
                    name: "meeting".into(),
                    parent_id: None,
                },
            },
        )
        .unwrap();
    for (credential, role) in [
        (&editor, ChannelRole::Editor),
        (&viewer, ChannelRole::Viewer),
    ] {
        state = channels
            .invite(
                &owner,
                ChannelInvite {
                    params: ChannelInviteParams {
                        space_id: state.id.clone(),
                        revision: state.revision,
                        name: "Member".into(),
                        role,
                    },
                    credential: credential.expose().into(),
                },
            )
            .unwrap();
    }
    let target = ChannelResourceParams {
        space_id: state.id.clone(),
        channel_id: state.channels[0].id.clone(),
    };
    let access = |credential| {
        channels
            .resource(credential, target.clone(), ChannelResourceKind::Call)
            .unwrap()
    };
    let owner_key = MemberCredential::parse(access(&owner).credential).unwrap();
    let editor_key = MemberCredential::parse(access(&editor).credential).unwrap();
    let viewer_key = MemberCredential::parse(access(&viewer).credential).unwrap();
    let calls = CallRuntime::open(&path, media.service.clone()).unwrap();
    assert!(matches!(
        calls.store.open_channel(&viewer_key),
        Err(CallError::Denied)
    ));
    // Two independent database connections race to create the same channel room.
    let other = CallRuntime::open(&path, media.service.clone()).unwrap();
    let (first, second) = thread::scope(|scope| {
        let first = scope.spawn(|| calls.store.open_channel(&editor_key).unwrap());
        let second = scope.spawn(|| other.store.open_channel(&owner_key).unwrap());
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_eq!(first.id, second.id);
    assert_eq!(first.media_room, second.media_room);
    let editor_id = channels.read(&editor).unwrap().member_id;
    let owner_id = state.member_id.clone();
    // The preparing media snapshot still has the original owner. Channel roles
    // must revoke control even before this media transition can be completed.
    for (member_id, role) in [
        (&editor_id, ChannelRole::Owner),
        (&owner_id, ChannelRole::Editor),
    ] {
        state = channels
            .edit(
                &owner,
                ChannelEditParams {
                    space_id: state.id.clone(),
                    revision: state.revision,
                    change: ChannelChange::SetRole {
                        member_id: member_id.clone(),
                        role,
                    },
                },
            )
            .unwrap();
    }
    assert!(matches!(
        calls.store.end(&owner_key, "demoted-owner", first.revision),
        Err(CallError::Denied)
    ));
    state = channels
        .edit(
            &editor,
            ChannelEditParams {
                space_id: state.id.clone(),
                revision: state.revision,
                change: ChannelChange::SetRole {
                    member_id: owner_id,
                    role: ChannelRole::Owner,
                },
            },
        )
        .unwrap();
    state = channels
        .edit(
            &owner,
            ChannelEditParams {
                space_id: state.id.clone(),
                revision: state.revision,
                change: ChannelChange::SetRole {
                    member_id: editor_id.clone(),
                    role: ChannelRole::Editor,
                },
            },
        )
        .unwrap();
    let ready = calls.reconcile(first).ok().unwrap();
    assert!(
        calls
            .store
            .join(&editor_key, "editor-device")
            .unwrap()
            .microphone
    );
    assert!(
        !calls
            .store
            .join(&viewer_key, "viewer-device")
            .unwrap()
            .microphone
    );
    assert!(matches!(
        calls.store.invite(
            &owner_key,
            "bypass",
            ready.revision,
            &MemberCredential::generate(),
            CallRole::Speaker
        ),
        Err(CallError::Denied)
    ));
    state = channels
        .edit(
            &owner,
            ChannelEditParams {
                space_id: state.id.clone(),
                revision: state.revision,
                change: ChannelChange::SetRole {
                    member_id: editor_id.clone(),
                    role: ChannelRole::Viewer,
                },
            },
        )
        .unwrap();
    let updates = super::super::UpdateSignal::default();
    calls.recover(&updates).ok().unwrap();
    let reduced = calls.store.read(&editor_key).unwrap();
    assert_ne!(reduced.media_room, ready.media_room);
    assert!(reduced.media_epoch > ready.media_epoch);
    assert!(
        !calls
            .store
            .join(&editor_key, "editor-device")
            .unwrap()
            .microphone
    );
    state = channels
        .edit(
            &owner,
            ChannelEditParams {
                space_id: state.id.clone(),
                revision: state.revision,
                change: ChannelChange::RemoveMember {
                    member_id: editor_id,
                },
            },
        )
        .unwrap();
    assert!(matches!(
        calls.store.read(&editor_key),
        Err(CallError::Denied)
    ));
    *media.fail.lock().unwrap() = Some("DeleteRoom".into());
    calls.recover(&updates).ok().unwrap();
    assert!(matches!(
        calls.store.join(&owner_key, "owner-device"),
        Err(CallError::NotReady)
    ));
    drop(calls);
    let restored = CallRuntime::open(&path, media.service.clone()).unwrap();
    restored.recover(&updates).ok().unwrap();
    let live = restored.store.read(&owner_key).unwrap();
    assert_eq!(live.media_state, MediaState::Ready);
    assert_ne!(live.media_room, reduced.media_room);
    let closing = restored
        .store
        .end(&owner_key, "finish-channel-call", live.revision)
        .unwrap();
    let closed = restored.reconcile(closing).ok().unwrap();
    assert_eq!(closed.media_state, MediaState::Closed);
    assert!(matches!(
        restored.store.open_channel(&viewer_key),
        Err(CallError::Denied)
    ));
    let restarted = restored.store.open_channel(&owner_key).unwrap();
    assert_eq!(restarted.id, live.id);
    assert!(restarted.media_epoch > live.media_epoch);
    restored.reconcile(restarted).ok().unwrap();
    channels
        .edit(
            &owner,
            ChannelEditParams {
                space_id: state.id.clone(),
                revision: state.revision,
                change: ChannelChange::Remove {
                    channel_id: target.channel_id,
                },
            },
        )
        .unwrap();
    restored.recover(&updates).ok().unwrap();
    assert!(matches!(
        restored.store.read(&owner_key),
        Err(CallError::Denied)
    ));
    assert!(restored.store.pending_media().unwrap().is_empty());
    assert!(
        media
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "DeleteRoom")
    );
}

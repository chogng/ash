use super::HttpRuntime;
use super::serve_listener;
use crate::CollaborationServerOptions;
use ash_collab::SqliteDocumentCollaborationRooms;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use tempfile::TempDir;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const ORIGIN: &str = "https://desktop.ash.example";

#[test]
#[ignore = "requires ASH_TEST_LIVEKIT_SERVER pointing to the pinned server"]
fn media_calls_enforce_membership_and_rotate_self_hosted_rooms() {
    struct MediaProcess(std::process::Child);
    impl Drop for MediaProcess {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = TempDir::new().unwrap();
    let media_port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let udp_port = std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let config = directory.path().join("media.yaml");
    let secret = "ash-test-call-server-secret-thirty-two-bytes";
    std::fs::write(&config, format!("port: {media_port}\nbind_addresses: [127.0.0.1]\nrtc:\n  udp_port: {udp_port}\n  tcp_port: 0\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  test: {secret}\nlogging:\n  level: error\n")).unwrap();
    let mut media = MediaProcess(
        std::process::Command::new(
            std::env::var_os("ASH_TEST_LIVEKIT_SERVER").expect("set the test server path"),
        )
        .arg("--config")
        .arg(config)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .unwrap(),
    );
    let started = std::time::Instant::now();
    while TcpStream::connect(("127.0.0.1", media_port)).is_err() {
        assert!(media.0.try_wait().unwrap().is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        thread::sleep(std::time::Duration::from_millis(20));
    }
    let service = Arc::new(
        livekit_api::MediaService::new(
            &format!("ws://127.0.0.1:{media_port}"),
            &format!("http://127.0.0.1:{media_port}"),
            "test".into(),
            ash_secrets::SecretValue::new(secret.as_bytes().to_vec()),
        )
        .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let options =
        CollaborationServerOptions::new(address, directory.path().join("rooms.sqlite3"), TOKEN)
            .with_allowed_origin(ORIGIN);
    let calls = super::calls::CallRuntime::open(options.database_path(), service).unwrap();
    let mut runtime = HttpRuntime::new(
        SqliteDocumentCollaborationRooms::open_at(options.database_path()).unwrap(),
        options,
    )
    .unwrap();
    runtime.calls = Some(calls);
    let runtime = Arc::new(runtime);
    let shutdown = Arc::new(AtomicBool::new(false));
    let stop = shutdown.clone();
    let worker = thread::spawn(move || serve_listener(listener, runtime, stop).unwrap());
    let owner = call::MemberCredential::generate();
    let guest = call::MemberCredential::generate();
    let request = |method: &str, path: &str, token: &str, body: Value, status| {
        let authorization = format!("Bearer {token}");
        let reply = send(
            address,
            method,
            path,
            &[
                ("Origin", ORIGIN),
                ("Authorization", &authorization),
                ("Content-Type", "application/json"),
            ],
            &serde_json::to_vec(&body).unwrap(),
        );
        assert_eq!(
            reply.status,
            status,
            "{}",
            String::from_utf8_lossy(&reply.body)
        );
        serde_json::from_slice::<Value>(&reply.body).unwrap()
    };
    let create = serde_json::json!({"operationId":"create", "ownerCredential":owner.expose()});
    request(
        "POST",
        "/v1/calls/create",
        guest.expose(),
        create.clone(),
        403,
    );
    let created = request("POST", "/v1/calls/create", TOKEN, create.clone(), 200);
    assert_eq!(created["mediaState"]["state"], "ready");
    assert_eq!(
        request("POST", "/v1/calls/create", TOKEN, create, 200),
        created
    );
    let invited = request(
        "POST",
        "/v1/calls/invite",
        owner.expose(),
        serde_json::json!({"operationId":"invite", "revision":created["revision"], "memberCredential":guest.expose(), "role":"speaker"}),
        200,
    );
    assert_eq!(
        request(
            "GET",
            &format!("/v1/calls/watch?afterRevision={}", created["revision"]),
            guest.expose(),
            Value::Null,
            200
        ),
        invited
    );
    let ticket = request(
        "POST",
        "/v1/calls/join",
        guest.expose(),
        serde_json::json!({"deviceId":"laptop"}),
        200,
    );
    assert!(ticket["participantToken"].as_str().unwrap().len() > 100);
    request(
        "POST",
        "/v1/calls/end",
        guest.expose(),
        serde_json::json!({"operationId":"end", "revision":invited["revision"]}),
        403,
    );
    let changed = request(
        "POST",
        "/v1/calls/role",
        owner.expose(),
        serde_json::json!({"operationId":"role", "revision":invited["revision"], "memberId":ticket["member"]["id"], "role":"listener"}),
        200,
    );
    assert_ne!(changed["mediaRoom"], created["mediaRoom"]);
    let next = request(
        "POST",
        "/v1/calls/join",
        guest.expose(),
        serde_json::json!({"deviceId":"laptop"}),
        200,
    );
    assert_ne!(next["participantId"], ticket["participantId"]);
    assert_eq!(next["member"]["role"], "listener");
    let removed = request(
        "POST",
        "/v1/calls/remove",
        owner.expose(),
        serde_json::json!({"operationId":"remove", "revision":changed["revision"], "memberId":ticket["member"]["id"]}),
        200,
    );
    request(
        "POST",
        "/v1/calls/join",
        guest.expose(),
        serde_json::json!({"deviceId":"laptop"}),
        403,
    );
    request(
        "GET",
        "/v1/calls/watch?afterRevision=0",
        guest.expose(),
        Value::Null,
        403,
    );
    let ended = request(
        "POST",
        "/v1/calls/end",
        owner.expose(),
        serde_json::json!({"operationId":"end", "revision":removed["revision"]}),
        200,
    );
    assert_eq!(ended["mediaState"]["state"], "closed");
    request(
        "POST",
        "/v1/calls/join",
        owner.expose(),
        serde_json::json!({"deviceId":"laptop"}),
        409,
    );
    shutdown.store(true, Ordering::Release);
    worker.join().unwrap();
}

#[test]
fn remote_host_authenticates_origins_and_orders_cross_client_updates() {
    let directory = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let options =
        CollaborationServerOptions::new(address, directory.path().join("rooms.sqlite3"), TOKEN)
            .with_allowed_origin(ORIGIN);
    let runtime = Arc::new(
        HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(options.database_path()).unwrap(),
            options,
        )
        .unwrap(),
    );
    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_runtime = runtime.clone();
    let worker_shutdown = shutdown.clone();
    let worker =
        thread::spawn(move || serve_listener(listener, worker_runtime, worker_shutdown).unwrap());

    let unauthorized = send(
        address,
        "POST",
        "/v1/document-collaboration/rooms/open",
        &[("Origin", ORIGIN), ("Content-Type", "application/json")],
        b"{}",
    );
    assert_eq!(unauthorized.status, 401);
    assert_eq!(
        unauthorized.headers.get("access-control-allow-origin"),
        Some(&ORIGIN.into())
    );
    let rejected_origin = send(
        address,
        "OPTIONS",
        "/v1/document-collaboration/rooms/open",
        &[("Origin", "https://other.example")],
        b"",
    );
    assert_eq!(rejected_origin.status, 403);
    let preflight = send(
        address,
        "OPTIONS",
        "/v1/document-collaboration/rooms/open",
        &[("Origin", ORIGIN)],
        b"",
    );
    assert_eq!(preflight.status, 204);
    assert_eq!(
        preflight.headers.get("access-control-allow-origin"),
        Some(&ORIGIN.into())
    );

    let opened = send_json(
        address,
        "/v1/document-collaboration/rooms/open",
        &serde_json::json!({
            "clientId": "client-a",
            "schemaId": "stanza-document-v1",
            "document": document("initial"),
        }),
    );
    assert_eq!(opened.status, 200);
    let opened_body: Value = serde_json::from_slice(&opened.body).unwrap();
    let room_id = opened_body["snapshot"]["roomId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(opened_body["snapshot"]["version"], 0);
    assert_eq!(opened_body["canEdit"], true);
    assert_eq!(opened_body["canManageMembers"], true);

    let joined = send_json(
        address,
        "/v1/document-collaboration/rooms/open",
        &serde_json::json!({
            "roomId": room_id,
            "clientId": "client-b",
            "schemaId": "stanza-document-v1",
            "document": document("ignored"),
        }),
    );
    assert_eq!(joined.status, 200);

    let submitted = send_json(
        address,
        "/v1/document-collaboration/rooms/submit",
        &serde_json::json!({
            "roomId": room_id,
            "clientId": "client-a",
            "sequence": 1,
            "baseVersion": 0,
            "transaction": transaction(),
            "document": document("first"),
        }),
    );
    assert_eq!(submitted.status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&submitted.body).unwrap()["status"],
        "accepted"
    );

    let updates = send(
        address,
        "GET",
        &format!("/v1/document-collaboration/rooms/{room_id}/updates?afterVersion=0"),
        &[
            ("Authorization", &format!("Bearer {TOKEN}")),
            ("Origin", ORIGIN),
        ],
        b"",
    );
    assert_eq!(updates.status, 200);
    let updates_body: Value = serde_json::from_slice(&updates.body).unwrap();
    assert_eq!(updates_body["status"], "updates");
    assert_eq!(updates_body["updates"][0]["clientId"], "client-a");
    assert_eq!(updates_body["updates"][0]["version"], 1);

    shutdown.store(true, Ordering::Release);
    worker.join().unwrap();
}

#[test]
fn remote_host_enforces_room_roles_rotates_credentials_and_exposes_owner_audit() {
    let directory = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let options =
        CollaborationServerOptions::new(address, directory.path().join("rooms.sqlite3"), TOKEN)
            .with_allowed_origin(ORIGIN);
    let runtime = Arc::new(
        HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(options.database_path()).unwrap(),
            options,
        )
        .unwrap(),
    );
    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_runtime = runtime.clone();
    let worker_shutdown = shutdown.clone();
    let worker =
        thread::spawn(move || serve_listener(listener, worker_runtime, worker_shutdown).unwrap());

    let opened = send_json(
        address,
        "/v1/document-collaboration/rooms/open",
        &serde_json::json!({
            "clientId": "owner-client", "schemaId": "stanza-document-v1", "document": document("initial"),
        }),
    );
    let room_id = serde_json::from_slice::<Value>(&opened.body).unwrap()["snapshot"]["roomId"]
        .as_str()
        .unwrap()
        .to_string();
    let viewer = send_json(
        address,
        "/v1/document-collaboration/rooms/invites",
        &serde_json::json!({
            "roomId": room_id, "displayName": "Viewer", "role": "viewer",
        }),
    );
    assert_eq!(viewer.status, 201);
    let viewer_body: Value = serde_json::from_slice(&viewer.body).unwrap();
    let viewer_token = viewer_body["accessToken"].as_str().unwrap().to_string();
    let viewer_id = viewer_body["principalId"].as_str().unwrap().to_string();

    let members = send(
        address,
        "GET",
        &format!("/v1/document-collaboration/rooms/{room_id}/members"),
        &[
            ("Authorization", &format!("Bearer {TOKEN}")),
            ("Origin", ORIGIN),
        ],
        b"",
    );
    assert_eq!(members.status, 200);
    let members_body: Value = serde_json::from_slice(&members.body).unwrap();
    assert_eq!(members_body["members"].as_array().unwrap().len(), 2);

    let viewer_open = send_json_as(
        address,
        "/v1/document-collaboration/rooms/open",
        &viewer_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "viewer-client", "schemaId": "stanza-document-v1", "document": document("ignored"),
        }),
    );
    assert_eq!(viewer_open.status, 200);
    let viewer_open_body: Value = serde_json::from_slice(&viewer_open.body).unwrap();
    assert_eq!(viewer_open_body["canEdit"], false);
    assert_eq!(viewer_open_body["canManageMembers"], false);
    assert_eq!(viewer_open_body["principalId"], viewer_id);
    let viewer_members = send(
        address,
        "GET",
        &format!("/v1/document-collaboration/rooms/{room_id}/members"),
        &[
            ("Authorization", &format!("Bearer {viewer_token}")),
            ("Origin", ORIGIN),
        ],
        b"",
    );
    assert_eq!(viewer_members.status, 403);
    let viewer_submit = send_json_as(
        address,
        "/v1/document-collaboration/rooms/submit",
        &viewer_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "viewer-client", "sequence": 1, "baseVersion": 0, "transaction": transaction(), "document": document("rejected"),
        }),
    );
    assert_eq!(viewer_submit.status, 403);
    let viewer_presence = send_json_as(
        address,
        "/v1/document-collaboration/rooms/presence",
        &viewer_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "viewer-client", "selection": selection(),
        }),
    );
    assert_eq!(viewer_presence.status, 204);
    let presence = send(
        address,
        "GET",
        &format!("/v1/document-collaboration/rooms/{room_id}/presence?afterGeneration=0"),
        &[
            ("Authorization", &format!("Bearer {TOKEN}")),
            ("Origin", ORIGIN),
        ],
        b"",
    );
    assert_eq!(presence.status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&presence.body).unwrap()["presences"][0]["clientId"],
        "viewer-client"
    );

    let editor = send_json(
        address,
        "/v1/document-collaboration/rooms/invites",
        &serde_json::json!({
            "roomId": room_id, "displayName": "Editor", "role": "editor",
        }),
    );
    let editor_body: Value = serde_json::from_slice(&editor.body).unwrap();
    let editor_token = editor_body["accessToken"].as_str().unwrap().to_string();
    let editor_id = editor_body["principalId"].as_str().unwrap().to_string();
    let editor_submit = send_json_as(
        address,
        "/v1/document-collaboration/rooms/submit",
        &editor_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "editor-client", "sequence": 1, "baseVersion": 0, "transaction": transaction(), "document": document("accepted"),
        }),
    );
    assert_eq!(editor_submit.status, 200);

    let rotated = send_json(
        address,
        "/v1/document-collaboration/rooms/members/rotate-token",
        &serde_json::json!({
            "roomId": room_id, "principalId": editor_id,
        }),
    );
    assert_eq!(rotated.status, 200);
    let rotated_token = serde_json::from_slice::<Value>(&rotated.body).unwrap()["accessToken"]
        .as_str()
        .unwrap()
        .to_string();
    let expired = send_json_as(
        address,
        "/v1/document-collaboration/rooms/open",
        &editor_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "editor-client", "schemaId": "stanza-document-v1", "document": document("ignored"),
        }),
    );
    assert_eq!(expired.status, 401);
    let renewed = send_json_as(
        address,
        "/v1/document-collaboration/rooms/open",
        &rotated_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "editor-client", "schemaId": "stanza-document-v1", "document": document("ignored"),
        }),
    );
    assert_eq!(renewed.status, 200);

    let revoked = send_json(
        address,
        "/v1/document-collaboration/rooms/members/revoke",
        &serde_json::json!({
            "roomId": room_id, "principalId": editor_id,
        }),
    );
    assert_eq!(revoked.status, 204);
    let revoked_open = send_json_as(
        address,
        "/v1/document-collaboration/rooms/open",
        &rotated_token,
        &serde_json::json!({
            "roomId": room_id, "clientId": "editor-client", "schemaId": "stanza-document-v1", "document": document("ignored"),
        }),
    );
    assert_eq!(revoked_open.status, 401);
    let members_after_revocation = send(
        address,
        "GET",
        &format!("/v1/document-collaboration/rooms/{room_id}/members"),
        &[
            ("Authorization", &format!("Bearer {TOKEN}")),
            ("Origin", ORIGIN),
        ],
        b"",
    );
    assert_eq!(members_after_revocation.status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&members_after_revocation.body).unwrap()["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let audit = send(
        address,
        "GET",
        &format!("/v1/document-collaboration/rooms/{room_id}/audit"),
        &[
            ("Authorization", &format!("Bearer {TOKEN}")),
            ("Origin", ORIGIN),
        ],
        b"",
    );
    assert_eq!(audit.status, 200);
    let audit_body: Value = serde_json::from_slice(&audit.body).unwrap();
    assert_eq!(audit_body["events"].as_array().unwrap().len(), 6);
    assert_eq!(audit_body["events"][4]["eventType"], "member.token_rotated");
    assert_eq!(audit_body["events"][5]["eventType"], "member.revoked");

    shutdown.store(true, Ordering::Release);
    worker.join().unwrap();
}

#[test]
fn remote_hosts_recheck_shared_sqlite_for_cross_instance_updates() {
    let directory = TempDir::new().unwrap();
    let database_path = directory.path().join("rooms.sqlite3");
    let listener_a = TcpListener::bind("127.0.0.1:0").unwrap();
    let address_a = listener_a.local_addr().unwrap();
    let listener_b = TcpListener::bind("127.0.0.1:0").unwrap();
    let address_b = listener_b.local_addr().unwrap();
    let options_a = CollaborationServerOptions::new(address_a, &database_path, TOKEN)
        .with_allowed_origin(ORIGIN);
    let options_b = CollaborationServerOptions::new(address_b, &database_path, TOKEN)
        .with_allowed_origin(ORIGIN);
    let runtime_a = Arc::new(
        HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(options_a.database_path()).unwrap(),
            options_a,
        )
        .unwrap(),
    );
    let runtime_b = Arc::new(
        HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(options_b.database_path()).unwrap(),
            options_b,
        )
        .unwrap(),
    );
    let shutdown_a = Arc::new(AtomicBool::new(false));
    let shutdown_b = Arc::new(AtomicBool::new(false));
    let worker_a = thread::spawn({
        let runtime = runtime_a.clone();
        let shutdown = shutdown_a.clone();
        move || serve_listener(listener_a, runtime, shutdown).unwrap()
    });
    let worker_b = thread::spawn({
        let runtime = runtime_b.clone();
        let shutdown = shutdown_b.clone();
        move || serve_listener(listener_b, runtime, shutdown).unwrap()
    });

    let opened = send_json(
        address_a,
        "/v1/document-collaboration/rooms/open",
        &serde_json::json!({
            "clientId": "client-a", "schemaId": "stanza-document-v1", "document": document("initial"),
        }),
    );
    let room_id = serde_json::from_slice::<Value>(&opened.body).unwrap()["snapshot"]["roomId"]
        .as_str()
        .unwrap()
        .to_string();
    let poll_room_id = room_id.clone();
    let poll = thread::spawn(move || {
        send(
            address_b,
            "GET",
            &format!("/v1/document-collaboration/rooms/{poll_room_id}/updates?afterVersion=0"),
            &[
                ("Authorization", &format!("Bearer {TOKEN}")),
                ("Origin", ORIGIN),
            ],
            b"",
        )
    });
    thread::sleep(std::time::Duration::from_millis(100));
    let submitted = send_json(
        address_a,
        "/v1/document-collaboration/rooms/submit",
        &serde_json::json!({
            "roomId": room_id, "clientId": "client-a", "sequence": 1, "baseVersion": 0, "transaction": transaction(), "document": document("first"),
        }),
    );
    assert_eq!(submitted.status, 200);
    let updates = poll.join().unwrap();
    assert_eq!(updates.status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&updates.body).unwrap()["updates"][0]["version"],
        1
    );

    shutdown_a.store(true, Ordering::Release);
    shutdown_b.store(true, Ordering::Release);
    worker_a.join().unwrap();
    worker_b.join().unwrap();
}

fn send_json(address: SocketAddr, path: &str, body: &Value) -> HttpResponse {
    send_json_as(address, path, TOKEN, body)
}

fn send_json_as(address: SocketAddr, path: &str, token: &str, body: &Value) -> HttpResponse {
    let encoded = serde_json::to_vec(body).unwrap();
    let authorization = format!("Bearer {token}");
    send(
        address,
        "POST",
        path,
        &[
            ("Authorization", &authorization),
            ("Origin", ORIGIN),
            ("Content-Type", "application/json"),
        ],
        &encoded,
    )
}

fn send(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> HttpResponse {
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Length: {}\r\n",
        body.len()
    )
    .unwrap();
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").unwrap();
    }
    write!(stream, "\r\n").unwrap();
    stream.write_all(body).unwrap();
    stream.flush().unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    decode_response(&response)
}

struct HttpResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn decode_response(bytes: &[u8]) -> HttpResponse {
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let head = std::str::from_utf8(&bytes[..header_end]).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().into()))
        .collect();
    HttpResponse {
        status,
        headers,
        body: bytes[header_end + 4..].to_vec(),
    }
}

fn document(value: &str) -> String {
    format!(
        r#"{{"format":"ash.document","version":1,"document":{{"id":"document-1","type":"doc","attrs":{{}},"marks":[],"content":[{{"id":"text-1","type":"text","attrs":{{}},"marks":[],"content":[],"text":"{value}"}}]}}}}"#
    )
}

fn transaction() -> String {
    r#"{"format":"ash.document.transaction","version":1,"transaction":{"steps":[],"addToHistory":true,"selectionSet":false,"storedMarksSet":false,"metadata":[]}}"#.into()
}

fn selection() -> &'static str {
    r#"{"kind":"text","anchor":{"nodeId":"text-1","offset":0},"head":{"nodeId":"text-1","offset":1}}"#
}

#[test]
fn channel_accounts_share_durable_trees_and_enforce_remote_permissions() {
    use ash_collab::channel_client::ChannelAccount;
    use ash_collab::channels::ChannelChange;
    use ash_collab::channels::ChannelConnectParams;
    use ash_collab::channels::ChannelEditParams;
    use ash_collab::channels::ChannelError;
    use ash_collab::channels::ChannelInviteParams;
    use ash_collab::channels::ChannelRole;
    let directory = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let options =
        CollaborationServerOptions::new(address, directory.path().join("channels.sqlite"), TOKEN)
            .with_allowed_origin(ORIGIN);
    let host = Arc::new(
        HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(options.database_path()).unwrap(),
            options,
        )
        .unwrap(),
    );
    let shutdown = Arc::new(AtomicBool::new(false));
    let stop = shutdown.clone();
    let worker = thread::spawn(move || serve_listener(listener, host, stop).unwrap());
    let url = format!("http://{address}");
    let saved = Arc::new(ash_secrets::MemorySecretStore::default());
    let mut owner = ChannelAccount::default();
    owner.set_secret_store(saved.clone());
    let mut state = owner
        .connect(ChannelConnectParams::Create {
            server_url: url.clone(),
            administrator: TOKEN.into(),
            name: "Team".into(),
            member_name: "Alice".into(),
        })
        .unwrap()
        .snapshot;
    let mut editor = ChannelAccount::default();
    editor.set_secret_store(Arc::new(ash_secrets::MemorySecretStore::default()));
    let invite = owner
        .invite(ChannelInviteParams {
            space_id: state.id.clone(),
            revision: state.revision,
            name: "Bob".into(),
            role: ChannelRole::Editor,
        })
        .unwrap();
    let joined = editor
        .connect(ChannelConnectParams::Join {
            server_url: invite.server_url,
            credential: invite.credential.clone(),
        })
        .unwrap();
    state = joined.snapshot.clone();
    let edited = editor
        .edit(ChannelEditParams {
            space_id: state.id.clone(),
            revision: state.revision,
            change: ChannelChange::Create {
                name: "general".into(),
                parent_id: None,
            },
        })
        .unwrap();
    assert_eq!(
        owner.read().unwrap().unwrap().snapshot.channels,
        edited.snapshot.channels
    );
    // A second window/process restores the profile account without exposing its credential.
    let mut restored = ChannelAccount::default();
    restored.set_secret_store(saved);
    state = restored.read().unwrap().unwrap().snapshot;
    let backup = owner.sign_in_key().unwrap();
    let mut another_device = ChannelAccount::default();
    another_device.set_secret_store(Arc::new(ash_secrets::MemorySecretStore::default()));
    let recovered = another_device
        .connect(ChannelConnectParams::Join {
            server_url: backup.server_url,
            credential: backup.credential,
        })
        .unwrap();
    assert_eq!(recovered.snapshot.member_id, state.member_id);
    state = owner
        .edit(ChannelEditParams {
            space_id: state.id.clone(),
            revision: state.revision,
            change: ChannelChange::SetRole {
                member_id: joined.snapshot.member_id.clone(),
                role: ChannelRole::Viewer,
            },
        })
        .unwrap()
        .snapshot;
    assert!(matches!(
        editor.edit(ChannelEditParams {
            space_id: state.id.clone(),
            revision: state.revision,
            change: ChannelChange::Create {
                name: "denied".into(),
                parent_id: None
            }
        }),
        Err(ChannelError::Denied)
    ));
    assert!(matches!(
        editor.invite(ChannelInviteParams {
            space_id: state.id.clone(),
            revision: state.revision,
            name: "Mallory".into(),
            role: ChannelRole::Owner
        }),
        Err(ChannelError::Denied)
    ));
    owner
        .edit(ChannelEditParams {
            space_id: state.id.clone(),
            revision: state.revision,
            change: ChannelChange::RemoveMember {
                member_id: joined.snapshot.member_id,
            },
        })
        .unwrap();
    assert!(matches!(editor.read(), Err(ChannelError::Denied)));
    let authorization = format!("Bearer {}", invite.credential);
    assert_eq!(
        send(
            address,
            "GET",
            "/v1/channels/read",
            &[("Authorization", &authorization)],
            b""
        )
        .status,
        403
    );
    assert_eq!(
        send(address, "GET", "/v1/channels/read", &[], b"").status,
        401
    );
    assert_eq!(
        send(
            address,
            "GET",
            "/v1/channels/read",
            &[
                ("Origin", "https://untrusted.example"),
                ("Authorization", &format!("Bearer {TOKEN}"))
            ],
            b""
        )
        .status,
        403
    );
    owner.disconnect().unwrap();
    assert!(restored.read().unwrap().is_none());
    shutdown.store(true, Ordering::Release);
    worker.join().unwrap();
    let store =
        ash_collab::channels::ChannelStore::open(directory.path().join("channels.sqlite")).unwrap();
    assert_eq!(
        store.read(&ash_collab::channels::ChannelCredential::parse(invite.credential).unwrap()),
        Err(ChannelError::Denied)
    );
}

#[test]
fn fragmented_channel_request_waits_on_an_accepted_nonblocking_socket() {
    let directory = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let options =
        CollaborationServerOptions::new(address, directory.path().join("channels.sqlite"), TOKEN);
    let runtime = HttpRuntime::new(
        SqliteDocumentCollaborationRooms::open_at(options.database_path()).unwrap(),
        options,
    )
    .unwrap();
    let (accepted, ready) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        // Force the inherited mode on every OS, not only on macOS/BSD.
        stream.set_nonblocking(true).unwrap();
        accepted.send(()).unwrap();
        super::handle_connection(stream, &runtime).unwrap();
    });
    let mut client = TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    client
        .write_all(b"GET /v1/channels/read HTTP/1.1\r\nHost: localhost\r\n")
        .unwrap();
    ready.recv().unwrap();
    // The second packet arrives after the worker has started reading the first.
    thread::sleep(std::time::Duration::from_millis(50));
    client.write_all(b"\r\n").unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    worker.join().unwrap();
    assert_eq!(decode_response(&response).status, 401);
}

#[test]
fn channel_notes_share_one_durable_room_and_follow_live_channel_permissions() {
    use ash_collab::channel_client::ChannelAccount;
    use ash_collab::channels::*;
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("notes.sqlite");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let options =
        CollaborationServerOptions::new(address, path.clone(), TOKEN).with_allowed_origin(ORIGIN);
    let host = Arc::new(
        HttpRuntime::new(
            SqliteDocumentCollaborationRooms::open_at(&path).unwrap(),
            options,
        )
        .unwrap(),
    );
    let shutdown = Arc::new(AtomicBool::new(false));
    let stop = shutdown.clone();
    let worker = thread::spawn(move || serve_listener(listener, host, stop).unwrap());
    let mut owner = ChannelAccount::default();
    owner.set_secret_store(Arc::new(ash_secrets::MemorySecretStore::default()));
    let state = owner
        .connect(ChannelConnectParams::Create {
            server_url: format!("http://{address}"),
            administrator: TOKEN.into(),
            name: "Notes team".into(),
            member_name: "Alice".into(),
        })
        .unwrap()
        .snapshot;
    let state = owner
        .edit(ChannelEditParams {
            space_id: state.id.clone(),
            revision: state.revision,
            change: ChannelChange::Create {
                name: "design".into(),
                parent_id: None,
            },
        })
        .unwrap()
        .snapshot;
    let invitation = owner
        .invite(ChannelInviteParams {
            space_id: state.id.clone(),
            revision: state.revision,
            name: "Bob".into(),
            role: ChannelRole::Editor,
        })
        .unwrap();
    let mut editor = ChannelAccount::default();
    editor.set_secret_store(Arc::new(ash_secrets::MemorySecretStore::default()));
    let joined = editor
        .connect(ChannelConnectParams::Join {
            server_url: invitation.server_url,
            credential: invitation.credential,
        })
        .unwrap()
        .snapshot;
    let target = ChannelResourceParams {
        space_id: state.id.clone(),
        channel_id: state.channels[0].id.clone(),
    };
    let owner_access = owner
        .resource(target.clone(), ChannelResourceKind::Notes)
        .unwrap();
    let access = editor
        .resource(target.clone(), ChannelResourceKind::Notes)
        .unwrap();
    assert_eq!(access.resource_id, owner_access.resource_id);
    assert_ne!(access.credential, owner_access.credential);
    assert_eq!(
        editor
            .resource(target.clone(), ChannelResourceKind::Notes)
            .unwrap()
            .credential,
        access.credential
    );
    let request = |method: &str, endpoint: &str, token: &str, body: Value, expected| {
        let response = send(
            address,
            method,
            endpoint,
            &[
                ("Origin", ORIGIN),
                ("Authorization", &format!("Bearer {token}")),
                ("Content-Type", "application/json"),
            ],
            &serde_json::to_vec(&body).unwrap(),
        );
        assert_eq!(
            response.status,
            expected,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        serde_json::from_slice::<Value>(&response.body).unwrap_or(Value::Null)
    };
    let open = serde_json::json!({"roomId": access.resource_id, "clientId":"bob", "schemaId":"stanza-document-v1", "document":document("must not initialize shared notes")});
    let opened = request(
        "POST",
        super::OPEN_PATH,
        &access.credential,
        open.clone(),
        200,
    );
    assert_eq!(opened["canEdit"], true);
    assert_eq!(opened["canManageMembers"], false);
    assert!(
        !opened["snapshot"]["document"]
            .as_str()
            .unwrap()
            .contains("must not initialize")
    );
    let update = serde_json::json!({"roomId":access.resource_id,"clientId":"bob","sequence":1,"baseVersion":0,"transaction":transaction(),"document":document("shared notes")});
    assert_eq!(
        request(
            "POST",
            super::SUBMIT_PATH,
            &access.credential,
            update.clone(),
            200
        )["status"],
        "accepted"
    );
    let mut conflict = update.clone();
    conflict["clientId"] = "alice".into();
    assert_eq!(
        request(
            "POST",
            super::SUBMIT_PATH,
            &owner_access.credential,
            conflict,
            200
        )["status"],
        "conflict"
    );
    let read = request(
        "POST",
        super::OPEN_PATH,
        &owner_access.credential,
        open.clone(),
        200,
    );
    assert_eq!(read["snapshot"]["version"], 1);
    assert!(
        read["snapshot"]["document"]
            .as_str()
            .unwrap()
            .contains("shared notes")
    );
    request(
        "POST",
        super::INVITES_PATH,
        &owner_access.credential,
        serde_json::json!({"roomId":access.resource_id,"displayName":"Bypass","role":"owner"}),
        403,
    );
    request(
        "GET",
        "/v1/channels/read",
        &access.credential,
        Value::Null,
        403,
    );
    let state = owner.read().unwrap().unwrap().snapshot;
    let state = owner
        .edit(ChannelEditParams {
            space_id: state.id.clone(),
            revision: state.revision,
            change: ChannelChange::SetRole {
                member_id: joined.member_id.clone(),
                role: ChannelRole::Viewer,
            },
        })
        .unwrap()
        .snapshot;
    assert_eq!(
        request(
            "POST",
            super::OPEN_PATH,
            &access.credential,
            open.clone(),
            200
        )["canEdit"],
        false
    );
    request("POST", super::SUBMIT_PATH, &access.credential, update, 403);
    owner
        .edit(ChannelEditParams {
            space_id: state.id,
            revision: state.revision,
            change: ChannelChange::RemoveMember {
                member_id: joined.member_id,
            },
        })
        .unwrap();
    request(
        "POST",
        super::OPEN_PATH,
        &access.credential,
        open.clone(),
        401,
    );
    shutdown.store(true, Ordering::Release);
    worker.join().unwrap();
    let rooms = SqliteDocumentCollaborationRooms::open_at(path).unwrap();
    let principal = rooms
        .principal_for_access_token(&owner_access.resource_id, &owner_access.credential)
        .unwrap()
        .unwrap();
    let persisted = rooms
        .open_as(&principal, serde_json::from_value(open).unwrap())
        .unwrap();
    assert_eq!(persisted.snapshot.version, 1);
    assert!(persisted.snapshot.document.contains("shared notes"));
}

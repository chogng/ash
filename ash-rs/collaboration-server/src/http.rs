mod wire;

use crate::CollaborationServerError;
use crate::CollaborationServerOptions;
use ash_collaboration::DocumentCollaborationAuditEvent;
use ash_collaboration::DocumentCollaborationMember;
use ash_collaboration::DocumentCollaborationOpenParams;
use ash_collaboration::DocumentCollaborationPrincipal;
use ash_collaboration::DocumentCollaborationReplay;
use ash_collaboration::DocumentCollaborationRoomRole;
use ash_collaboration::DocumentCollaborationSnapshot;
use ash_collaboration::DocumentCollaborationSubmitParams;
use ash_collaboration::DocumentCollaborationSubmitResult;
use ash_collaboration::DocumentCollaborationUpdate;
use ash_collaboration::SqliteDocumentCollaborationRooms;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use std::io::ErrorKind;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use wire::HttpReadError;
use wire::HttpRequest;
use wire::authorized;
use wire::bearer_token;
use wire::read_request;
use wire::write_empty_response;
use wire::write_json_response;

const API_ROOT: &str = "/v1/document-collaboration";
const OPEN_PATH: &str = "/v1/document-collaboration/rooms/open";
const SUBMIT_PATH: &str = "/v1/document-collaboration/rooms/submit";
const INVITES_PATH: &str = "/v1/document-collaboration/rooms/invites";
const REVOKE_MEMBER_PATH: &str = "/v1/document-collaboration/rooms/members/revoke";
const ROTATE_MEMBER_TOKEN_PATH: &str = "/v1/document-collaboration/rooms/members/rotate-token";
const PRESENCE_PATH: &str = "/v1/document-collaboration/rooms/presence";
const POLL_TIMEOUT: Duration = Duration::from_secs(25);
const EXTERNAL_HOST_RECHECK: Duration = Duration::from_millis(250);

pub(crate) fn serve(options: CollaborationServerOptions) -> Result<(), CollaborationServerError> {
    let listener =
        TcpListener::bind(options.listen_address()).map_err(CollaborationServerError::http)?;
    let rooms = SqliteDocumentCollaborationRooms::open_at(options.database_path())
        .map_err(CollaborationServerError::storage)?;
    let runtime = Arc::new(HttpRuntime::new(rooms, options));
    serve_listener(listener, runtime, Arc::new(AtomicBool::new(false)))
}

struct HttpRuntime {
    rooms: SqliteDocumentCollaborationRooms,
    options: CollaborationServerOptions,
    active_connections: AtomicUsize,
    updates: UpdateSignal,
}

impl HttpRuntime {
    fn new(rooms: SqliteDocumentCollaborationRooms, options: CollaborationServerOptions) -> Self {
        Self {
            rooms,
            options,
            active_connections: AtomicUsize::new(0),
            updates: UpdateSignal::default(),
        }
    }
}

#[derive(Default)]
struct UpdateSignal {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl UpdateSignal {
    fn current(&self) -> u64 {
        self.generation
            .lock()
            .map(|generation| *generation)
            .unwrap_or_default()
    }

    fn notify(&self) {
        if let Ok(mut generation) = self.generation.lock() {
            *generation = generation.wrapping_add(1);
            self.changed.notify_all();
        }
    }

    fn wait_for_change(&self, generation: u64, timeout: Duration) {
        let Ok(guard) = self.generation.lock() else {
            return;
        };
        if *guard == generation {
            let _ = self.changed.wait_timeout(guard, timeout);
        }
    }
}

fn serve_listener(
    listener: TcpListener,
    runtime: Arc<HttpRuntime>,
    shutdown: Arc<AtomicBool>,
) -> Result<(), CollaborationServerError> {
    listener
        .set_nonblocking(true)
        .map_err(CollaborationServerError::http)?;
    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let active = runtime.active_connections.fetch_add(1, Ordering::AcqRel) + 1;
                if active > runtime.options.maximum_connections() {
                    runtime.active_connections.fetch_sub(1, Ordering::AcqRel);
                    let mut stream = stream;
                    let _ = write_empty_response(&mut stream, 503, "Service Unavailable", &[]);
                    continue;
                }
                let connection_runtime = runtime.clone();
                thread::spawn(move || {
                    let _guard = ConnectionGuard(&connection_runtime.active_connections);
                    let _ = handle_connection(stream, &connection_runtime);
                });
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(CollaborationServerError::http(error)),
        }
    }
    Ok(())
}

struct ConnectionGuard<'a>(&'a AtomicUsize);

impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn handle_connection(
    mut stream: TcpStream,
    runtime: &HttpRuntime,
) -> Result<(), CollaborationServerError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(CollaborationServerError::http)?;
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(HttpReadError::Status(status, reason)) => {
            return write_empty_response(&mut stream, status, reason, &[])
                .map_err(CollaborationServerError::http);
        }
        Err(HttpReadError::Io(error)) => return Err(CollaborationServerError::http(error)),
    };
    let (path, _) = split_target(&request.target);
    if !path.starts_with(API_ROOT) {
        return write_empty_response(&mut stream, 404, "Not Found", &[])
            .map_err(CollaborationServerError::http);
    }
    if !origin_allowed(&request, runtime) {
        return write_empty_response(&mut stream, 403, "Forbidden", &[])
            .map_err(CollaborationServerError::http);
    }
    if request.method == "OPTIONS" {
        return write_empty_response(
            &mut stream,
            204,
            "No Content",
            &cors_preflight_headers(&request),
        )
        .map_err(CollaborationServerError::http);
    }
    if bearer_token(&request).is_none() {
        let mut headers = cors_headers(&request);
        headers.push(("WWW-Authenticate", "Bearer"));
        return write_empty_response(&mut stream, 401, "Unauthorized", &headers)
            .map_err(CollaborationServerError::http);
    }
    match (request.method.as_str(), path) {
        ("POST", OPEN_PATH) => handle_open(&mut stream, runtime, &request),
        ("POST", SUBMIT_PATH) => handle_submit(&mut stream, runtime, &request),
        ("POST", INVITES_PATH) => handle_create_invite(&mut stream, runtime, &request),
        ("POST", REVOKE_MEMBER_PATH) => handle_revoke_member(&mut stream, runtime, &request),
        ("POST", ROTATE_MEMBER_TOKEN_PATH) => {
            handle_rotate_member_token(&mut stream, runtime, &request)
        }
        ("POST", PRESENCE_PATH) => handle_publish_presence(&mut stream, runtime, &request),
        ("GET", path)
            if path.starts_with(&format!("{API_ROOT}/rooms/")) && path.ends_with("/audit") =>
        {
            handle_audit(&mut stream, runtime, &request)
        }
        ("GET", path)
            if path.starts_with(&format!("{API_ROOT}/rooms/")) && path.ends_with("/members") =>
        {
            handle_members(&mut stream, runtime, &request)
        }
        ("GET", path)
            if path.starts_with(&format!("{API_ROOT}/rooms/")) && path.ends_with("/presence") =>
        {
            handle_presence(&mut stream, runtime, &request)
        }
        ("GET", _) => handle_updates(&mut stream, runtime, &request),
        _ => {
            let mut headers = cors_headers(&request);
            headers.push(("Allow", "GET, POST, OPTIONS"));
            write_empty_response(&mut stream, 405, "Method Not Allowed", &headers)
                .map_err(CollaborationServerError::http)
        }
    }
}

fn handle_open(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let Some(params) = decode_json::<DocumentCollaborationOpenParams>(request) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "Expected a valid collaboration room request",
        );
    };
    let principal = match authenticate_open_principal(runtime, request, params.room_id.as_deref()) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.open_as(&principal, params) {
        Ok(result) => match runtime
            .rooms
            .room_role_as(&principal, &result.snapshot.room_id)
        {
            Ok(role) => write_json(
                stream,
                runtime,
                request,
                200,
                "OK",
                &RemoteOpenResult::from((result, principal, role)),
            ),
            Err(error) => write_domain_error(stream, runtime, request, error),
        },
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteOpenResult {
    client_id: String,
    principal_id: String,
    schema_id: String,
    snapshot: DocumentCollaborationSnapshot,
    can_edit: bool,
    can_manage_members: bool,
}

impl
    From<(
        ash_collaboration::DocumentCollaborationOpenResult,
        DocumentCollaborationPrincipal,
        DocumentCollaborationRoomRole,
    )> for RemoteOpenResult
{
    fn from(
        value: (
            ash_collaboration::DocumentCollaborationOpenResult,
            DocumentCollaborationPrincipal,
            DocumentCollaborationRoomRole,
        ),
    ) -> Self {
        let (result, principal, role) = value;
        Self {
            client_id: result.client_id,
            principal_id: principal.id,
            schema_id: result.schema_id,
            snapshot: result.snapshot,
            can_edit: role.can_submit(),
            can_manage_members: role.can_manage_members(),
        }
    }
}

fn handle_submit(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let Some(params) = decode_json::<DocumentCollaborationSubmitParams>(request) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "Expected a valid collaboration update",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, &params.room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.submit_as(&principal, params) {
        Ok(result) => {
            if matches!(result, DocumentCollaborationSubmitResult::Accepted { .. }) {
                runtime.updates.notify();
            }
            write_json(stream, runtime, request, 200, "OK", &result)
        }
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteParams {
    room_id: String,
    display_name: String,
    role: DocumentCollaborationRoomRole,
}

fn handle_create_invite(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let Some(params) = decode_json::<CreateInviteParams>(request) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "Expected a valid collaboration invitation request",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, &params.room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.create_invite(
        &params.room_id,
        &principal,
        &params.display_name,
        params.role,
    ) {
        Ok(invite) => write_json(stream, runtime, request, 201, "Created", &invite),
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeMemberParams {
    room_id: String,
    principal_id: String,
}

fn handle_revoke_member(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let Some(params) = decode_json::<RevokeMemberParams>(request) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "Expected a valid collaboration member revocation request",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, &params.room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime
        .rooms
        .revoke_member(&params.room_id, &principal, &params.principal_id)
    {
        Ok(()) => {
            runtime.updates.notify();
            write_empty_response(stream, 204, "No Content", &cors_headers(request))
                .map_err(CollaborationServerError::http)
        }
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

fn handle_rotate_member_token(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let Some(params) = decode_json::<RevokeMemberParams>(request) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "Expected a valid collaboration credential rotation request",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, &params.room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.rotate_member_access_token(
        &params.room_id,
        &principal,
        &params.principal_id,
    ) {
        Ok(invite) => write_json(stream, runtime, request, 200, "OK", &invite),
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

fn handle_audit(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let (path, _) = split_target(&request.target);
    let Some(room_id) = room_id_for_path(path, "/audit") else {
        return write_empty_response(stream, 404, "Not Found", &cors_headers(request))
            .map_err(CollaborationServerError::http);
    };
    let principal = match authenticate_room_principal(runtime, request, room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.audit_events(room_id, &principal) {
        Ok(events) => write_json(stream, runtime, request, 200, "OK", &AuditEvents { events }),
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomMembers {
    members: Vec<DocumentCollaborationMember>,
}

fn handle_members(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let (path, _) = split_target(&request.target);
    let Some(room_id) = room_id_for_path(path, "/members") else {
        return write_empty_response(stream, 404, "Not Found", &cors_headers(request))
            .map_err(CollaborationServerError::http);
    };
    let principal = match authenticate_room_principal(runtime, request, room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.list_members(room_id, &principal) {
        Ok(members) => write_json(
            stream,
            runtime,
            request,
            200,
            "OK",
            &RoomMembers { members },
        ),
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishPresenceParams {
    room_id: String,
    client_id: String,
    #[serde(default)]
    selection: Option<String>,
}

fn handle_publish_presence(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let Some(params) = decode_json::<PublishPresenceParams>(request) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "Expected a valid collaboration presence update",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, &params.room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    match runtime.rooms.update_presence_as(
        &principal,
        &params.room_id,
        &params.client_id,
        params.selection.as_deref(),
    ) {
        Ok(_) => {
            runtime.updates.notify();
            write_empty_response(stream, 204, "No Content", &cors_headers(request))
                .map_err(CollaborationServerError::http)
        }
        Err(error) => write_domain_error(stream, runtime, request, error),
    }
}

fn handle_presence(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let (path, query) = split_target(&request.target);
    let Some(room_id) = room_id_for_path(path, "/presence") else {
        return write_empty_response(stream, 404, "Not Found", &cors_headers(request))
            .map_err(CollaborationServerError::http);
    };
    let Some(after_generation) = query.and_then(after_generation) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "afterGeneration must be a non-negative safe integer",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    let deadline = Instant::now() + POLL_TIMEOUT;
    let replay = loop {
        let replay = match runtime
            .rooms
            .replay_presence_as(&principal, room_id, after_generation)
        {
            Ok(replay) => replay,
            Err(error) => return write_domain_error(stream, runtime, request, error),
        };
        if replay.generation != after_generation || Instant::now() >= deadline {
            break replay;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        runtime.updates.wait_for_change(
            runtime.updates.current(),
            remaining.min(EXTERNAL_HOST_RECHECK),
        );
    };
    write_json(stream, runtime, request, 200, "OK", &replay)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEvents {
    events: Vec<DocumentCollaborationAuditEvent>,
}

fn handle_updates(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
) -> Result<(), CollaborationServerError> {
    let (path, query) = split_target(&request.target);
    let Some(room_id) = path
        .strip_prefix(&format!("{API_ROOT}/rooms/"))
        .and_then(|value| value.strip_suffix("/updates"))
    else {
        return write_empty_response(stream, 404, "Not Found", &cors_headers(request))
            .map_err(CollaborationServerError::http);
    };
    let Some(after_version) = query.and_then(after_version) else {
        return write_error(
            stream,
            runtime,
            request,
            400,
            "Bad Request",
            "afterVersion must be a non-negative safe integer",
        );
    };
    let principal = match authenticate_room_principal(runtime, request, room_id) {
        Ok(principal) => principal,
        Err(error) => return write_authentication_error(stream, runtime, request, error),
    };
    let deadline = Instant::now() + POLL_TIMEOUT;
    let replay = loop {
        let replay = match runtime.rooms.replay_as(&principal, room_id, after_version) {
            Ok(replay) => replay,
            Err(error) => return write_domain_error(stream, runtime, request, error),
        };
        if !matches!(replay, DocumentCollaborationReplay::Updates(ref updates) if updates.is_empty())
            || Instant::now() >= deadline
        {
            break replay;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        runtime.updates.wait_for_change(
            runtime.updates.current(),
            remaining.min(EXTERNAL_HOST_RECHECK),
        );
    };
    write_json(
        stream,
        runtime,
        request,
        200,
        "OK",
        &RemoteReplay::from(replay),
    )
}

enum AuthenticationError {
    Unauthorized,
    Domain(String),
}

fn authenticate_open_principal(
    runtime: &HttpRuntime,
    request: &HttpRequest,
    room_id: Option<&str>,
) -> Result<DocumentCollaborationPrincipal, AuthenticationError> {
    match room_id {
        Some(room_id) => authenticate_room_principal(runtime, request, room_id),
        None if authorized(request, runtime.options.bearer_token()) => Ok(bootstrap_principal()),
        None => Err(AuthenticationError::Unauthorized),
    }
}

fn authenticate_room_principal(
    runtime: &HttpRuntime,
    request: &HttpRequest,
    room_id: &str,
) -> Result<DocumentCollaborationPrincipal, AuthenticationError> {
    if authorized(request, runtime.options.bearer_token()) {
        let principal = bootstrap_principal();
        runtime
            .rooms
            .initialize_owner_if_unowned(room_id, &principal)
            .map_err(AuthenticationError::Domain)?;
        return Ok(principal);
    }
    let Some(access_token) = bearer_token(request) else {
        return Err(AuthenticationError::Unauthorized);
    };
    runtime
        .rooms
        .principal_for_access_token(room_id, access_token)
        .map_err(AuthenticationError::Domain)?
        .ok_or(AuthenticationError::Unauthorized)
}

fn bootstrap_principal() -> DocumentCollaborationPrincipal {
    DocumentCollaborationPrincipal {
        id: "server-admin".into(),
        display_name: "Server administrator".into(),
    }
}

fn write_authentication_error(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
    error: AuthenticationError,
) -> Result<(), CollaborationServerError> {
    match error {
        AuthenticationError::Unauthorized => {
            let mut headers = cors_headers(request);
            headers.push(("WWW-Authenticate", "Bearer"));
            write_empty_response(stream, 401, "Unauthorized", &headers)
                .map_err(CollaborationServerError::http)
        }
        AuthenticationError::Domain(error) => write_domain_error(stream, runtime, request, error),
    }
}

fn room_id_for_path<'a>(path: &'a str, suffix: &str) -> Option<&'a str> {
    path.strip_prefix(&format!("{API_ROOT}/rooms/"))?
        .strip_suffix(suffix)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum RemoteReplay {
    Updates {
        updates: Vec<DocumentCollaborationUpdate>,
    },
    Resync {
        snapshot: DocumentCollaborationSnapshot,
    },
}

impl From<DocumentCollaborationReplay> for RemoteReplay {
    fn from(value: DocumentCollaborationReplay) -> Self {
        match value {
            DocumentCollaborationReplay::Updates(updates) => Self::Updates { updates },
            DocumentCollaborationReplay::Resync(snapshot) => Self::Resync { snapshot },
        }
    }
}

fn decode_json<T: serde::de::DeserializeOwned>(request: &HttpRequest) -> Option<T> {
    if !request
        .header("content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return None;
    }
    serde_json::from_slice(&request.body).ok()
}

fn split_target(target: &str) -> (&str, Option<&str>) {
    target
        .split_once('?')
        .map_or((target, None), |(path, query)| (path, Some(query)))
}

fn after_version(query: &str) -> Option<u64> {
    query_safe_integer(query, "afterVersion")
}

fn after_generation(query: &str) -> Option<u64> {
    query_safe_integer(query, "afterGeneration")
}

fn query_safe_integer(query: &str, expected_name: &str) -> Option<u64> {
    let mut value = None;
    for pair in query.split('&') {
        let (name, candidate) = pair.split_once('=')?;
        if name != expected_name || value.is_some() {
            return None;
        }
        let parsed = candidate.parse::<u64>().ok()?;
        if parsed > 9_007_199_254_740_991 {
            return None;
        }
        value = Some(parsed);
    }
    value
}

fn origin_allowed(request: &HttpRequest, runtime: &HttpRuntime) -> bool {
    request
        .header("origin")
        .is_none_or(|origin| runtime.options.allowed_origins().contains(origin))
}

fn cors_headers(request: &HttpRequest) -> Vec<(&str, &str)> {
    request
        .header("origin")
        .map(|origin| vec![("Access-Control-Allow-Origin", origin)])
        .unwrap_or_default()
}

fn cors_preflight_headers(request: &HttpRequest) -> Vec<(&str, &str)> {
    let mut headers = cors_headers(request);
    if !headers.is_empty() {
        headers.push((
            "Access-Control-Allow-Headers",
            "authorization, content-type",
        ));
        headers.push(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"));
        headers.push(("Access-Control-Max-Age", "600"));
    }
    headers
}

fn write_json<T: Serialize>(
    stream: &mut TcpStream,
    _runtime: &HttpRuntime,
    request: &HttpRequest,
    status: u16,
    reason: &str,
    value: &T,
) -> Result<(), CollaborationServerError> {
    let body = serde_json::to_vec(value).map_err(|error| {
        CollaborationServerError::storage(format!(
            "Could not serialize collaboration response: {error}"
        ))
    })?;
    write_json_response(stream, status, reason, &body, &cors_headers(request))
        .map_err(CollaborationServerError::http)
}

fn write_error(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
    status: u16,
    reason: &str,
    message: &str,
) -> Result<(), CollaborationServerError> {
    write_json(
        stream,
        runtime,
        request,
        status,
        reason,
        &json!({ "error": message }),
    )
}

fn write_domain_error(
    stream: &mut TcpStream,
    runtime: &HttpRuntime,
    request: &HttpRequest,
    error: String,
) -> Result<(), CollaborationServerError> {
    if error.starts_with("Collaboration database error")
        || error == "Collaboration database lock poisoned"
    {
        return write_error(
            stream,
            runtime,
            request,
            500,
            "Internal Server Error",
            "The collaboration server could not process the request",
        );
    }
    let (status, reason) = if error.contains("does not exist") {
        (404, "Not Found")
    } else if error.contains("not a room member")
        || error.contains("read-only")
        || error.starts_with("Only collaboration room owners")
        || error.contains("cannot revoke themselves")
    {
        (403, "Forbidden")
    } else {
        (422, "Unprocessable Content")
    };
    write_error(stream, runtime, request, status, reason, &error)
}

#[cfg(test)]
#[path = "http/tests.rs"]
mod tests;

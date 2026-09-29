use super::registry::ProfileAppServerRegistry;
use crate::AppServer;
use crate::ConnectionState;
use ash_app_server_protocol::protocol::error::AppServerError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::initialize::{
    InitializeResult, REQUIRED_SESSION_CAPABILITIES, ensure_protocol_compatible,
};
use ash_app_server_protocol::rpc::JsonRpcFailure;
use ash_app_server_protocol::rpc::JsonRpcId;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_remote::RemoteProfile;
use ash_remote::remote_app_server_command;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;

struct Target {
    server: Arc<AppServer>,
    connection: ConnectionState,
    route_id: usize,
}

type RemoteKey = (String, String);
type RemoteSessionIndex = Arc<Mutex<BTreeMap<String, RemoteKey>>>;

struct RemoteTarget {
    child: Child,
    writer: JsonlWriter<ChildStdin>,
    route_id: usize,
    alive: Arc<AtomicBool>,
}

struct PendingCatalog {
    response: Value,
    remaining: usize,
}

type Catalogs = Arc<Mutex<BTreeMap<usize, PendingCatalog>>>;
type RemotePending = Arc<Mutex<BTreeMap<usize, Vec<Value>>>>;

/// One renderer connection can select local directory runtimes by the Session's durable root.
pub(super) fn serve<R: BufRead, W: Write + Send>(
    registry: Arc<ProfileAppServerRegistry>,
    profile_server: Arc<AppServer>,
    reader: R,
    writer: W,
) -> io::Result<()> {
    let mut reader = JsonlReader::new(reader, DEFAULT_MAX_MESSAGE_BYTES);
    let (outbound, incoming) = mpsc::channel::<String>();
    thread::scope(|scope| {
        let writer_handle = scope.spawn(move || {
            let mut writer = JsonlWriter::new(writer, DEFAULT_MAX_MESSAGE_BYTES);
            while let Ok(message) = incoming.recv() {
                writer.write_message(&message)?;
            }
            Ok::<(), io::Error>(())
        });

        let profile_connection = profile_server.product_host_connection();
        let profile_notifications = profile_server.connection_notifications(&profile_connection);
        let profile_outbound = outbound.clone();
        scope.spawn(move || {
            while profile_notifications.wait() {
                for notification in profile_notifications.drain() {
                    if profile_outbound
                        .send(tag_host_request(notification, 0))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        });
        let mut profile = Target {
            server: profile_server,
            connection: profile_connection,
            route_id: 0,
        };
        let mut local = BTreeMap::<PathBuf, Target>::new();
        let mut remote = BTreeMap::<RemoteKey, RemoteTarget>::new();
        let remote_sessions: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::new()));
        let catalogs: Catalogs = Arc::new(Mutex::new(BTreeMap::new()));
        let remote_pending: RemotePending = Arc::new(Mutex::new(BTreeMap::new()));
        let mut next_route_id = 1;
        let mut next_catalog_id = 1;
        let mut next_ignored_id = 1;
        let mut catalog_subscribed = false;
        let mut initialize_request: Option<String> = None;
        let result = (|| {
            while let Some(raw) = reader.read_message()? {
                let request: Value = match serde_json::from_str(&raw) {
                    Ok(request) => request,
                    Err(_) => {
                        outbound
                            .send(profile.server.handle_json(&mut profile.connection, &raw))
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                        continue;
                    }
                };
                let method = request.get("method").and_then(Value::as_str);
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                if method.is_none() {
                    let (route_id, response) = untag_host_response(&request)?;
                    if let Some(target) = remote
                        .values_mut()
                        .find(|target| target.route_id == route_id)
                    {
                        target.writer.write_message(&response.to_string())?;
                    } else {
                        let target = if route_id == 0 {
                            &profile
                        } else {
                            local
                                .values()
                                .find(|target| target.route_id == route_id)
                                .ok_or_else(|| {
                                    io::Error::new(
                                        io::ErrorKind::InvalidData,
                                        "Unknown host response target",
                                    )
                                })?
                        };
                        target
                            .server
                            .handle_product_host_response(&target.connection, response)?;
                    }
                    continue;
                }
                if method == Some("initialize") {
                    let response = profile.server.handle_json(&mut profile.connection, &raw);
                    if serde_json::from_str::<Value>(&response)
                        .ok()
                        .is_some_and(|message| message.get("result").is_some())
                    {
                        initialize_request = Some(raw);
                    }
                    outbound
                        .send(response)
                        .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                    continue;
                }
                if matches!(method, Some("session/list" | "session/catalog/subscribe")) {
                    catalog_subscribed |= method == Some("session/catalog/subscribe");
                    let base = profile.server.handle_json(&mut profile.connection, &raw);
                    let mut base: Value = serde_json::from_str(&base)
                        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                    let profiles = match registry.remote_profiles() {
                        Ok(profiles) => profiles,
                        Err(error) => {
                            outbound
                                .send(routing_error(id, &error))
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                            continue;
                        }
                    };
                    let mut by_host = BTreeMap::new();
                    for remote_profile in profiles {
                        by_host
                            .entry(remote_profile.target().host().as_str().to_owned())
                            .or_insert(remote_profile);
                    }
                    let profiles = by_host.into_values().collect::<Vec<_>>();
                    if profiles.is_empty() || base.get("error").is_some() {
                        outbound
                            .send(base.to_string())
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                        continue;
                    }
                    let batch_id = next_catalog_id;
                    next_catalog_id += 1;
                    catalogs
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(
                            batch_id,
                            PendingCatalog {
                                response: std::mem::take(&mut base),
                                remaining: profiles.len(),
                            },
                        );
                    let mut catalog_error = None;
                    for remote_profile in profiles {
                        let key = remote_key(&remote_profile);
                        if remote
                            .get(&key)
                            .is_some_and(|target| !target.alive.load(Ordering::Acquire))
                        {
                            if let Some(mut target) = remote.remove(&key) {
                                let _ = target.child.wait();
                            }
                        }
                        if !remote.contains_key(&key) {
                            let opened = open_remote(
                                &remote_profile,
                                initialize_request.as_deref().ok_or_else(|| {
                                    io::Error::new(
                                        io::ErrorKind::InvalidData,
                                        "Catalog request before initialize",
                                    )
                                })?,
                                next_route_id,
                            );
                            let (target, stdout) = match opened {
                                Ok(opened) => opened,
                                Err(error) => {
                                    catalog_error = Some(error.to_string());
                                    break;
                                }
                            };
                            spawn_remote_reader(
                                scope,
                                stdout,
                                key.clone(),
                                next_route_id,
                                Arc::clone(&target.alive),
                                outbound.clone(),
                                Arc::clone(&remote_sessions),
                                Arc::clone(&catalogs),
                                Arc::clone(&remote_pending),
                            );
                            next_route_id += 1;
                            remote.insert(key.clone(), target);
                        }
                        let target = remote.get_mut(&key).expect("inserted SSH target");
                        let mut forwarded = request.clone();
                        forwarded["id"] = serde_json::json!(catalog_request_id(batch_id));
                        track_remote_request(&remote_pending, target.route_id, &forwarded);
                        if let Err(error) = target.writer.write_message(&forwarded.to_string()) {
                            catalog_error = Some(error.to_string());
                            break;
                        }
                    }
                    if let Some(error) = catalog_error {
                        catalogs
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .remove(&batch_id);
                        outbound
                            .send(routing_error(id, &error))
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                    }
                    continue;
                }
                if method == Some("session/catalog/unsubscribe") {
                    catalog_subscribed = false;
                    for target in remote.values_mut() {
                        let mut forwarded = request.clone();
                        forwarded["id"] = serde_json::json!(ignored_request_id(next_ignored_id));
                        next_ignored_id += 1;
                        target.writer.write_message(&forwarded.to_string())?;
                    }
                    outbound
                        .send(profile.server.handle_json(&mut profile.connection, &raw))
                        .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                    continue;
                }
                let execution_target =
                    match selected_execution_target(&registry, &remote_sessions, &request) {
                        Ok(target) => target,
                        Err(error) => {
                            outbound
                                .send(routing_error(id, &error))
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                            continue;
                        }
                    };
                let target = match execution_target {
                    Some(SessionExecutionTarget::Local { root }) => {
                        let root = dunce::canonicalize(root)?;
                        if !local.contains_key(&root) {
                            let server = registry
                                .server_for_local_session(&root)
                                .map_err(io::Error::other)?;
                            let mut connection = server.product_host_connection();
                            let initialize = initialize_request.as_ref().ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "Session request before initialize",
                                )
                            })?;
                            let response = server.handle_json(&mut connection, initialize);
                            let initialized = serde_json::from_str::<Value>(&response)
                                .ok()
                                .is_some_and(|message| message.get("result").is_some());
                            if !initialized {
                                return Err(io::Error::new(io::ErrorKind::InvalidData, response));
                            }
                            let notifications = server.connection_notifications(&connection);
                            let target_outbound = outbound.clone();
                            let route_id = next_route_id;
                            next_route_id += 1;
                            scope.spawn(move || {
                                while notifications.wait() {
                                    for notification in notifications.drain() {
                                        if target_outbound
                                            .send(tag_host_request(notification, route_id))
                                            .is_err()
                                        {
                                            return;
                                        }
                                    }
                                }
                            });
                            local.insert(
                                root.clone(),
                                Target {
                                    server,
                                    connection,
                                    route_id,
                                },
                            );
                        }
                        local.get_mut(&root).expect("inserted local Session target")
                    }
                    Some(SessionExecutionTarget::Ssh { host, root }) => {
                        let key = (host, root);
                        if remote
                            .get(&key)
                            .is_some_and(|target| !target.alive.load(Ordering::Acquire))
                        {
                            if let Some(mut target) = remote.remove(&key) {
                                let _ = target.child.wait();
                            }
                        }
                        if !remote.contains_key(&key) {
                            let remote_profile = match registry.remote_profile(&key.0, &key.1) {
                                Ok(profile) => profile,
                                Err(error) => {
                                    outbound
                                        .send(routing_error(id, &error))
                                        .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                                    continue;
                                }
                            };
                            let opened = open_remote(
                                &remote_profile,
                                initialize_request.as_deref().ok_or_else(|| {
                                    io::Error::new(
                                        io::ErrorKind::InvalidData,
                                        "Session request before initialize",
                                    )
                                })?,
                                next_route_id,
                            );
                            let (mut target, stdout) = match opened {
                                Ok(opened) => opened,
                                Err(error) => {
                                    outbound
                                        .send(routing_error(id, &error.to_string()))
                                        .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                                    continue;
                                }
                            };
                            spawn_remote_reader(
                                scope,
                                stdout,
                                key.clone(),
                                next_route_id,
                                Arc::clone(&target.alive),
                                outbound.clone(),
                                Arc::clone(&remote_sessions),
                                Arc::clone(&catalogs),
                                Arc::clone(&remote_pending),
                            );
                            next_route_id += 1;
                            if catalog_subscribed {
                                let subscription = serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": ignored_request_id(next_ignored_id),
                                    "method": "session/catalog/subscribe",
                                    "params": {}
                                });
                                next_ignored_id += 1;
                                target.writer.write_message(&subscription.to_string())?;
                            }
                            remote.insert(key.clone(), target);
                        }
                        let target = remote.get_mut(&key).expect("inserted SSH target");
                        let mut forwarded = request.clone();
                        if method == Some("session/create") {
                            forwarded["params"]["executionTarget"] =
                                serde_json::json!({"type":"local","root":key.1.clone()});
                        }
                        track_remote_request(&remote_pending, target.route_id, &forwarded);
                        if let Err(error) = target.writer.write_message(&forwarded.to_string()) {
                            outbound
                                .send(routing_error(id, &error.to_string()))
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                        }
                        continue;
                    }
                    None => &mut profile,
                };
                outbound
                    .send(target.server.handle_json(&mut target.connection, &raw))
                    .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
            }
            Ok::<(), io::Error>(())
        })();
        profile.server.close_connection(profile.connection);
        for target in local.into_values() {
            target.server.close_connection(target.connection);
        }
        for (_, mut target) in remote {
            let _ = target.child.kill();
            let _ = target.child.wait();
        }
        drop(outbound);
        result?;
        writer_handle
            .join()
            .map_err(|_| io::Error::other("Profile writer panicked"))?
    })
}

fn remote_key(profile: &RemoteProfile) -> RemoteKey {
    (
        profile.target().host().as_str().to_owned(),
        profile.target().dir().as_str().to_owned(),
    )
}

fn open_remote(
    profile: &RemoteProfile,
    initialize: &str,
    route_id: usize,
) -> io::Result<(RemoteTarget, BufReader<ChildStdout>)> {
    let mut child = Command::new(std::env::var_os("ASH_SSH_PATH").unwrap_or_else(|| "ssh".into()))
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            profile.target().host().as_str(),
        ])
        .arg(remote_app_server_command(profile))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let initialized =
        (|| {
            let stdin = child.stdin.take().expect("SSH stdin was piped");
            let stdout = child.stdout.take().expect("SSH stdout was piped");
            let mut writer = JsonlWriter::new(stdin, DEFAULT_MAX_MESSAGE_BYTES);
            writer.write_message(initialize)?;
            let mut stdout = BufReader::new(stdout);
            let mut response = String::new();
            if stdout.read_line(&mut response)? == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "SSH App Server closed during initialize",
                ));
            }
            if response.len() > DEFAULT_MAX_MESSAGE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "SSH initialize response exceeds limit",
                ));
            }
            let response: Value = serde_json::from_str(&response)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            let initialized: InitializeResult =
                serde_json::from_value(response.get("result").cloned().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, response.to_string())
                })?)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            Ok((writer, stdout))
        })();
    match initialized {
        Ok((writer, stdout)) => Ok((
            RemoteTarget {
                child,
                writer,
                route_id,
                alive: Arc::new(AtomicBool::new(true)),
            },
            stdout,
        )),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn spawn_remote_reader<'scope, 'env>(
    scope: &'scope thread::Scope<'scope, 'env>,
    stdout: BufReader<ChildStdout>,
    key: RemoteKey,
    route_id: usize,
    alive: Arc<AtomicBool>,
    outbound: mpsc::Sender<String>,
    sessions: RemoteSessionIndex,
    catalogs: Catalogs,
    pending: RemotePending,
) where
    'env: 'scope,
{
    scope.spawn(move || {
        let mut reader = JsonlReader::new(stdout, DEFAULT_MAX_MESSAGE_BYTES);
        while let Ok(Some(raw)) = reader.read_message() {
            let Ok(mut message) = serde_json::from_str::<Value>(&raw) else {
                break;
            };
            annotate_remote_sessions(&mut message, &key, &sessions);
            if message.get("method").and_then(Value::as_str) == Some("session/changed") {
                if let Some(session_id) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                    sessions
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(session_id.to_owned(), key.clone());
                }
            }
            if message.get("method").is_none() {
                if let Some(id) = message.get("id") {
                    let mut pending = pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    if let Some(ids) = pending.get_mut(&route_id) {
                        ids.retain(|candidate| candidate != id);
                    }
                }
            }
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(batch_id) = catalog_batch_id(id) {
                    complete_catalog(&catalogs, batch_id, message, &outbound);
                    continue;
                }
                if id >= u64::MAX / 2 {
                    continue;
                }
            }
            let output = if message.get("method").is_some() {
                tag_host_request(message.to_string(), route_id)
            } else {
                message.to_string()
            };
            if outbound.send(output).is_err() {
                break;
            }
        }
        alive.store(false, Ordering::Release);
        let outstanding = pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&route_id).unwrap_or_default();
        for id in outstanding {
            if let Some(batch) = id.as_u64().and_then(catalog_batch_id) {
                complete_catalog(
                    &catalogs,
                    batch,
                    serde_json::json!({"error":{"code":-32603,"message":"SSH App Server disconnected"}}),
                    &outbound,
                );
            } else {
                let _ = outbound.send(routing_error(id, "SSH App Server disconnected"));
            }
        }
    });
}

fn catalog_request_id(batch_id: usize) -> u64 {
    u64::MAX - (batch_id as u64) * 2
}

fn ignored_request_id(sequence: usize) -> u64 {
    u64::MAX - ((sequence as u64) * 2 + 1)
}

fn catalog_batch_id(id: u64) -> Option<usize> {
    (id >= u64::MAX / 2 && (u64::MAX - id) % 2 == 0).then(|| ((u64::MAX - id) / 2) as usize)
}

fn track_remote_request(pending: &RemotePending, route_id: usize, request: &Value) {
    if let Some(id) = request.get("id") {
        pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(route_id)
            .or_default()
            .push(id.clone());
    }
}

fn annotate_remote_sessions(value: &mut Value, key: &RemoteKey, sessions: &RemoteSessionIndex) {
    match value {
        Value::Object(object) => {
            if object.contains_key("threads") {
                if let Some(id) = object.get("sessionId").and_then(Value::as_str) {
                    let selected = (
                        key.0.clone(),
                        object
                            .get("executionTarget")
                            .and_then(|target| target.get("root"))
                            .and_then(Value::as_str)
                            .unwrap_or(&key.1)
                            .to_owned(),
                    );
                    sessions
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(id.to_owned(), selected.clone());
                    if let Some(threads) = object.get("threads").and_then(Value::as_array) {
                        let mut index = sessions
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        for thread in threads {
                            if let Some(thread_id) = thread.get("threadId").and_then(Value::as_str)
                            {
                                index.insert(thread_id.to_owned(), selected.clone());
                            }
                        }
                    }
                    object.insert(
                        "executionTarget".into(),
                        serde_json::json!({"type":"ssh","host":selected.0,"root":selected.1}),
                    );
                }
            }
            for child in object.values_mut() {
                annotate_remote_sessions(child, key, sessions);
            }
        }
        Value::Array(array) => {
            for child in array {
                annotate_remote_sessions(child, key, sessions);
            }
        }
        _ => {}
    }
}

fn complete_catalog(
    catalogs: &Catalogs,
    batch_id: usize,
    remote: Value,
    outbound: &mpsc::Sender<String>,
) {
    let mut catalogs = catalogs
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(pending) = catalogs.get_mut(&batch_id) else {
        return;
    };
    if let Some(error) = remote.get("error") {
        pending
            .response
            .as_object_mut()
            .expect("JSON-RPC response is an object")
            .remove("result");
        pending.response["error"] = error.clone();
    } else if pending.response.get("error").is_none() {
        if let (Some(sessions), Some(remote_sessions)) = (
            pending
                .response
                .pointer_mut("/result/sessions")
                .and_then(Value::as_array_mut),
            remote.pointer("/result/sessions").and_then(Value::as_array),
        ) {
            for session in remote_sessions {
                if !sessions
                    .iter()
                    .any(|existing| existing.get("sessionId") == session.get("sessionId"))
                {
                    sessions.push(session.clone());
                }
            }
        }
    }
    pending.remaining -= 1;
    if pending.remaining == 0 {
        let response = catalogs
            .remove(&batch_id)
            .expect("completed catalog exists")
            .response;
        let _ = outbound.send(response.to_string());
    }
}

// Browser host request IDs are scoped to an App Server connection. The renderer sees one
// connection, so the gateway includes the target identity and restores the original ID on reply.
fn tag_host_request(raw: String, route_id: usize) -> String {
    let Ok(mut message) = serde_json::from_str::<Value>(&raw) else {
        return raw;
    };
    if message.get("method").is_some() {
        if let Some(id) = message.get("id").and_then(Value::as_str) {
            let tagged = format!("browser-host:gateway:{route_id}:{id}");
            message["id"] = Value::String(tagged);
            return message.to_string();
        }
    }
    raw
}

fn untag_host_response(message: &Value) -> io::Result<(usize, Value)> {
    let id = message.get("id").and_then(Value::as_str).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "Host response requires an ID")
    })?;
    let rest = id
        .strip_prefix("browser-host:gateway:")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Unknown host response ID"))?;
    let (route_id, original_id) = rest
        .split_once(':')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Invalid host response ID"))?;
    let route_id = route_id
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid host response target"))?;
    let mut response = message.clone();
    response["id"] = Value::String(original_id.to_owned());
    Ok((route_id, response))
}

fn selected_execution_target(
    registry: &ProfileAppServerRegistry,
    remote_sessions: &RemoteSessionIndex,
    request: &Value,
) -> Result<Option<SessionExecutionTarget>, String> {
    let method = request.get("method").and_then(Value::as_str);
    let params = request.get("params");
    if method == Some("session/create") {
        let selected: Option<SessionExecutionTarget> = serde_json::from_value(
            params
                .and_then(|params| params.get("executionTarget"))
                .cloned()
                .ok_or("Session creation requires an execution target")?,
        )
        .map_err(|error| error.to_string())?;
        return Ok(selected);
    }
    if let Some(session_id) = params
        .and_then(|params| params.get("sessionId"))
        .and_then(Value::as_str)
    {
        if let Some((host, root)) = remote_sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
        {
            return Ok(Some(SessionExecutionTarget::Ssh { host, root }));
        }
        let session_id =
            SessionId::new(session_id.to_owned()).map_err(|error| error.to_string())?;
        return registry.execution_target_for_session(&session_id);
    }
    if let Some(thread_id) = params
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str)
    {
        if let Some((host, root)) = remote_sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .cloned()
        {
            return Ok(Some(SessionExecutionTarget::Ssh { host, root }));
        }
        let thread_id = ThreadId::new(thread_id.to_owned()).map_err(|error| error.to_string())?;
        return registry.execution_target_for_thread(&thread_id);
    }
    Ok(None)
}

fn routing_error(id: Value, detail: &str) -> String {
    let id = serde_json::from_value::<JsonRpcId>(id).unwrap_or(JsonRpcId::Null(()));
    let mut error = AppServerError::new(-32602, AppServerErrorName::InvalidParams);
    error.message.push_str(": ");
    error.message.push_str(detail);
    serde_json::to_string(&JsonRpcFailure::new(id, error))
        .expect("Profile routing error is valid JSON-RPC")
}

#[cfg(test)]
#[path = "gateway_tests.rs"]
mod tests;

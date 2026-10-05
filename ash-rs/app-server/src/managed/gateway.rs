use super::registry::ProfileAppServerRegistry;
use crate::AppServer;
use crate::ConnectionState;
use crate::server::message_queue::OutboundSender;
use crate::server::request_dispatch::IncomingRequest;
use crate::server::request_dispatch::RequestDispatcher;
use crate::server::request_dispatch::RequestLane;
use ash_app_server_protocol::protocol::error::AppServerError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::rpc::JsonRpcFailure;
use ash_app_server_protocol::rpc::JsonRpcId;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcVersion;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_remote::RemoteProfile;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::io::BufRead;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

struct Target {
    server: Arc<AppServer>,
    connection: ConnectionState,
}

type RemoteKey = (String, String);
type RemoteSessionIndex = Arc<Mutex<BTreeMap<String, RemoteKey>>>;

mod local;
use local::LocalTarget;

mod remote;
pub(super) use remote::RemoteLaunch;
use remote::RemoteTarget;

const MAX_REMOTE_TARGETS: usize = 32;
const MAX_LOCAL_TARGETS: usize = 32;
const TASK_CONTRACTS: &[ash_app_server_protocol::protocol::initialize::CapabilityRequirement] = &[
    ash_app_server_protocol::protocol::initialize::CapabilityRequirement::exact(
        "sessions",
        ash_app_server_protocol::protocol::initialize::APP_SERVER_CAPABILITY_VERSION,
    ),
    ash_app_server_protocol::protocol::initialize::CapabilityRequirement::exact(
        "threads",
        ash_app_server_protocol::protocol::initialize::APP_SERVER_CAPABILITY_VERSION,
    ),
    ash_app_server_protocol::protocol::initialize::CapabilityRequirement::exact(
        "turns",
        ash_app_server_protocol::protocol::initialize::APP_SERVER_CAPABILITY_VERSION,
    ),
    ash_app_server_protocol::protocol::initialize::CapabilityRequirement::exact("taskDelivery", 1),
];

/// Backend task tools use the same SSH lifecycle as renderer routes. A bounded one-request
/// connection owns its process until completion or cancellation; no renderer needs to stay open.
pub(crate) fn task_request(
    profile: RemoteProfile,
    method: ash_app_server_protocol::protocol::registry::ClientMethod,
    params: Value,
    cancellation: &ash_async_utils::CancellationToken,
) -> Result<Value, String> {
    task_request_with_launch(
        profile,
        method,
        params,
        cancellation,
        RemoteLaunch::from_environment(),
    )
}

fn task_request_with_launch(
    profile: RemoteProfile,
    method: ash_app_server_protocol::protocol::registry::ClientMethod,
    params: Value,
    cancellation: &ash_async_utils::CancellationToken,
    launch: RemoteLaunch,
) -> Result<Value, String> {
    use std::time::Duration;
    use std::time::Instant;
    thread::scope(|scope| {
        let (outbound, incoming) = crate::server::message_queue::outbound_queue(16);
        let initialize = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"task-delivery","version":env!("CARGO_PKG_VERSION")},
                "capabilities":{"notifications":false}}});
        let target = RemoteTarget::start(
            scope,
            profile,
            initialize.to_string().into(),
            0,
            launch,
            Default::default(),
            outbound,
            Arc::new(Mutex::new(BTreeMap::new())),
            Arc::new(Mutex::new(BTreeMap::new())),
            Arc::new(Mutex::new(BTreeMap::new())),
            TASK_CONTRACTS,
        );
        let deadline = Instant::now() + Duration::from_secs(120);
        let receive = |id: u64| -> Result<Value, String> {
            loop {
                cancellation.check().map_err(|e| e.to_string())?;
                if Instant::now() >= deadline {
                    return Err("remote task request timed out; retry its saved delivery ID".into());
                }
                match incoming.recv_timeout(Duration::from_millis(25)) {
                    Ok(message) => {
                        let value: Value =
                            serde_json::from_str(&message.raw).map_err(|e| e.to_string())?;
                        if value.get("id").and_then(Value::as_u64) == Some(id) {
                            if let Some(error) = value.get("error") {
                                return Err(error.to_string());
                            }
                            return value
                                .get("result")
                                .cloned()
                                .ok_or_else(|| "invalid remote task response".into());
                        }
                        if value.get("method").is_some() && value.get("id").is_some() {
                            return Err(
                                "remote task transport cannot own interactive host requests".into(),
                            );
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if !target.is_alive() {
                            return Err(
                                "remote task connection closed; retry its saved delivery ID".into(),
                            );
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("remote task connection closed".into());
                    }
                }
            }
        };
        let result = (|| {
            target.send(serde_json::json!({"jsonrpc":"2.0","id":2,"method":method.as_str(),"params":params}))
                .map_err(|e| e.to_string())?;
            receive(2)
        })();
        target.close();
        // Drop the receiver before joining SSH: producers waiting on a full byte budget wake.
        drop(incoming);
        result
    })
}

struct PendingCatalog {
    response: Value,
    remaining: usize,
}

type Catalogs = Arc<Mutex<BTreeMap<usize, PendingCatalog>>>;
#[derive(Default)]
struct PendingRemoteRequests {
    closed: bool,
    ids: Vec<(Value, RequestLane)>,
}
type RemotePending = Arc<Mutex<BTreeMap<usize, PendingRemoteRequests>>>;

/// One renderer connection can select local directory runtimes by the Session's durable root.
pub(super) fn serve<R: BufRead, W: Write + Send>(
    registry: Arc<ProfileAppServerRegistry>,
    profile_server: Arc<AppServer>,
    reader: R,
    writer: W,
    remote_launch: RemoteLaunch,
) -> io::Result<()> {
    let mut reader = JsonlReader::new(reader, DEFAULT_MAX_MESSAGE_BYTES);
    let (outbound, incoming) = crate::server::message_queue::outbound_queue(256);
    thread::scope(|scope| {
        let requests = RequestDispatcher::start(scope)?;
        let writer_telemetry = profile_server.telemetry.clone();
        let writer_handle = scope.spawn(move || {
            let mut writer = JsonlWriter::new(writer, DEFAULT_MAX_MESSAGE_BYTES);
            while let Ok(message) = incoming.recv() {
                message.write_to(&mut writer, &writer_telemetry)?;
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
                        .send(tag_host_request(notification, 0).into())
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
        };
        let mut local = BTreeMap::<PathBuf, LocalTarget>::new();
        let mut remote = BTreeMap::<RemoteKey, RemoteTarget>::new();
        let remote_sessions: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::new()));
        let catalogs: Catalogs = Arc::new(Mutex::new(BTreeMap::new()));
        let remote_pending: RemotePending = Arc::new(Mutex::new(BTreeMap::new()));
        let mut next_route_id = 1;
        let mut next_catalog_id = 1;
        let mut next_ignored_id = 1;
        let mut catalog_subscribed = false;
        let mut initialize_request: Option<IncomingRequest> = None;
        let result = (|| {
            while let Some(raw) = reader.read_message()? {
                let raw = IncomingRequest::from(raw);
                let request: Value = match serde_json::from_str(&raw) {
                    Ok(request) => request,
                    Err(_) => {
                        outbound
                            .send(
                                (profile.server.handle_json(&mut profile.connection, &raw)).into(),
                            )
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                        continue;
                    }
                };
                let method = request.get("method").and_then(Value::as_str);
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                if method.is_some()
                    && !serde_json::from_value::<JsonRpcRequest<Value>>(request.clone()).is_ok_and(
                        |request| {
                            request.jsonrpc == JsonRpcVersion::V2
                                && request.id.as_u64().is_some_and(|id| id > 0)
                        },
                    )
                {
                    outbound
                        .send(
                            profile
                                .server
                                .handle_json(&mut profile.connection, &raw)
                                .into(),
                        )
                        .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                    continue;
                }
                if method.is_none() {
                    let (route_id, response) = untag_host_response(&request)?;
                    if let Some(target) = remote
                        .values_mut()
                        .find(|target| target.route_id == route_id)
                    {
                        if let Err(error) = target.send(response) {
                            // Host replies cannot be dropped. End their owning route and its
                            // pending requests, keeping this renderer's other routes available.
                            target.fail(&error, &catalogs, &outbound);
                        }
                    } else {
                        if route_id == 0 {
                            profile
                                .server
                                .handle_product_host_response(&profile.connection, response)?;
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
                                .host_response(response)?;
                        }
                    }
                    continue;
                }
                if method == Some("initialize") {
                    let initialized = profile.server.handle_json_with_delivery(
                        &mut profile.connection,
                        &raw,
                        |response| {
                            let initialized = serde_json::from_str::<Value>(&response)
                                .ok()
                                .is_some_and(|message| message.get("result").is_some());
                            outbound
                                .send(response.into())
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                            Ok::<_, io::Error>(initialized)
                        },
                    )?;
                    if initialized {
                        initialize_request = Some(raw);
                    }
                    continue;
                }
                if matches!(method, Some("session/list" | "session/catalog/subscribe")) {
                    catalog_subscribed |= method == Some("session/catalog/subscribe");
                    let profiles = match registry.remote_profiles() {
                        Ok(profiles) => profiles,
                        Err(error) => {
                            outbound
                                .send(routing_error(id, &error).into())
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
                    if profiles.is_empty() {
                        let output = outbound.clone();
                        requests.dispatch(
                            Arc::clone(&profile.server),
                            &profile.connection,
                            raw,
                            move |response| {
                                output
                                    .send(response.into())
                                    .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
                            },
                        )?;
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
                                response: serde_json::json!({"jsonrpc":"2.0", "id": id, "result":{"sessions":[]}}),
                                remaining: profiles.len() + 1,
                            },
                        );
                    let local_catalogs = Arc::clone(&catalogs);
                    let local_output = outbound.clone();
                    requests.dispatch(
                        Arc::clone(&profile.server),
                        &profile.connection,
                        raw.clone(),
                        move |response| {
                            let response = serde_json::from_str(&response).map_err(|error| {
                                io::Error::new(io::ErrorKind::InvalidData, error)
                            })?;
                            complete_catalog(&local_catalogs, batch_id, response, &local_output);
                            Ok(())
                        },
                    )?;
                    for remote_profile in profiles {
                        let key = remote_key(&remote_profile);
                        if remote.get(&key).is_some_and(|target| !target.is_alive()) {
                            remote.remove(&key);
                        }
                        let mut forwarded = request.clone();
                        forwarded["id"] = serde_json::json!(catalog_request_id(batch_id));
                        if !remote.contains_key(&key) {
                            if remote.len() == MAX_REMOTE_TARGETS {
                                reject_remote_request(
                                    &forwarded,
                                    &io::Error::new(
                                        io::ErrorKind::WouldBlock,
                                        "SSH target capacity exhausted",
                                    ),
                                    &catalogs,
                                    &outbound,
                                );
                                continue;
                            }
                            let initialize = initialize_request.as_ref().ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "Catalog request before initialize",
                                )
                            })?;
                            let target = RemoteTarget::start(
                                scope,
                                remote_profile,
                                initialize.clone(),
                                next_route_id,
                                remote_launch.clone(),
                                requests.budgets(),
                                outbound.clone(),
                                Arc::clone(&remote_sessions),
                                Arc::clone(&catalogs),
                                Arc::clone(&remote_pending),
                                ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES,
                            );
                            next_route_id += 1;
                            remote.insert(key.clone(), target);
                        }
                        if let Err(error) = remote
                            .get(&key)
                            .expect("inserted SSH target")
                            .send(forwarded.clone())
                        {
                            reject_remote_request(&forwarded, &error, &catalogs, &outbound);
                        }
                    }
                    continue;
                }
                if method == Some("session/catalog/unsubscribe") {
                    catalog_subscribed = false;
                    for target in remote.values_mut() {
                        let mut forwarded = request.clone();
                        forwarded["id"] = serde_json::json!(ignored_request_id(next_ignored_id));
                        next_ignored_id += 1;
                        if let Err(error) = target.send(forwarded) {
                            target.fail(&error, &catalogs, &outbound);
                        }
                    }
                    let output = outbound.clone();
                    requests.dispatch(
                        Arc::clone(&profile.server),
                        &profile.connection,
                        raw,
                        move |response| {
                            output
                                .send(response.into())
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
                        },
                    )?;
                    continue;
                }
                let execution_target =
                    match selected_execution_target(&registry, &remote_sessions, &request) {
                        Ok(target) => target,
                        Err(error) => {
                            outbound
                                .send(routing_error(id, &error).into())
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                            continue;
                        }
                    };
                let target = match execution_target {
                    Some(SessionExecutionTarget::Local { root }) => {
                        // The durable root is only a routing tag here. The registry resolves
                        // filesystem aliases and opens the shared runtime on the route task.
                        let root = PathBuf::from(root);
                        if local.get(&root).is_some_and(|target| !target.is_alive()) {
                            let mut target = local.remove(&root).expect("existing local target");
                            target.close();
                            target.join()?;
                            target.dispose();
                        }
                        if !local.contains_key(&root) {
                            if local.len() == MAX_LOCAL_TARGETS {
                                outbound
                                    .send(
                                        local_request_error(
                                            id,
                                            &io::Error::new(
                                                io::ErrorKind::WouldBlock,
                                                "Local directory target capacity exhausted",
                                            ),
                                        )
                                        .into(),
                                    )
                                    .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                                continue;
                            }
                            let initialize = initialize_request.as_ref().ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "Session request before initialize",
                                )
                            })?;
                            let target = LocalTarget::start(
                                scope,
                                Arc::clone(&registry),
                                root.clone(),
                                initialize.clone(),
                                next_route_id,
                                requests.handle(),
                                outbound.clone(),
                            );
                            next_route_id += 1;
                            local.insert(root.clone(), target);
                        }
                        if let Err(error) = local
                            .get(&root)
                            .expect("inserted local target")
                            .send(raw, &request)
                        {
                            outbound
                                .send(local_request_error(id, &error).into())
                                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                        }
                        continue;
                    }
                    Some(SessionExecutionTarget::Ssh { host, root }) => {
                        let key = (host, root);
                        if remote.get(&key).is_some_and(|target| !target.is_alive()) {
                            remote.remove(&key);
                        }
                        if !remote.contains_key(&key) {
                            if remote.len() == MAX_REMOTE_TARGETS {
                                reject_remote_request(
                                    &request,
                                    &io::Error::new(
                                        io::ErrorKind::WouldBlock,
                                        "SSH target capacity exhausted",
                                    ),
                                    &catalogs,
                                    &outbound,
                                );
                                continue;
                            }
                            let remote_profile = match registry.remote_profile(&key.0, &key.1) {
                                Ok(profile) => profile,
                                Err(error) => {
                                    outbound
                                        .send(routing_error(id, &error).into())
                                        .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                                    continue;
                                }
                            };
                            let initialize = initialize_request.as_ref().ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "Session request before initialize",
                                )
                            })?;
                            let target = RemoteTarget::start(
                                scope,
                                remote_profile,
                                initialize.clone(),
                                next_route_id,
                                remote_launch.clone(),
                                requests.budgets(),
                                outbound.clone(),
                                Arc::clone(&remote_sessions),
                                Arc::clone(&catalogs),
                                Arc::clone(&remote_pending),
                                ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES,
                            );
                            next_route_id += 1;
                            if catalog_subscribed {
                                let subscription = serde_json::json!({ "jsonrpc": "2.0", "id": ignored_request_id(next_ignored_id), "method": "session/catalog/subscribe", "params": {} });
                                next_ignored_id += 1;
                                if let Err(error) = target.send(subscription) {
                                    target.fail(&error, &catalogs, &outbound);
                                }
                            }
                            remote.insert(key.clone(), target);
                        }
                        let target = remote.get(&key).expect("inserted SSH target");
                        let mut forwarded = request.clone();
                        if method == Some("session/create") {
                            forwarded["params"]["executionTarget"] =
                                serde_json::json!({"type":"local","root":key.1.clone()});
                        }
                        if let Err(error) = target.send(forwarded.clone()) {
                            reject_remote_request(&forwarded, &error, &catalogs, &outbound);
                        }
                        continue;
                    }
                    None => &mut profile,
                };
                let output = outbound.clone();
                requests.dispatch(
                    Arc::clone(&target.server),
                    &target.connection,
                    raw,
                    move |response| {
                        output
                            .send(response.into())
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
                    },
                )?;
            }
            Ok::<(), io::Error>(())
        })();
        profile
            .server
            .cancel_connection_requests(&profile.connection);
        for target in local.values_mut() {
            target.close();
        }
        // Close remote children before joining work: an incomplete SSH handshake or a blocked
        // pipe must not outlive the renderer that owns it.
        for target in remote.values() {
            target.close();
        }
        let mut local_result = Ok(());
        for target in local.values_mut() {
            if let Err(error) = target.join() {
                local_result = Err(error);
            }
        }
        let request_result = requests.finish();
        profile.server.close_connection(profile.connection);
        for target in local.into_values() {
            target.dispose();
        }
        drop(remote);
        drop(outbound);
        result?;
        request_result?;
        local_result?;
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

fn read_remote_messages(
    mut reader: JsonlReader<impl BufRead>,
    key: RemoteKey,
    route_id: usize,
    alive: Arc<std::sync::atomic::AtomicBool>,
    outbound: OutboundSender,
    sessions: RemoteSessionIndex,
    catalogs: Catalogs,
    pending: RemotePending,
) {
    while let Ok(Some(raw)) = reader.read_message() {
        let Ok(mut message) = serde_json::from_str::<Value>(&raw) else {
            break;
        };
        if message.get("method").is_none() {
            let mut routes = pending.lock().unwrap();
            let accepted = message.get("id").and_then(|id| {
                let route = routes.get_mut(&route_id)?;
                let position = route
                    .ids
                    .iter()
                    .position(|(candidate, _)| candidate == id)?;
                Some(route.ids.remove(position))
            });
            // Failure and response delivery compete for the same pending ID. Once failure has
            // completed it, a buffered remote response must not produce a second terminal reply.
            if accepted.is_none() {
                continue;
            }
        }
        annotate_remote_sessions(&mut message, &key, &sessions);
        if message.get("method").and_then(Value::as_str) == Some("session/changed") {
            if let Some(session_id) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(session_id.to_owned(), key.clone());
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
        if outbound.send(output.into()).is_err() {
            break;
        }
    }
    fail_remote_requests(
        route_id,
        &io::Error::new(io::ErrorKind::BrokenPipe, "SSH App Server disconnected"),
        &pending,
        &catalogs,
        &outbound,
    );
    alive.store(false, std::sync::atomic::Ordering::Release);
}

fn reject_remote_request(
    request: &Value,
    failure: &io::Error,
    catalogs: &Catalogs,
    outbound: &OutboundSender,
) {
    let Some(id) = request.get("id").cloned() else {
        return;
    };
    let mut error = if failure.kind() == io::ErrorKind::WouldBlock {
        AppServerError::new(-32000, AppServerErrorName::ServerOverloaded)
    } else {
        AppServerError::new(-32603, AppServerErrorName::InternalError)
    };
    error.message.push_str(": ");
    error.message.push_str(&failure.to_string());
    let response = serde_json::to_string(&JsonRpcFailure::new(
        serde_json::from_value(id.clone()).expect("numeric remote request ID"),
        error,
    ))
    .expect("valid routing error");
    if let Some(id_number) = id.as_u64() {
        if let Some(batch_id) = catalog_batch_id(id_number) {
            let failure: Value = serde_json::from_str(&response).expect("valid routing error");
            complete_catalog(catalogs, batch_id, failure, outbound);
            return;
        }
        if id_number >= u64::MAX / 2 {
            return;
        }
        let _ = outbound.send(response.into());
    }
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

fn fail_remote_requests(
    route_id: usize,
    failure: &io::Error,
    pending: &RemotePending,
    catalogs: &Catalogs,
    outbound: &OutboundSender,
) {
    let outstanding = {
        let mut pending = pending.lock().unwrap();
        let Some(route) = pending.get_mut(&route_id) else {
            return;
        };
        route.closed = true;
        std::mem::take(&mut route.ids)
    };
    for (id, _) in outstanding {
        reject_remote_request(&serde_json::json!({"id":id}), failure, catalogs, outbound);
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
    outbound: &OutboundSender,
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
        drop(catalogs);
        let _ = outbound.send(response.to_string().into());
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
        .and_then(|params| {
            params.get("sessionId").or_else(|| {
                params
                    .get("sessionDirectory")
                    .and_then(|dir| dir.get("sessionId"))
            })
        })
        .and_then(Value::as_str)
    {
        let local_id = SessionId::new(session_id.to_owned()).map_err(|error| error.to_string())?;
        if let Some(session) = registry.local_session(&local_id)? {
            // History lives in this profile even when its execution authority is SSH. Sending
            // its requests back to that host would reopen the retired Agent owner after import.
            return Ok(local_history_target(session.execution_target));
        }
        if let Some((host, root)) = remote_sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
        {
            return Ok(Some(SessionExecutionTarget::Ssh { host, root }));
        }
        return Ok(None);
    }
    if let Some(thread_id) = params
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str)
    {
        let local_id = ThreadId::new(thread_id.to_owned()).map_err(|error| error.to_string())?;
        if let Some(session) = registry.local_thread_session(&local_id)? {
            return Ok(local_history_target(session.execution_target));
        }
        if let Some((host, root)) = remote_sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .cloned()
        {
            return Ok(Some(SessionExecutionTarget::Ssh { host, root }));
        }
        return Ok(None);
    }
    Ok(None)
}

fn local_history_target(target: Option<SessionExecutionTarget>) -> Option<SessionExecutionTarget> {
    match target {
        Some(target @ SessionExecutionTarget::Local { .. }) => Some(target),
        Some(SessionExecutionTarget::Ssh { .. }) | None => None,
    }
}

fn local_request_error(id: Value, detail: &io::Error) -> String {
    let id = serde_json::from_value::<JsonRpcId>(id).expect("gateway validated request ID");
    let (code, name) = if detail.kind() == io::ErrorKind::WouldBlock {
        (-32000, AppServerErrorName::ServerOverloaded)
    } else {
        (-32603, AppServerErrorName::InternalError)
    };
    let mut error = AppServerError::new(code, name);
    error.message.push_str(": ");
    error.message.push_str(&detail.to_string());
    serde_json::to_string(&JsonRpcFailure::new(id, error)).expect("local routing error serializes")
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

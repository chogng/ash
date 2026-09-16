use super::CollaborationServerError;
use super::HttpRequest;
use super::HttpRuntime;
use call::CallError;
use call::CallRole;
use call::CallSnapshot;
use call::CallStore;
use call::MediaState;
use call::MemberCredential;
use livekit_api::MediaPermissions;
use livekit_api::MediaService;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

pub(super) struct CallRuntime {
    store: CallStore,
    service: Arc<MediaService>,
    executor: tokio::runtime::Runtime,
    // A room operation and its durable completion cannot race another room operation.
    operations: Mutex<std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>>,
}

impl CallRuntime {
    pub(super) fn open(
        path: &Path,
        service: Arc<MediaService>,
    ) -> Result<Self, CollaborationServerError> {
        let store =
            CallStore::open(path).map_err(|e| CollaborationServerError::storage(e.to_string()))?;
        let executor = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(CollaborationServerError::http)?;
        let runtime = Self {
            store,
            service,
            executor,
            operations: Mutex::new(std::collections::HashMap::new()),
        };
        for call in runtime
            .store
            .pending_media()
            .map_err(|e| CollaborationServerError::storage(e.to_string()))?
        {
            runtime.reconcile(call).map_err(|_| {
                CollaborationServerError::storage("Pending call media operation failed".into())
            })?;
        }
        Ok(runtime)
    }

    fn reconcile(&self, snapshot: CallSnapshot) -> Result<CallSnapshot, Failure> {
        self.executor.block_on(async {
            match &snapshot.media_state {
                MediaState::Preparing => self.service.create_room(&snapshot.media_room).await?,
                MediaState::Rotating { previous_room } => {
                    self.service.delete_room(previous_room).await?;
                    self.service.create_room(&snapshot.media_room).await?;
                }
                MediaState::Closing => self.service.delete_room(&snapshot.media_room).await?,
                MediaState::Ready | MediaState::Closed => return Ok(snapshot),
            }
            self.store
                .media_completed(&snapshot.id, snapshot.revision)
                .map_err(Failure::from)
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    operation_id: String,
    owner_credential: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invite {
    operation_id: String,
    revision: u64,
    member_credential: String,
    role: CallRole,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Remove {
    operation_id: String,
    revision: u64,
    member_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct End {
    operation_id: String,
    revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Join {
    device_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Device {
    operation_id: String,
    revision: u64,
    device_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Role {
    operation_id: String,
    revision: u64,
    member_id: String,
    role: CallRole,
}

enum Failure {
    Domain(CallError),
    Media,
}
impl From<CallError> for Failure {
    fn from(value: CallError) -> Self {
        Self::Domain(value)
    }
}
impl From<livekit_api::ServiceError> for Failure {
    fn from(_: livekit_api::ServiceError) -> Self {
        Self::Media
    }
}

pub(super) fn handle(
    stream: &mut TcpStream,
    host: &HttpRuntime,
    request: &HttpRequest,
    path: &str,
) -> Result<(), CollaborationServerError> {
    let Some(runtime) = &host.calls else {
        return super::write_json(
            stream,
            host,
            request,
            503,
            "Service Unavailable",
            &json!({"error":{"code":"mediaUnavailable","message":"No media deployment is configured"}}),
        );
    };
    match dispatch(runtime, host, request, path) {
        Ok(result) => super::write_json(stream, host, request, 200, "OK", &result),
        Err(error) => {
            let (status, reason, code) = match error {
                Failure::Domain(CallError::Invalid) => (400, "Bad Request", "invalidInput"),
                Failure::Domain(CallError::Denied) => (403, "Forbidden", "accessDenied"),
                Failure::Domain(CallError::Conflict) => (409, "Conflict", "revisionConflict"),
                Failure::Domain(CallError::NotReady) => (409, "Conflict", "mediaNotReady"),
                Failure::Domain(CallError::Storage) => {
                    (500, "Internal Server Error", "storageFailure")
                }
                Failure::Media => (503, "Service Unavailable", "mediaUnavailable"),
            };
            super::write_json(
                stream,
                host,
                request,
                status,
                reason,
                &json!({"error":{"code":code,"message":"Call operation did not complete"}}),
            )
        }
    }
}

fn dispatch(
    runtime: &CallRuntime,
    host: &HttpRuntime,
    request: &HttpRequest,
    path: &str,
) -> Result<Value, Failure> {
    let token = super::bearer_token(request).ok_or(CallError::Denied)?;
    let creating = path == "/v1/calls/create" && request.method == "POST";
    let credential = if creating {
        if !super::authorized(request, host.options.bearer_token()) {
            return Err(CallError::Denied.into());
        }
        let params: Create = decode(request)?;
        MemberCredential::parse(params.owner_credential)?
    } else {
        MemberCredential::parse(token.into()).map_err(|_| CallError::Denied)?
    };
    let key = if creating {
        runtime
            .store
            .create(&credential, &decode::<Create>(request)?.operation_id)?
            .id
    } else {
        runtime.store.read(&credential)?.id
    };
    let lock = {
        let mut locks = runtime.operations.lock().map_err(|_| CallError::Storage)?;
        locks.retain(|_, value| value.strong_count() > 0);
        match locks.get(&key).and_then(std::sync::Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        }
    };
    let _operation = lock.lock().map_err(|_| CallError::Storage)?;
    let snapshot = match (request.method.as_str(), path) {
        ("POST", "/v1/calls/create") => runtime
            .store
            .create(&credential, &decode::<Create>(request)?.operation_id)?,
        ("GET", "/v1/calls/read") => runtime.store.read(&credential)?,
        ("POST", "/v1/calls/invite") => {
            let params: Invite = decode(request)?;
            runtime.store.invite(
                &credential,
                &params.operation_id,
                params.revision,
                &MemberCredential::parse(params.member_credential)?,
                params.role,
            )?
        }
        ("POST", "/v1/calls/remove") => {
            let params: Remove = decode(request)?;
            runtime.store.remove_member(
                &credential,
                &params.operation_id,
                params.revision,
                &params.member_id,
            )?
        }
        ("POST", "/v1/calls/end") => {
            let params: End = decode(request)?;
            runtime
                .store
                .end(&credential, &params.operation_id, params.revision)?
        }
        ("POST", "/v1/calls/role") => {
            let params: Role = decode(request)?;
            runtime.store.set_role(
                &credential,
                &params.operation_id,
                params.revision,
                &params.member_id,
                params.role,
            )?
        }
        ("POST", "/v1/calls/join") => {
            let grant = runtime
                .store
                .join(&credential, &decode::<Join>(request)?.device_id)?;
            let ticket = runtime.service.issue_join(
                &grant.call.media_room,
                &grant.participant_id,
                MediaPermissions {
                    microphone: grant.microphone,
                    screen: grant.member.role.can_share_screen(),
                    subscribe: true,
                },
            )?;
            return Ok(
                json!({"call":grant.call,"member":grant.member,"microphone":grant.microphone,"participantId":ticket.participant_id,"serverUrl":ticket.server_url,"participantToken":ticket.token(),"expiresAt":ticket.expires_at}),
            );
        }
        ("POST", "/v1/calls/device") => {
            let params: Device = decode(request)?;
            runtime.store.select_device(
                &credential,
                &params.operation_id,
                params.revision,
                &params.device_id,
            )?
        }
        _ => return Err(CallError::Invalid.into()),
    };
    let snapshot = runtime.reconcile(snapshot)?;
    serde_json::to_value(snapshot).map_err(|_| CallError::Storage.into())
}

fn decode<T: serde::de::DeserializeOwned>(request: &HttpRequest) -> Result<T, Failure> {
    if request.body.len() > 16 * 1024 {
        return Err(CallError::Invalid.into());
    }
    super::decode_json(request).ok_or(CallError::Invalid.into())
}

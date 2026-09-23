use super::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::call::CallConnection;
use ash_app_server_protocol::protocol::call::CallControl;
use ash_app_server_protocol::protocol::call::CallDeployment;
use ash_app_server_protocol::protocol::call::CallStartParams;
use ash_app_server_protocol::protocol::call::CallStatus;
use ash_http_client::HttpClientConfig;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::PolicyHttpClient;
use ash_http_client::ProxyPolicy;
use ash_http_client::UreqHttpClient;
use call::CallClient;
use call::LocalDeployment;
use call::MemberCredential;
use call::ServicePaths;
use livekit_client::AudioPublication;
use livekit_client::MediaRoom;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use voice_host::AudioConfig;
use voice_host::AudioHost;
use voice_host::Direction;
use voice_host::Processing;
use voice_host::SampleRate;

pub(super) type Failure = String;
type Reply = oneshot::Sender<Result<CallStatus, Failure>>;

pub(super) struct Session {
    pub client: CallClient,
    pub url: String,
    pub state: Arc<Mutex<CallStatus>>,
    pub screens: Arc<Mutex<super::call_video::Screens>>,
    pub invitations: BTreeMap<String, (call::CallRole, u64, String)>,
    fingerprint: [u8; 32],
    commands: mpsc::Sender<(Option<CallControl>, Reply)>,
    worker: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub(super) struct Calls {
    executor: OnceLock<tokio::runtime::Runtime>,
    pub sessions: Mutex<BTreeMap<(u64, String), Session>>,
    local: Mutex<Weak<LocalDeployment>>,
    network_policy: OutboundNetworkPolicy,
}

impl Calls {
    pub fn set_network_policy(&mut self, policy: OutboundNetworkPolicy) {
        self.network_policy = policy;
    }

    fn executor(&self) -> Result<&tokio::runtime::Runtime, Failure> {
        if self.executor.get().is_none() {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|_| "Could not start call runtime")?;
            let _ = self.executor.set(runtime);
        }
        self.executor
            .get()
            .ok_or_else(|| "Call runtime unavailable".into())
    }

    pub fn start(
        &self,
        owner: u64,
        params: CallStartParams,
        home: &Path,
        notifications: NotificationQueue,
    ) -> Result<CallStatus, Failure> {
        for id in [&params.resource_id, &params.operation_id, &params.device_id] {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            {
                return Err("Invalid call identity".into());
            }
        }
        let fingerprint: [u8; 32] =
            Sha256::digest(serde_json::to_vec(&params).map_err(|_| "Invalid call request")?).into();
        let mut sessions = self.sessions.lock().map_err(|_| "Call state unavailable")?;
        if let Some(session) = sessions.get(&(owner, params.resource_id.clone())) {
            if session.fingerprint != fingerprint {
                return Err("Call request conflicts with an existing operation".into());
            }
            return session
                .state
                .lock()
                .map(|state| state.clone())
                .map_err(|_| "Call state unavailable".into());
        }
        sessions.retain(|(connection, _), session| {
            *connection != owner || !session.worker.is_finished()
        });
        if sessions.keys().any(|(connection, _)| *connection == owner) {
            return Err("This window already owns a call".into());
        }
        drop(sessions);
        if let CallDeployment::Server { url, .. } | CallDeployment::Invitation { url, .. } =
            &params.deployment
        {
            self.network_policy
                .check_url(url)
                .map_err(|error| error.to_string())?;
        }
        let audio_path = executable("ASH_VOICE_HOST_PATH", "ash-voice-host")?;
        let local = if matches!(params.deployment, CallDeployment::Local) {
            let mut slot = self.local.lock().map_err(|_| "Local service unavailable")?;
            let deployment = if let Some(deployment) = slot.upgrade() {
                deployment
            } else {
                let deployment = Arc::new(
                    LocalDeployment::start(
                        &ServicePaths {
                            media: executable("ASH_LIVEKIT_SERVER_PATH", "livekit-server")?,
                            collaboration: executable(
                                "ASH_COLLABORATION_SERVER_PATH",
                                "ash-collaboration-server",
                            )?,
                        },
                        &home.join("calls.sqlite3"),
                    )
                    .map_err(|e| e.to_string())?,
                );
                *slot = Arc::downgrade(&deployment);
                deployment
            };
            Some(deployment)
        } else {
            let url = match &params.deployment {
                CallDeployment::Server { url, .. } | CallDeployment::Invitation { url, .. } => {
                    url.trim_end_matches('/')
                }
                CallDeployment::Local => unreachable!(),
            };
            self.local
                .lock()
                .map_err(|_| "Local service unavailable")?
                .upgrade()
                .filter(|deployment| deployment.url() == url)
        };
        let url = match &params.deployment {
            CallDeployment::Local => local.as_ref().expect("local deployment").url().to_owned(),
            CallDeployment::Server { url, .. } | CallDeployment::Invitation { url, .. } => {
                url.clone()
            }
        };
        self.network_policy
            .check_url(&url)
            .map_err(|error| error.to_string())?;
        let credential = match &params.deployment {
            CallDeployment::Invitation { credential, .. } => {
                MemberCredential::parse(credential.clone()).map_err(|e| e.to_string())?
            }
            _ => MemberCredential::generate(),
        };
        let config = if local.is_some() {
            HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct)
        } else {
            HttpClientConfig::default()
        };
        let network = OutboundNetworkSnapshot::with_policy(config, self.network_policy.clone())
            .map_err(|_| "Call transport unavailable")?;
        let raw_http: Arc<dyn ash_http_client::HttpClient> = Arc::new(
            UreqHttpClient::with_network(network).map_err(|_| "Call transport unavailable")?,
        );
        let http: Arc<dyn ash_http_client::HttpClient> =
            Arc::new(PolicyHttpClient::new(raw_http, self.network_policy.clone()));
        let client = CallClient::new(&url, credential, http).map_err(|e| e.to_string())?;
        match &params.deployment {
            CallDeployment::Local => {
                client
                    .create(
                        local.as_ref().expect("local deployment").administrator(),
                        &params.operation_id,
                    )
                    .map_err(|e| e.to_string())?;
            }
            CallDeployment::Server { administrator, .. } => {
                client
                    .create(administrator, &params.operation_id)
                    .map_err(|e| e.to_string())?;
            }
            CallDeployment::Invitation { .. } => {}
        }
        let joined = client.join(&params.device_id).map_err(|e| e.to_string())?;
        self.network_policy
            .check_url(&joined.server_url)
            .map_err(|error| error.to_string())?;
        let opened = self.executor()?.block_on(async {
            let connect = async {
                tokio::time::timeout(Duration::from_secs(20), async {
                    let room = MediaRoom::connect(
                        &joined.server_url,
                        &joined.participant_token,
                        if joined.microphone {
                            AudioPublication::Microphone
                        } else {
                            AudioPublication::SubscribeOnly
                        },
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    if joined.microphone {
                        room.mute().map_err(|e| e.to_string())?;
                    }
                    let mut audio = AudioHost::spawn(&audio_path)
                        .await
                        .map_err(|e| e.to_string())?;
                    audio
                        .start(audio_config(Direction::Playback))
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok::<_, Failure>((room, audio))
                })
                .await
                .map_err(|_| "Opening audio devices timed out".to_owned())
                .and_then(|result| result)
            };
            tokio::select! {
                result = connect => result,
                () = self.network_policy.wait_until_denied(&url) => Err("Call target blocked by network policy".into()),
                () = self.network_policy.wait_until_denied(&joined.server_url) => Err("Media target blocked by network policy".into()),
            }
        });
        let opened = opened.and_then(|connected| {
            self.network_policy
                .check_url(&url)
                .map_err(|error| error.to_string())?;
            self.network_policy
                .check_url(&joined.server_url)
                .map_err(|error| error.to_string())?;
            Ok(connected)
        });
        let (room, audio) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                if !matches!(params.deployment, CallDeployment::Invitation { .. }) {
                    let operation = MemberCredential::generate();
                    let cleanup = client
                        .read()
                        .and_then(|snapshot| client.end(operation.expose(), snapshot.revision));
                    if let Err(cleanup) = cleanup {
                        return Err(format!(
                            "{error}; closing the created room also failed: {cleanup}"
                        ));
                    }
                }
                return Err(error);
            }
        };
        let status = CallStatus {
            resource_id: params.resource_id.clone(),
            sequence: 0,
            connection: CallConnection::Connecting,
            call: joined.call,
            member_id: joined.member.id,
            participants: Vec::new(),
            muted: true,
            deafened: false,
            microphone_allowed: joined.microphone,
            screen_sharing: false,
            error: None,
        };
        let state = Arc::new(Mutex::new(status.clone()));
        let screens = Arc::new(Mutex::new(super::call_video::Screens::default()));
        let worker_screens = screens.clone();
        let (commands, receiver) = mpsc::channel(16);
        let worker_state = state.clone();
        let worker_client = client.clone();
        let worker_policy = self.network_policy.clone();
        let room_policy = worker_policy.clone();
        let worker_url = url.clone();
        let media_url = joined.server_url.clone();
        let policy_commands = commands.clone();
        let worker = self.executor()?.spawn(async move {
            let _local = local;
            let policy_guard = tokio::spawn(async move {
                tokio::select! {
                    () = worker_policy.wait_until_denied(&worker_url) => {},
                    () = worker_policy.wait_until_denied(&media_url) => {},
                }
                let (reply, _) = oneshot::channel();
                let _ = policy_commands.send((None, reply)).await;
            });
            call::SessionRuntime {
                media: Box::new(super::call_adapters::Room::new(room, worker_screens, room_policy)),
                devices: Box::new(super::call_adapters::Devices::new(audio)),
                status,
                changed: Arc::new(move |status| {
                    if let Ok(mut state) = worker_state.lock() { *state = status.clone(); }
                    notifications.push(super::update_broker::notification(ash_app_server_protocol::protocol::registry::ServerNotificationMethod::CallChanged, status));
                }),
                client: worker_client,
                device: params.device_id,
            }.run(receiver).await;
            policy_guard.abort();
        });
        let opened = state.lock().map_err(|_| "Call state unavailable")?.clone();
        self.sessions
            .lock()
            .map_err(|_| "Call state unavailable")?
            .insert(
                (owner, params.resource_id),
                Session {
                    client,
                    fingerprint,
                    url,
                    state,
                    screens,
                    commands,
                    worker,
                    invitations: BTreeMap::new(),
                },
            );
        Ok(opened)
    }

    pub fn control(
        &self,
        owner: u64,
        resource: &str,
        control: Option<CallControl>,
    ) -> Result<CallStatus, Failure> {
        let (commands, state) = {
            let sessions = self.sessions.lock().map_err(|_| "Call state unavailable")?;
            let session = sessions
                .get(&(owner, resource.into()))
                .ok_or("Call not found")?;
            (session.commands.clone(), session.state.clone())
        };
        self.executor()?.block_on(async {
            let (reply, received) = oneshot::channel();
            let stopping = control.is_none();
            if commands.send((control, reply)).await.is_err() {
                if !stopping {
                    return Err("Call has ended".into());
                }
                return state
                    .lock()
                    .map(|state| state.clone())
                    .map_err(|_| "Call state unavailable".into());
            }
            tokio::time::timeout(Duration::from_secs(30), received)
                .await
                .map_err(|_| "Call control timed out")?
                .map_err(|_| "Call stopped before control completed")?
        })
    }

    pub fn close(&self, owner: u64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let keys: Vec<_> = sessions
                .keys()
                .filter(|(id, _)| *id == owner)
                .cloned()
                .collect();
            for key in keys {
                sessions.remove(&key);
            }
        }
    }
}

impl Drop for Calls {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            sessions.clear();
        }
        if let Some(runtime) = self.executor.take() {
            runtime.shutdown_timeout(Duration::from_secs(15));
        }
    }
}

fn executable(variable: &str, name: &str) -> Result<PathBuf, Failure> {
    let path = if let Some(path) = std::env::var_os(variable) {
        PathBuf::from(path)
    } else {
        std::env::current_exe()
            .map_err(|_| "Cannot locate product executables")?
            .parent()
            .ok_or("Cannot locate product directory")?
            .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
    };
    path.canonicalize()
        .map_err(|_| format!("Required call executable is missing: {name}"))
}

fn audio_config(direction: Direction) -> AudioConfig {
    AudioConfig {
        rate: SampleRate::Hz48000,
        direction,
        processing: Processing::Speech,
    }
}

#[cfg(test)]
#[path = "call_runtime_tests.rs"]
mod tests;

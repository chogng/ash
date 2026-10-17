use super::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::call::CallConnection;
use ash_app_server_protocol::protocol::call::CallControl;
use ash_app_server_protocol::protocol::call::CallDeployment;
use ash_app_server_protocol::protocol::call::CallStartParams;
use ash_app_server_protocol::protocol::call::CallStatus;
use ash_http_client::HttpClientConfig;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_http_client::ReqwestHttpClient;
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
    pub media: PathBuf,
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
    pub fn has_active_audio(&self) -> bool {
        self.sessions.lock().is_ok_and(|sessions| {
            sessions
                .values()
                .any(|session| !session.worker.is_finished())
        })
    }

    pub fn set_network_policy(&mut self, policy: OutboundNetworkPolicy) {
        self.network_policy = policy;
    }

    pub fn network_policy(&self) -> OutboundNetworkPolicy {
        self.network_policy.clone()
    }

    pub(super) fn executor(&self) -> Result<&tokio::runtime::Runtime, Failure> {
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

    /// Resolve only after a product-host media operation has passed authorization.
    pub fn prepare_media(&self, home: &Path) -> Result<PathBuf, Failure> {
        self.media_executable(home, "ash-livekit-client", "ASH_LIVEKIT_CLIENT_PATH")
    }

    pub fn audio_executable(&self, home: &Path) -> Result<PathBuf, Failure> {
        self.media_executable(home, "ash-voice-host", "ASH_VOICE_HOST_PATH")
    }

    fn media_executable(
        &self,
        home: &Path,
        binary: &str,
        variable: &str,
    ) -> Result<PathBuf, Failure> {
        if let Some(path) = std::env::var_os(variable) {
            let path = PathBuf::from(path);
            if !path.is_absolute() || !path.is_file() {
                return Err("optional media runtime is not installed or available".into());
            }
            return path.canonicalize().map_err(|error| error.to_string());
        }
        let offline = std::env::var_os("ASH_MEDIA_PACKAGE").map(PathBuf::from);
        let source = match offline.as_deref() {
            Some(path) => ash_package_store::CapabilitySource::Directory(path),
            None => ash_package_store::CapabilitySource::ProductBound,
        };
        ash_package_store::resolve_capability_executable(
            home,
            "media",
            binary,
            source,
            &ReqwestHttpClient::with_network(self.download_network()?)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }

    pub fn download_network(&self) -> Result<OutboundNetworkSnapshot, Failure> {
        let config = HttpClientConfig::default()
            .with_response_body_limit(
                ash_http_client::ResponseBodyLimit::new(
                    std::num::NonZeroUsize::new(128 * 1024 * 1024).unwrap(),
                )
                .unwrap(),
            )
            .with_redirect_policy(ash_http_client::RedirectPolicy::Follow {
                max_hops: std::num::NonZeroU8::new(5).unwrap(),
            })
            .with_timeouts(ash_http_client::TransportTimeouts::new(
                ash_http_client::Timeout::After(Duration::from_secs(30)),
                ash_http_client::Timeout::Disabled,
                ash_http_client::Timeout::Disabled,
                ash_http_client::Timeout::After(Duration::from_secs(300)),
            ));
        OutboundNetworkSnapshot::with_policy(config, self.network_policy.clone())
            .map_err(|error| error.to_string())
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
        let media = self.prepare_media(home)?;
        let audio_path = self.audio_executable(home)?;
        let local = if matches!(params.deployment, CallDeployment::Local) {
            let mut slot = self.local.lock().map_err(|_| "Local service unavailable")?;
            let deployment = if let Some(deployment) = slot.upgrade() {
                deployment
            } else {
                let deployment = Arc::new(
                    LocalDeployment::start(
                        &ServicePaths {
                            media: LocalDeployment::livekit_server(
                                home,
                                &ReqwestHttpClient::with_network(self.download_network()?)
                                    .map_err(|error| error.to_string())?,
                            )
                            .map_err(|error| error.to_string())?,
                            collaboration: executable(
                                "ASH_COLLABORATION_SERVER_PATH",
                                "ash-collab-server",
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
        let http: Arc<dyn ash_http_client::HttpClient> = Arc::new(
            ReqwestHttpClient::with_network(network).map_err(|_| "Call transport unavailable")?,
        );
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
                        &media,
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
        let worker_media = media.clone();
        let worker_media_lease = ash_package_store::acquire_package_lease_for_executable(&media)
            .map_err(|error| error.to_string())?;
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
                media: Box::new(super::call_adapters::Room::new(room, worker_screens, room_policy, worker_media, worker_media_lease)),
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
                    media,
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

    /// A control receipt precedes device/room disposal. Voice replacement must wait
    /// for this specific Call worker before acquiring the microphone for its next epoch.
    pub(super) fn stop_and_wait(&self, owner: u64, resource: &str) -> Result<(), Failure> {
        self.control(owner, resource, None)?;
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let finished = self
                .sessions
                .lock()
                .map_err(|_| "Call state unavailable")?
                .get(&(owner, resource.into()))
                .is_none_or(|session| session.worker.is_finished());
            if finished {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Call device cleanup is still pending".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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
            // The final VoiceHost reference can be released by a worker of this
            // runtime. Tokio must not block that worker while dropping its executor.
            if tokio::runtime::Handle::try_current().is_ok() {
                runtime.shutdown_background();
            } else {
                runtime.shutdown_timeout(Duration::from_secs(15));
            }
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
        .map_err(|_| format!("Required executable is missing: {name}"))
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

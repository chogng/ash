use crate::CallClient;
use crate::CallConnection;
use crate::CallControl;
use crate::CallParticipant;
use crate::CallStatus;
use crate::MediaJoin;
use crate::MediaState;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

type Failure = String;
pub type Operation<'a, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send + 'a>>;
type Reply = oneshot::Sender<Result<CallStatus, Failure>>;
pub type SessionCommand = (Option<CallControl>, Reply);

struct Watcher(tokio::task::JoinHandle<()>);
impl Drop for Watcher {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Media facts supplied by the host's room adapter; authorization remains with CallClient.
pub enum MediaEvent {
    Audio,
    Connected {
        participant_ids: Vec<String>,
    },
    ParticipantJoined {
        participant_id: String,
    },
    ParticipantLeft {
        participant_id: String,
    },
    TrackAdded {
        participant_id: String,
        track_id: String,
    },
    TrackRemoved {
        track_id: String,
    },
    TrackMuted {
        track_id: String,
    },
    TrackUnmuted {
        track_id: String,
    },
    Reconnecting,
    Reconnected,
    Disconnected,
}

/// The media adapter owns SDK tracks and bounded playback queues, independently of devices.
pub trait Media: Send {
    fn next_event(&mut self) -> Operation<'_, Option<MediaEvent>>;
    fn send_audio<'a>(&'a mut self, samples: &'a [i16]) -> Operation<'a, ()>;
    fn render(&mut self, samples: usize, now: Instant) -> Result<Vec<i16>, Failure>;
    fn mute(&mut self) -> Result<(), Failure>;
    fn unmute(&mut self) -> Result<(), Failure>;
    fn remove_track(&mut self, track: &str);
    fn remove_participant(&mut self, participant: &str);
    fn clear(&mut self);
    fn set_volume(&mut self, track: &str, volume: f32) -> Result<(), Failure>;
    fn rejoin<'a>(&'a mut self, grant: &'a MediaJoin) -> Operation<'a, ()>;
    fn close(&mut self) -> Operation<'_, ()>;
}

/// A device adapter owns physical capture/playback and clears its output on interruption.
pub trait Devices: Send {
    fn next_capture(&mut self) -> Operation<'_, Vec<i16>>;
    fn play<'a>(&'a mut self, samples: &'a [i16]) -> Operation<'a, ()>;
    fn mute(&mut self) -> Operation<'_, ()>;
    fn unmute(&mut self) -> Operation<'_, ()>;
    fn interrupt(&mut self) -> Operation<'_, ()>;
    fn close(&mut self) -> Operation<'_, ()>;
}

pub struct SessionRuntime {
    pub media: Box<dyn Media>,
    pub devices: Box<dyn Devices>,
    pub status: CallStatus,
    pub changed: Arc<dyn Fn(&CallStatus) + Send + Sync>,
    pub client: CallClient,
    pub device: String,
}

impl SessionRuntime {
    pub async fn run(mut self, commands: mpsc::Receiver<SessionCommand>) {
        let mut reply = None;
        let outcome = self.pump(commands, &mut reply).await;
        let media = self.media.close().await;
        let devices = self.devices.close().await;
        self.status.error = outcome.err().or(media.err()).or(devices.err());
        self.status.muted = true;
        self.status.deafened = true;
        self.status.microphone_allowed = false;
        self.status.participants.clear();
        self.status.connection = if self.status.error.is_none() {
            CallConnection::Ended
        } else {
            CallConnection::Failed
        };
        self.publish();
        if let Some(reply) = reply {
            let _ = reply.send(Ok(self.status.clone()));
        }
    }

    fn publish(&mut self) {
        self.status.sequence = self.status.sequence.saturating_add(1);
        (self.changed)(&self.status);
    }

    async fn pump(
        &mut self,
        mut commands: mpsc::Receiver<(Option<CallControl>, Reply)>,
        stop_reply: &mut Option<Reply>,
    ) -> Result<(), Failure> {
        let mut playback = tokio::time::interval(Duration::from_millis(20));
        playback.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let (updates, mut authority) = mpsc::channel(1);
        let client = self.client.clone();
        let mut revision = self.status.call.revision;
        let _watcher = Watcher(tokio::spawn(async move {
            loop {
                let client = client.clone();
                let snapshot =
                    match tokio::task::spawn_blocking(move || client.watch(revision)).await {
                        Ok(snapshot) => snapshot.map_err(|e| e.to_string()),
                        Err(_) => Err("Call authority stopped".into()),
                    };
                if let Ok(snapshot) = &snapshot {
                    revision = snapshot.revision;
                }
                let failed = snapshot.is_err();
                if updates.send(snapshot).await.is_err() || failed {
                    break;
                }
            }
        }));
        let mut reconnect_started = None;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some((control, reply)) = command else { return Ok(()); };
                    let Some(control) = control else { *stop_reply = Some(reply); return Ok(()); };
                    let outcome = self.control(control).await;
                    self.publish();
                    let _ = reply.send(outcome.map(|()| self.status.clone()));
                }
                event = self.media.next_event() => {
                    let event = event?;
                    match event {
                        Some(MediaEvent::Audio) => continue,
                        Some(MediaEvent::Connected { participant_ids }) => {
                            self.status.connection = CallConnection::Connected;
                            self.status.participants = participant_ids.into_iter().map(|id| CallParticipant { id, tracks: Vec::new(), muted: false }).collect();
                        }
                        Some(MediaEvent::ParticipantJoined { participant_id }) => {
                            if !self.status.participants.iter().any(|p| p.id == participant_id) { self.status.participants.push(CallParticipant { id: participant_id, tracks: Vec::new(), muted: false }); }
                        }
                        Some(MediaEvent::ParticipantLeft { participant_id }) => {
                            self.media.remove_participant(&participant_id);
                            self.devices.interrupt().await.map_err(|e| e.to_string())?;
                            self.status.participants.retain(|p| p.id != participant_id);
                        }
                        Some(MediaEvent::TrackAdded { participant_id, track_id }) => {
                            if let Some(participant) = self.status.participants.iter_mut().find(|p| p.id == participant_id) { participant.tracks.push(track_id); }
                        }
                        Some(MediaEvent::TrackRemoved { track_id }) => {
                            self.media.remove_track(&track_id);
                            self.devices.interrupt().await.map_err(|e| e.to_string())?;
                            for participant in &mut self.status.participants { participant.tracks.retain(|id| *id != track_id); }
                        }
                        Some(MediaEvent::TrackMuted { track_id }) => {
                            self.media.remove_track(&track_id);
                            self.devices.interrupt().await.map_err(|e| e.to_string())?;
                            for participant in &mut self.status.participants { if participant.tracks.contains(&track_id) { participant.muted = true; } }
                        }
                        Some(MediaEvent::TrackUnmuted { track_id }) => {
                            for participant in &mut self.status.participants { if participant.tracks.contains(&track_id) { participant.muted = false; } }
                        }
                        Some(MediaEvent::Reconnecting) => {
                            reconnect_started = Some(Instant::now());
                            self.status.connection = CallConnection::Reconnecting;
                            self.media.clear(); self.devices.mute().await?; self.devices.interrupt().await?;
                        }
                        Some(MediaEvent::Reconnected) => {
                            if !self.status.muted && self.status.microphone_allowed { self.devices.unmute().await?; }
                            reconnect_started = None; self.status.connection = CallConnection::Connected;
                        }
                        Some(MediaEvent::Disconnected) | None => { self.rejoin().await?; reconnect_started = None; }
                    }
                    self.publish();
                }
                captured = self.devices.next_capture(), if !self.status.muted && reconnect_started.is_none() => {
                    self.media.send_audio(&captured?).await.map_err(|e| e.to_string())?;
                }
                _ = playback.tick() => {
                    if reconnect_started.is_some_and(|start: Instant| start.elapsed() > Duration::from_secs(30)) { return Err("Media reconnection timed out".into()); }
                    let samples = self.media.render(960, Instant::now()).map_err(|e| e.to_string())?;
                    if !self.status.deafened && reconnect_started.is_none() { self.devices.play(&samples).await.map_err(|e| e.to_string())?; }
                }
                snapshot = authority.recv() => {
                    let snapshot = snapshot.ok_or("Call authority stopped")??;
                    if matches!(snapshot.media_state, MediaState::Closed | MediaState::Closing) { self.status.call = snapshot; return Ok(()); }
                    if snapshot.media_state == MediaState::Ready && (snapshot.media_epoch != self.status.call.media_epoch || self.status.call.media_state != MediaState::Ready) {
                        self.rejoin().await?;
                        reconnect_started = None;
                    } else if snapshot.revision != self.status.call.revision {
                        if matches!(snapshot.media_state, MediaState::Rotating { .. }) {
                            self.devices.mute().await?;
                            self.devices.interrupt().await?;
                            self.media.clear();
                            self.status.connection = CallConnection::Reconnecting;
                            reconnect_started = Some(Instant::now());
                        }
                        self.status.call = snapshot;
                        self.publish();
                    }
                }
            }
        }
    }

    async fn control(&mut self, control: CallControl) -> Result<(), Failure> {
        match control {
            CallControl::Mute => {
                self.devices.mute().await?;
                self.status.muted = true;
                if self.status.microphone_allowed {
                    self.media.mute()?;
                }
            }
            CallControl::Unmute => {
                if !self.status.microphone_allowed {
                    return Err("This device does not have microphone permission".into());
                }
                self.devices.unmute().await?;
                if let Err(error) = self.media.unmute() {
                    self.devices.mute().await?;
                    return Err(error);
                }
                self.status.muted = false;
            }
            CallControl::Deafen => {
                self.status.deafened = true;
                self.media.clear();
                self.devices.interrupt().await?;
            }
            CallControl::Undeafen => {
                self.media.clear();
                self.status.deafened = false;
            }
            CallControl::Volume { track_id, volume } => {
                self.media.set_volume(&track_id, volume)?;
            }
            CallControl::SelectDevice {
                operation_id,
                revision,
            } => {
                let client = self.client.clone();
                let device = self.device.clone();
                tokio::task::spawn_blocking(move || {
                    client.select_device(&operation_id, revision, &device)
                })
                .await
                .map_err(|_| "Call authority stopped")?
                .map_err(|e| e.to_string())?;
                self.rejoin().await?;
            }
        }
        Ok(())
    }

    async fn rejoin(&mut self) -> Result<(), Failure> {
        self.status.connection = CallConnection::Reconnecting;
        self.publish();
        self.media.clear();
        self.devices.mute().await?;
        self.devices.interrupt().await?;
        self.media.close().await?;
        let client = self.client.clone();
        let device = self.device.clone();
        let joined = tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match client.join(&device) {
                    Err(crate::CallError::NotReady) if Instant::now() < deadline => {
                        let snapshot = client.read()?;
                        if matches!(
                            snapshot.media_state,
                            MediaState::Closing | MediaState::Closed
                        ) {
                            return Err(crate::CallError::Denied);
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    outcome => return outcome,
                }
            }
        })
        .await
        .map_err(|_| "Call authority stopped")?
        .map_err(|e| e.to_string())?;
        self.media.rejoin(&joined).await?;
        if joined.microphone && self.status.muted {
            self.media.mute()?;
        }
        self.status.microphone_allowed = joined.microphone;
        self.status.call = joined.call;
        self.status.participants.clear();
        if joined.microphone && !self.status.muted {
            self.devices.unmute().await?;
        }
        if !joined.microphone {
            self.status.muted = true;
            self.devices.mute().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

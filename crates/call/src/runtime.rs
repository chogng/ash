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
    Video,
    ScreenStopped {
        error: Option<String>,
    },
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
    fn share_screen(&mut self, target: crate::ScreenTarget) -> Operation<'_, ()>;
    fn stop_screen_share(&mut self) -> Operation<'_, ()>;
    fn next_event(&mut self) -> Operation<'_, Option<MediaEvent>>;
    fn send_audio<'a>(&'a mut self, samples: &'a [i16]) -> Operation<'a, ()>;
    fn render(&mut self, samples: usize, now: Instant) -> Result<Vec<i16>, Failure>;
    fn mute(&mut self) -> Result<(), Failure>;
    fn unmute(&mut self) -> Result<(), Failure>;
    fn clear_track(&mut self, track: &str);
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
    pub async fn run(mut self, mut commands: mpsc::Receiver<SessionCommand>) {
        let mut reply = None;
        // Keep leave outside the media pump so it cancels any pending authority,
        // device or room operation before ordered cleanup below.
        let outcome = {
            let (forward, receiver) = mpsc::channel(8);
            let mut pump = Box::pin(self.pump(receiver));
            loop {
                tokio::select! {
                    biased;
                    command = commands.recv() => match command {
                        Some((None, response)) => { reply = Some(response); break Ok(()); }
                        None => break Ok(()),
                        Some((Some(control), response)) => {
                            if let Err(error) = forward.try_send((control, response)) {
                                let (_, response) = error.into_inner();
                                let _ = response.send(Err("Call controls are busy".into()));
                            }
                        }
                    },
                    outcome = &mut pump => break outcome,
                }
            }
        };
        let media = self.media.close().await;
        let devices = self.devices.close().await;
        self.status.error = outcome.err().or(media.err()).or(devices.err());
        self.status.muted = true;
        self.status.deafened = true;
        self.status.microphone_allowed = false;
        self.status.screen_sharing = false;
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
        mut commands: mpsc::Receiver<(CallControl, Reply)>,
    ) -> Result<(), Failure> {
        let mut playback = tokio::time::interval(Duration::from_millis(20));
        playback.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let (updates, mut authority) = mpsc::channel(1);
        let client = self.client.clone();
        let mut revision = self.status.call.revision;
        let _watcher = Watcher(tokio::spawn(async move {
            let mut delay = Duration::from_millis(250);
            loop {
                let client = client.clone();
                let snapshot =
                    match tokio::task::spawn_blocking(move || client.watch(revision)).await {
                        Ok(snapshot) => snapshot,
                        Err(_) => Err(crate::CallError::Transport),
                    };
                if let Ok(snapshot) = &snapshot {
                    revision = snapshot.revision;
                }
                let retry = matches!(snapshot, Err(crate::CallError::Transport));
                let terminal = snapshot.is_err() && !retry;
                if updates.send(snapshot).await.is_err() || terminal {
                    break;
                }
                if retry {
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(2));
                } else {
                    delay = Duration::from_millis(250);
                }
            }
        }));
        let mut reconnect_started = None;
        let mut authority_lost = false;
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some((control, reply)) = command else { return Ok(()); };
                    let outcome = self.control(control).await;
                    self.publish();
                    let _ = reply.send(outcome.map(|()| self.status.clone()));
                }
                event = self.media.next_event(), if !authority_lost => {
                    let event = event?;
                    match event {
                        Some(MediaEvent::Audio | MediaEvent::Video) => continue,
                        Some(MediaEvent::ScreenStopped { error }) => { self.status.screen_sharing = false; self.status.error = error; }
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
                            self.media.clear_track(&track_id);
                            self.devices.interrupt().await.map_err(|e| e.to_string())?;
                            for participant in &mut self.status.participants { if participant.tracks.contains(&track_id) { participant.muted = true; } }
                        }
                        Some(MediaEvent::TrackUnmuted { track_id }) => {
                            for participant in &mut self.status.participants { if participant.tracks.contains(&track_id) { participant.muted = false; } }
                        }
                        Some(MediaEvent::Reconnecting) => {
                            self.stop_screen_share().await?;
                            reconnect_started = Some(Instant::now());
                            self.status.connection = CallConnection::Reconnecting;
                            self.media.clear(); self.devices.mute().await?; self.devices.interrupt().await?;
                        }
                        Some(MediaEvent::Reconnected) => {
                            if !self.status.muted && self.status.microphone_allowed { self.devices.unmute().await?; }
                            reconnect_started = None; self.status.connection = CallConnection::Connected;
                        }
                        Some(MediaEvent::Disconnected) | None => {
                            self.rejoin().await?; reconnect_started = None;
                        }
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
                    let snapshot = match snapshot.ok_or("Call authority stopped")? {
                        Ok(snapshot) => snapshot,
                        Err(crate::CallError::Transport) => {
                            if !authority_lost {
                                authority_lost = true;
                                self.stop_screen_share().await?;
                                reconnect_started = Some(Instant::now());
                                self.status.connection = CallConnection::Reconnecting;
                                self.devices.mute().await?;
                                self.devices.interrupt().await?;
                                self.media.clear();
                                self.publish();
                            }
                            continue;
                        }
                        Err(error) => return Err(error.to_string()),
                    };
                    if matches!(snapshot.media_state, MediaState::Closed | MediaState::Closing) { self.status.call = snapshot; return Ok(()); }
                    if snapshot.media_state == MediaState::Ready && (authority_lost || snapshot.media_epoch != self.status.call.media_epoch || self.status.call.media_state != MediaState::Ready) {
                        self.rejoin().await?;
                        authority_lost = false;
                        reconnect_started = None;
                        self.status.connection = CallConnection::Connected;
                        self.publish();
                    } else if snapshot.revision != self.status.call.revision {
                        if matches!(snapshot.media_state, MediaState::Rotating { .. }) {
                            self.stop_screen_share().await?;
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
            CallControl::ShareScreen { target } => {
                if self.status.connection != CallConnection::Connected {
                    return Err("Wait for the call to connect before sharing".into());
                }
                if !self.status.call.members.iter().any(|member| {
                    member.id == self.status.member_id && member.role.can_share_screen()
                }) {
                    return Err("You do not have screen sharing permission".into());
                }
                self.stop_screen_share().await?;
                self.media.share_screen(target).await?;
                self.status.screen_sharing = true;
                self.status.error = None;
            }
            CallControl::StopScreenShare => {
                self.stop_screen_share().await?;
            }
            CallControl::Mute => {
                self.devices.mute().await?;
                self.status.muted = true;
                if self.status.microphone_allowed {
                    self.media.mute()?;
                }
            }
            CallControl::Unmute => {
                if self.status.connection == CallConnection::Reconnecting {
                    return Err("Wait for the call to reconnect before unmuting".into());
                }
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
        self.status.screen_sharing = false;
        self.status.connection = CallConnection::Reconnecting;
        self.publish();
        self.media.clear();
        self.devices.mute().await?;
        self.devices.interrupt().await?;
        self.media.close().await?;
        let joined = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let client = self.client.clone();
                let device = self.device.clone();
                let outcome = tokio::task::spawn_blocking(move || client.join(&device))
                    .await
                    .map_err(|_| "Call authority stopped".to_owned())?;
                match outcome {
                    Err(crate::CallError::NotReady) => {
                        let client = self.client.clone();
                        let snapshot = tokio::task::spawn_blocking(move || client.read())
                            .await
                            .map_err(|_| "Call authority stopped".to_owned())?;
                        match snapshot {
                            Ok(snapshot)
                                if matches!(
                                    snapshot.media_state,
                                    MediaState::Closing | MediaState::Closed
                                ) =>
                            {
                                return Err("Call has ended".into());
                            }
                            Ok(_) | Err(crate::CallError::Transport) => {}
                            Err(error) => return Err(error.to_string()),
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Err(crate::CallError::Transport) => {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    outcome => return outcome.map_err(|error| error.to_string()),
                }
            }
        })
        .await
        .map_err(|_| "Call authorization timed out")??;
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
        self.status.connection = CallConnection::Connected;
        Ok(())
    }

    async fn stop_screen_share(&mut self) -> Result<(), Failure> {
        self.status.screen_sharing = false;
        self.media.stop_screen_share().await
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

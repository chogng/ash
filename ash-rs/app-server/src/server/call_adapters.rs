use ash_http_client::OutboundNetworkPolicy;
use call::MediaJoin;
use call::Operation;
use livekit_client::AudioMixer;
use livekit_client::AudioPublication;
use livekit_client::MediaEvent;
use livekit_client::MediaRoom;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;
use voice_host::AudioConfig;
use voice_host::AudioHost;
use voice_host::CaptureState;
use voice_host::Direction;
use voice_host::Processing;
use voice_host::SampleRate;

pub(super) struct Room {
    room: Option<MediaRoom>,
    mixer: AudioMixer,
    closing: Option<Operation<'static, ()>>,
    screens: Arc<Mutex<super::call_video::Screens>>,
    network_policy: OutboundNetworkPolicy,
}
impl Room {
    pub fn new(
        room: MediaRoom,
        screens: Arc<Mutex<super::call_video::Screens>>,
        network_policy: OutboundNetworkPolicy,
    ) -> Self {
        Self {
            room: Some(room),
            mixer: AudioMixer::default(),
            closing: None,
            screens,
            network_policy,
        }
    }
    fn room(&mut self) -> Result<&mut MediaRoom, String> {
        self.room
            .as_mut()
            .ok_or_else(|| "Media room is closed".into())
    }
}
impl call::Media for Room {
    fn share_screen(&mut self, target: call::ScreenTarget) -> Operation<'_, ()> {
        Box::pin(async move {
            let source = match target {
                call::ScreenTarget::Display(id) => screen_capture::create_display_source(&id),
                call::ScreenTarget::Window(id) => screen_capture::create_window_source(&id),
            }
            .map_err(|error| error.to_string())?;
            self.room()?
                .start_screen_share(source.as_ref(), 15)
                .await
                .map_err(|error| error.to_string())
        })
    }
    fn stop_screen_share(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            self.room()?
                .stop_screen_share()
                .await
                .map_err(|error| error.to_string())
        })
    }
    fn next_event(&mut self) -> Operation<'_, Option<call::MediaEvent>> {
        Box::pin(async move {
            let Some(event) = self.room()?.next_event().await else {
                return Ok(None);
            };
            Ok(Some(match event {
                MediaEvent::Video(frame) => {
                    self.screens
                        .lock()
                        .map_err(|_| "Screen state unavailable")?
                        .push(frame);
                    call::MediaEvent::Video
                }
                MediaEvent::ScreenAdded {
                    participant_id,
                    track_id,
                } => {
                    self.screens
                        .lock()
                        .map_err(|_| "Screen state unavailable")?
                        .add(track_id, participant_id)?;
                    call::MediaEvent::Video
                }
                MediaEvent::ScreenStopped { error } => call::MediaEvent::ScreenStopped { error },
                MediaEvent::Audio(frame) => {
                    self.mixer.push(frame).map_err(|e| e.to_string())?;
                    call::MediaEvent::Audio
                }
                MediaEvent::Connected { participant_ids } => {
                    call::MediaEvent::Connected { participant_ids }
                }
                MediaEvent::ParticipantJoined { participant_id } => {
                    call::MediaEvent::ParticipantJoined { participant_id }
                }
                MediaEvent::ParticipantLeft { participant_id } => {
                    call::MediaEvent::ParticipantLeft { participant_id }
                }
                MediaEvent::TrackAdded {
                    participant_id,
                    track_id,
                } => call::MediaEvent::TrackAdded {
                    participant_id,
                    track_id,
                },
                MediaEvent::TrackRemoved { track_id } => {
                    self.screens
                        .lock()
                        .map_err(|_| "Screen state unavailable")?
                        .remove(&track_id);
                    call::MediaEvent::TrackRemoved { track_id }
                }
                MediaEvent::TrackMuted { track_id } => {
                    self.screens
                        .lock()
                        .map_err(|_| "Screen state unavailable")?
                        .remove(&track_id);
                    call::MediaEvent::TrackMuted { track_id }
                }
                MediaEvent::TrackUnmuted { track_id } => {
                    call::MediaEvent::TrackUnmuted { track_id }
                }
                MediaEvent::Reconnecting => call::MediaEvent::Reconnecting,
                MediaEvent::Reconnected => call::MediaEvent::Reconnected,
                MediaEvent::Disconnected => call::MediaEvent::Disconnected,
            }))
        })
    }
    fn send_audio<'a>(&'a mut self, samples: &'a [i16]) -> Operation<'a, ()> {
        Box::pin(async move {
            self.room()?
                .send_audio(samples)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn render(&mut self, samples: usize, now: Instant) -> Result<Vec<i16>, String> {
        self.mixer.render(samples, now).map_err(|e| e.to_string())
    }
    fn mute(&mut self) -> Result<(), String> {
        self.room()?.mute().map_err(|e| e.to_string())
    }
    fn unmute(&mut self) -> Result<(), String> {
        self.room()?.unmute().map_err(|e| e.to_string())
    }
    fn clear(&mut self) {
        self.mixer.clear();
        if let Ok(mut screens) = self.screens.lock() {
            screens.clear();
        }
    }
    fn clear_track(&mut self, track: &str) {
        self.mixer.clear_track(track);
    }
    fn remove_track(&mut self, track: &str) {
        self.mixer.remove_track(track);
    }
    fn remove_participant(&mut self, participant: &str) {
        self.mixer.remove_participant(participant);
        if let Ok(mut screens) = self.screens.lock() {
            screens.remove_participant(participant);
        }
    }
    fn set_volume(&mut self, track: &str, volume: f32) -> Result<(), String> {
        self.mixer
            .set_volume(track, volume)
            .map_err(|e| e.to_string())
    }
    fn rejoin<'a>(&'a mut self, grant: &'a MediaJoin) -> Operation<'a, ()> {
        Box::pin(async move {
            self.network_policy
                .check_url(&grant.server_url)
                .map_err(|error| error.to_string())?;
            // Replacing a room retires its track identities; buffered PCM and
            // settings for those removed tracks must not accumulate across epochs.
            self.mixer = AudioMixer::default();
            call::Media::close(self).await?;
            self.room = Some(
                MediaRoom::connect(
                    &grant.server_url,
                    &grant.participant_token,
                    if grant.microphone {
                        AudioPublication::Microphone
                    } else {
                        AudioPublication::SubscribeOnly
                    },
                )
                .await
                .map_err(|e| e.to_string())?,
            );
            Ok(())
        })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            self.screens
                .lock()
                .map_err(|_| "Screen state unavailable")?
                .clear();
            if self.closing.is_none() {
                if let Some(room) = self.room.take() {
                    self.closing = Some(Box::pin(async move {
                        room.close().await.map_err(|e| e.to_string())
                    }));
                }
            }
            // Keep the close future owned here if rejoin is cancelled by leave.
            // Final cleanup resumes it and waits for the room worker to finish.
            let result = match self.closing.as_mut() {
                Some(closing) => closing.await,
                None => Ok(()),
            };
            self.closing = None;
            result
        })
    }
}

pub(super) struct Devices {
    host: Option<AudioHost>,
    capture: bool,
}
impl Devices {
    pub fn new(host: AudioHost) -> Self {
        Self {
            host: Some(host),
            capture: false,
        }
    }
    fn host(&mut self) -> Result<&mut AudioHost, String> {
        self.host
            .as_mut()
            .ok_or_else(|| "Audio devices are closed".into())
    }
}
impl call::Devices for Devices {
    fn next_capture(&mut self) -> Operation<'_, Vec<i16>> {
        Box::pin(async move {
            self.host()?
                .next_capture()
                .await
                .map(|audio| audio.samples)
                .map_err(|e| e.to_string())
        })
    }
    fn play<'a>(&'a mut self, samples: &'a [i16]) -> Operation<'a, ()> {
        Box::pin(async move { self.host()?.play(samples).await.map_err(|e| e.to_string()) })
    }
    fn mute(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            if self.capture {
                self.host()?
                    .set_capture(CaptureState::Muted)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
    fn unmute(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            if !self.capture {
                self.host()?.stop().await.map_err(|e| e.to_string())?;
                self.host()?
                    .start(AudioConfig {
                        rate: SampleRate::Hz48000,
                        direction: Direction::Duplex,
                        processing: Processing::Speech,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                self.capture = true;
            }
            self.host()?
                .set_capture(CaptureState::Recording)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn interrupt(&mut self) -> Operation<'_, ()> {
        Box::pin(async move { self.host()?.interrupt().await.map_err(|e| e.to_string()) })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            if let Some(host) = self.host.take() {
                host.close().await.map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
}

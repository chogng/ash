use call::MediaJoin;
use call::Operation;
use livekit_client::AudioMixer;
use livekit_client::AudioPublication;
use livekit_client::MediaEvent;
use livekit_client::MediaRoom;
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
}
impl Room {
    pub fn new(room: MediaRoom) -> Self {
        Self {
            room: Some(room),
            mixer: AudioMixer::default(),
        }
    }
    fn room(&mut self) -> Result<&mut MediaRoom, String> {
        self.room
            .as_mut()
            .ok_or_else(|| "Media room is closed".into())
    }
}
impl call::Media for Room {
    fn next_event(&mut self) -> Operation<'_, Option<call::MediaEvent>> {
        Box::pin(async move {
            let Some(event) = self.room()?.next_event().await else {
                return Ok(None);
            };
            Ok(Some(match event {
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
                    call::MediaEvent::TrackRemoved { track_id }
                }
                MediaEvent::TrackMuted { track_id } => call::MediaEvent::TrackMuted { track_id },
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
    }
    fn remove_track(&mut self, track: &str) {
        self.mixer.remove_track(track);
    }
    fn remove_participant(&mut self, participant: &str) {
        self.mixer.remove_participant(participant);
    }
    fn set_volume(&mut self, track: &str, volume: f32) -> Result<(), String> {
        self.mixer
            .set_volume(track, volume)
            .map_err(|e| e.to_string())
    }
    fn rejoin<'a>(&'a mut self, grant: &'a MediaJoin) -> Operation<'a, ()> {
        Box::pin(async move {
            self.mixer.clear();
            if let Some(old) = self.room.take() {
                old.close().await.map_err(|e| e.to_string())?;
            }
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
            if let Some(room) = self.room.take() {
                room.close().await.map_err(|e| e.to_string())?;
            }
            Ok(())
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

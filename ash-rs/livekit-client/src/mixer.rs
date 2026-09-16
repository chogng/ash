use crate::AudioFrame;
use crate::MediaError;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::time::Duration;
use std::time::Instant;

const LIMIT: usize = 9_600;
const MAX_AGE: Duration = Duration::from_millis(200);

struct Track {
    participant: String,
    frames: VecDeque<AudioFrame>,
    samples: usize,
    volume: f32,
}

/// Bounded per-track PCM queues rendered together on the caller's 48 kHz playback clock.
#[derive(Default)]
pub struct AudioMixer {
    tracks: BTreeMap<String, Track>,
}

impl AudioMixer {
    pub fn push(&mut self, frame: AudioFrame) -> Result<(), MediaError> {
        if frame.samples.is_empty()
            || frame.samples.len() > LIMIT
            || frame.received_at.elapsed() > MAX_AGE
        {
            return Ok(());
        }
        if !self.tracks.contains_key(&frame.track_id) && self.tracks.len() >= 64 {
            return Err(MediaError::Consumer);
        }
        let track = self
            .tracks
            .entry(frame.track_id.clone())
            .or_insert_with(|| Track {
                participant: frame.participant_id.clone(),
                frames: VecDeque::new(),
                samples: 0,
                volume: 1.,
            });
        if track.participant != frame.participant_id {
            return Err(MediaError::Consumer);
        }
        while track.samples + frame.samples.len() > LIMIT {
            if let Some(old) = track.frames.pop_front() {
                track.samples -= old.samples.len();
            }
        }
        track.samples += frame.samples.len();
        track.frames.push_back(frame);
        Ok(())
    }

    pub fn render(&mut self, samples: usize, now: Instant) -> Result<Vec<i16>, MediaError> {
        if !matches!(samples, 480 | 960) {
            return Err(MediaError::AudioFrame);
        }
        let mut mixed = vec![0_f32; samples];
        for track in self.tracks.values_mut() {
            while track
                .frames
                .front()
                .is_some_and(|frame| now.saturating_duration_since(frame.received_at) > MAX_AGE)
            {
                track.samples -= track
                    .frames
                    .pop_front()
                    .expect("front exists")
                    .samples
                    .len();
            }
            let mut offset = 0;
            while offset < samples {
                let Some(frame) = track.frames.front_mut() else {
                    break;
                };
                let count = frame.samples.len().min(samples - offset);
                for (sample, value) in mixed[offset..offset + count]
                    .iter_mut()
                    .zip(frame.samples.drain(..count))
                {
                    *sample += f32::from(value) * track.volume;
                }
                track.samples -= count;
                offset += count;
                if frame.samples.is_empty() {
                    track.frames.pop_front();
                }
            }
        }
        Ok(mixed
            .into_iter()
            .map(|sample| sample.clamp(i16::MIN as f32, i16::MAX as f32) as i16)
            .collect())
    }

    pub fn set_volume(&mut self, track: &str, volume: f32) -> Result<(), MediaError> {
        if !volume.is_finite() || !(0. ..=2.).contains(&volume) {
            return Err(MediaError::AudioFrame);
        }
        self.tracks
            .get_mut(track)
            .ok_or(MediaError::Publication)?
            .volume = volume;
        Ok(())
    }

    pub fn remove_track(&mut self, track: &str) {
        self.tracks.remove(track);
    }
    pub fn remove_participant(&mut self, participant: &str) {
        self.tracks
            .retain(|_, track| track.participant != participant);
    }
    pub fn clear(&mut self) {
        self.tracks.clear();
    }
}

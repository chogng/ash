//! Dictation consumes either the device helper or ordered renderer PCM, never both.

use std::path::Path;
use tokio::sync::mpsc;
use voice_host::AudioConfig;
use voice_host::AudioHost;
use voice_host::Direction;
use voice_host::Processing;
use voice_host::SampleRate;

pub(super) type AudioReceiver = mpsc::Receiver<Vec<i16>>;

pub(super) enum AudioInput {
    Device(AudioHost),
    Pcm {
        receiver: AudioReceiver,
        rate: u32,
        previous: Option<i16>,
        position: u32,
    },
}

#[cfg(test)]
#[path = "audio_input_tests.rs"]
mod tests;

impl AudioInput {
    pub(super) async fn open(
        executable: &Path,
        device: Option<String>,
        rate: SampleRate,
        receiver: Option<AudioReceiver>,
    ) -> Result<Self, String> {
        if let Some(receiver) = receiver {
            return Ok(Self::Pcm {
                receiver,
                rate: rate.hz(),
                previous: None,
                position: 0,
            });
        }
        let mut audio = AudioHost::spawn(executable)
            .await
            .map_err(|error| error.to_string())?;
        audio
            .start_input(
                AudioConfig {
                    rate,
                    direction: Direction::Capture,
                    processing: Processing::Speech,
                },
                device,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self::Device(audio))
    }

    pub(super) async fn next_capture(&mut self) -> Result<Option<Vec<i16>>, String> {
        match self {
            Self::Device(audio) => audio
                .next_capture()
                .await
                .map(|capture| Some(capture.samples))
                .map_err(|error| error.to_string()),
            Self::Pcm {
                receiver,
                rate,
                previous,
                position,
            } => {
                let Some(samples) = receiver.recv().await else {
                    let Some(last) = previous.take() else {
                        return Ok(None);
                    };
                    let mut tail = Vec::new();
                    while *position < *rate {
                        tail.push(last);
                        *position += 16000;
                    }
                    return Ok(Some(tail));
                };
                if *rate == 16000 {
                    return Ok(Some(samples));
                }
                // Keep the interpolation phase across packets so boundaries cannot repeat
                // or drop samples when a provider requires 24 kHz rather than 16 kHz.
                let mut output = Vec::with_capacity(samples.len() * 3 / 2 + 2);
                for sample in samples {
                    if let Some(left) = *previous {
                        while *position < *rate {
                            let value = i64::from(left) * i64::from(*rate - *position)
                                + i64::from(sample) * i64::from(*position);
                            output.push((value / i64::from(*rate)) as i16);
                            *position += 16000;
                        }
                        *position -= *rate;
                    }
                    *previous = Some(sample);
                }
                Ok(Some(output))
            }
        }
    }

    pub(super) async fn stop(&mut self) -> Result<(), String> {
        match self {
            Self::Device(audio) => audio.stop().await.map_err(|error| error.to_string()),
            Self::Pcm { receiver, .. } => {
                receiver.close();
                Ok(())
            }
        }
    }

    pub(super) async fn close(self) -> Result<(), String> {
        match self {
            Self::Device(audio) => audio.close().await.map_err(|error| error.to_string()),
            Self::Pcm { mut receiver, .. } => {
                receiver.close();
                Ok(())
            }
        }
    }
}

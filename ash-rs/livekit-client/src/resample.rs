use crate::MediaError;
use livekit::webrtc::native::audio_resampler::AudioResampler as RtcResampler;

#[derive(Clone, Copy)]
pub enum AudioRate {
    Voice,
    Room,
}

impl AudioRate {
    fn hz(self) -> u32 {
        match self {
            Self::Voice => 24_000,
            Self::Room => 48_000,
        }
    }
}

/// Converts one 10 ms mono packet while preserving the SDK resampler's filter history.
pub struct AudioResampler {
    engine: RtcResampler,
    input: AudioRate,
    output: AudioRate,
}

impl AudioResampler {
    pub fn new(input: AudioRate, output: AudioRate) -> Self {
        Self {
            engine: RtcResampler::default(),
            input,
            output,
        }
    }

    pub fn process(&mut self, samples: &[i16]) -> Result<Vec<i16>, MediaError> {
        let count = self.input.hz() / 100;
        if samples.len() != count as usize {
            return Err(MediaError::AudioFrame);
        }
        let output =
            self.engine
                .remix_and_resample(samples, count, 1, self.input.hz(), 1, self.output.hz());
        if output.len() != (self.output.hz() / 100) as usize {
            return Err(MediaError::AudioFrame);
        }
        Ok(output.to_vec())
    }
}

use crate::MediaError;
use rubato::FixedSync;
use rubato::Resampler;
use rubato::audioadapter_buffers::direct::InterleavedSlice;

#[derive(Clone, Copy)]
pub enum AudioRate {
    Voice,
    Room,
}

impl AudioRate {
    fn hz(self) -> usize {
        match self {
            Self::Voice => 24_000,
            Self::Room => 48_000,
        }
    }
}

/// Converts one 10 ms mono packet while preserving filter history between packets.
pub struct AudioResampler {
    engine: rubato::Fft<f32>,
    input: AudioRate,
    output: AudioRate,
    buffer: Vec<f32>,
}

impl AudioResampler {
    pub fn new(input: AudioRate, output: AudioRate) -> Self {
        let engine = rubato::Fft::new(
            input.hz(),
            output.hz(),
            input.hz() / 100,
            1,
            FixedSync::Both,
        )
        .expect("fixed 24/48 kHz mono resampling is valid");
        let buffer = vec![0.0; engine.output_frames_max()];
        Self {
            engine,
            input,
            output,
            buffer,
        }
    }

    pub fn process(&mut self, samples: &[i16]) -> Result<Vec<i16>, MediaError> {
        if samples.len() != self.input.hz() / 100 {
            return Err(MediaError::AudioFrame);
        }
        let input: Vec<f32> = samples
            .iter()
            .map(|sample| f32::from(*sample) / 32768.0)
            .collect();
        let input =
            InterleavedSlice::new(&input, 1, samples.len()).map_err(|_| MediaError::AudioFrame)?;
        let output_len = self.buffer.len();
        let mut destination = InterleavedSlice::new_mut(&mut self.buffer, 1, output_len)
            .map_err(|_| MediaError::AudioFrame)?;
        let (_, written) = self
            .engine
            .process_into_buffer(&input, &mut destination, None)
            .map_err(|_| MediaError::AudioFrame)?;
        if written != self.output.hz() / 100 {
            return Err(MediaError::AudioFrame);
        }
        Ok(self.buffer[..written]
            .iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .collect())
    }
}

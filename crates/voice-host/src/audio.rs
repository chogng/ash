use crate::Processing;
use crate::SampleRate;
use rubato::Resampler;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use std::collections::VecDeque;

pub(super) struct RateConverter {
    engine: rubato::Async<f32>,
    pending: VecDeque<f32>,
    buffer: Vec<f32>,
}

impl RateConverter {
    pub(super) fn new(source: u32, destination: u32) -> Result<Self, &'static str> {
        if !(8_000..=192_000).contains(&source) || !(8_000..=192_000).contains(&destination) {
            return Err("unsupported audio rate");
        }
        let engine = rubato::Async::new_sinc(
            f64::from(destination) / f64::from(source),
            1.0,
            &rubato::SincInterpolationParameters::default(),
            source.div_ceil(100) as usize,
            1,
            rubato::FixedAsync::Input,
        )
        .map_err(|_| "audio resampler configuration failed")?;
        let buffer = vec![0.0; engine.output_frames_max()];
        Ok(Self {
            engine,
            pending: VecDeque::new(),
            buffer,
        })
    }

    pub(super) fn reset(&mut self) {
        self.engine.reset();
        self.pending.clear();
    }

    pub(super) fn push(&mut self, input: &[f32]) -> Result<Vec<f32>, &'static str> {
        if input.iter().any(|sample| !sample.is_finite())
            || self.pending.len() + input.len() > 38_400
        {
            return Err("invalid or excessive audio samples");
        }
        self.pending.extend(input.iter().copied());
        let mut output = Vec::new();
        while self.pending.len() >= self.engine.input_frames_next() {
            let input = self.pending.make_contiguous();
            let input =
                InterleavedSlice::new(input, 1, input.len()).map_err(|_| "invalid audio input")?;
            let len = self.buffer.len();
            let mut destination = InterleavedSlice::new_mut(&mut self.buffer, 1, len)
                .map_err(|_| "invalid audio output")?;
            let (read, written) = self
                .engine
                .process_into_buffer(&input, &mut destination, None)
                .map_err(|_| "audio resampling failed")?;
            self.pending.drain(..read);
            output.extend_from_slice(&self.buffer[..written]);
        }
        Ok(output)
    }
}

/// The device loop feeds the samples actually submitted to the speaker as the echo reference.
pub(super) struct CaptureProcessor {
    input: RateConverter,
    reference: RateConverter,
    output: RateConverter,
    processing: Processing,
    speech: sonora::AudioProcessing,
    near: VecDeque<f32>,
    far: VecDeque<f32>,
    packets: VecDeque<f32>,
    packet_size: usize,
}

fn speech() -> sonora::AudioProcessing {
    sonora::AudioProcessing::builder()
        .config(sonora::Config {
            echo_canceller: Some(sonora::config::EchoCanceller::default()),
            noise_suppression: Some(sonora::config::NoiseSuppression::default()),
            gain_controller2: Some(sonora::config::GainController2 {
                adaptive_digital: Some(sonora::config::AdaptiveDigital::default()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .capture_config(sonora::StreamConfig::new(48_000, 1))
        .render_config(sonora::StreamConfig::new(48_000, 1))
        .build()
}

impl CaptureProcessor {
    pub(super) fn new(
        input_rate: u32,
        output_rate: u32,
        target: SampleRate,
        processing: Processing,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            input: RateConverter::new(input_rate, 48_000)?,
            reference: RateConverter::new(output_rate, 48_000)?,
            output: RateConverter::new(48_000, target.hz())?,
            processing,
            speech: speech(),
            near: VecDeque::new(),
            far: VecDeque::new(),
            packets: VecDeque::new(),
            packet_size: target.packet_samples(),
        })
    }

    pub(super) fn reset(&mut self) {
        self.input.reset();
        self.reference.reset();
        self.output.reset();
        self.near.clear();
        self.far.clear();
        self.packets.clear();
        self.speech = speech();
    }

    pub(super) fn reset_render(&mut self) {
        self.reference.reset();
        self.far.clear();
        self.speech = speech();
    }

    pub(super) fn render(&mut self, samples: &[f32], delay_ms: u32) -> Result<(), &'static str> {
        if delay_ms > 200 {
            return Err("speaker latency exceeds audio budget");
        }
        self.speech
            .set_stream_delay_ms(delay_ms as i32)
            .map_err(|_| "invalid echo delay")?;
        self.far.extend(self.reference.push(samples)?);
        while self.far.len() >= 480 {
            let frame: Vec<f32> = self.far.drain(..480).collect();
            if self.processing == Processing::Speech {
                let mut scratch = [0.0; 480];
                self.speech
                    .process_render_f32(&[&frame], &mut [&mut scratch])
                    .map_err(|_| "echo reference failed")?;
            }
        }
        Ok(())
    }

    pub(super) fn capture(&mut self, samples: &[f32]) -> Result<Vec<Vec<i16>>, &'static str> {
        self.near.extend(self.input.push(samples)?);
        while self.near.len() >= 480 {
            let frame: Vec<f32> = self.near.drain(..480).collect();
            let mut clean = [0.0; 480];
            if self.processing == Processing::Speech {
                self.speech
                    .process_capture_f32(&[&frame], &mut [&mut clean])
                    .map_err(|_| "speech processing failed")?;
            } else {
                clean.copy_from_slice(&frame);
            }
            self.packets.extend(self.output.push(&clean)?);
        }
        let mut result = Vec::new();
        while self.packets.len() >= self.packet_size {
            result.push(
                self.packets
                    .drain(..self.packet_size)
                    .map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16)
                    .collect(),
            );
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;

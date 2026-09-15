use super::AudioDevice;
use super::audio::CaptureProcessor;
use super::audio::RateConverter;
use crate::AudioConfig;
use crate::CaptureState;
use crate::Direction;
use cpal::FromSample;
use cpal::SizedSample;
use cpal::traits::DeviceTrait;
use cpal::traits::HostTrait;
use cpal::traits::StreamTrait;
use crossbeam_queue::ArrayQueue;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

const BLOCK: usize = 256;
const AGE: Duration = Duration::from_millis(200);

struct Block {
    epoch: u64,
    at: Instant,
    delay_ms: u32,
    samples: [f32; BLOCK],
    len: usize,
}

struct Shared {
    clock: Instant,
    capture_cutoff: AtomicU64,
    capture_epoch: AtomicU64,
    playback_epoch: AtomicU64,
    recording: AtomicBool,
    failed: AtomicBool,
    input: ArrayQueue<Block>,
    reference: ArrayQueue<Block>,
    output: ArrayQueue<(u64, f32)>,
}

impl Shared {
    fn capture_allowed(&self, at: Instant, epoch: u64) -> bool {
        self.recording.load(Ordering::Acquire)
            && self.capture_epoch.load(Ordering::Acquire) == epoch
            && at >= self.clock + Duration::from_nanos(self.capture_cutoff.load(Ordering::Acquire))
    }

    fn new(epoch: u64, input_rate: u32, output_rate: u32) -> Self {
        Self {
            clock: Instant::now(),
            capture_cutoff: AtomicU64::new(0),
            capture_epoch: AtomicU64::new(epoch),
            playback_epoch: AtomicU64::new(epoch),
            recording: AtomicBool::new(true),
            failed: AtomicBool::new(false),
            input: ArrayQueue::new((input_rate as usize / 5).div_ceil(BLOCK) + 8),
            reference: ArrayQueue::new((output_rate as usize / 5).div_ceil(BLOCK) + 8),
            output: ArrayQueue::new(output_rate as usize / 5),
        }
    }
}

pub(super) struct Devices {
    // Drop streams before their buffers; callbacks hold their own Arc until teardown finishes.
    _input: Option<cpal::Stream>,
    _output: Option<cpal::Stream>,
    shared: Arc<Shared>,
    processor: CaptureProcessor,
    playback: RateConverter,
    direction: Direction,
}

fn configuration(
    device: &cpal::Device,
    input: bool,
) -> Result<cpal::SupportedStreamConfig, &'static str> {
    let config = if input {
        device.default_input_config()
    } else {
        device.default_output_config()
    }
    .map_err(|_| "audio configuration unavailable")?;
    if !(8_000..=192_000).contains(&config.sample_rate()) || !(1..=8).contains(&config.channels()) {
        return Err("unsupported device rate or channel count");
    }
    Ok(config)
}

impl Devices {
    pub(super) fn open(config: AudioConfig, epoch: u64) -> Result<Self, &'static str> {
        let host = cpal::default_host();
        let input = if config.direction != Direction::Playback {
            let device = host
                .default_input_device()
                .ok_or("microphone unavailable")?;
            let settings = configuration(&device, true)?;
            Some((device, settings))
        } else {
            None
        };
        let output = if config.direction != Direction::Capture {
            let device = host.default_output_device().ok_or("speaker unavailable")?;
            let settings = configuration(&device, false)?;
            Some((device, settings))
        } else {
            None
        };
        let input_rate = input.as_ref().map_or(48_000, |(_, c)| c.sample_rate());
        let output_rate = output.as_ref().map_or(48_000, |(_, c)| c.sample_rate());
        let shared = Arc::new(Shared::new(epoch, input_rate, output_rate));
        let processor =
            CaptureProcessor::new(input_rate, output_rate, config.rate, config.processing)?;
        let playback = RateConverter::new(config.rate.hz(), output_rate)?;
        let input = input
            .map(|(d, c)| make_stream(&d, &c, shared.clone(), Direction::Capture))
            .transpose()?;
        let output = output
            .map(|(d, c)| make_stream(&d, &c, shared.clone(), Direction::Playback))
            .transpose()?;
        if let Some(stream) = &output {
            stream.play().map_err(|_| "speaker start failed")?;
        }
        if let Some(stream) = &input {
            stream.play().map_err(|_| "microphone start failed")?;
        }
        Ok(Self {
            _input: input,
            _output: output,
            shared,
            processor,
            playback,
            direction: config.direction,
        })
    }
}

impl AudioDevice for Devices {
    fn capture(&mut self) -> Result<Vec<Vec<i16>>, &'static str> {
        if self.shared.failed.load(Ordering::Acquire) {
            return Err("audio stream failed or exceeded its queue budget");
        }
        let epoch = self.shared.capture_epoch.load(Ordering::Acquire);
        while let Some(block) = self.shared.reference.pop() {
            if block.epoch == self.shared.playback_epoch.load(Ordering::Acquire) {
                if block.at.elapsed() > AGE {
                    return Err("echo reference expired");
                }
                self.processor
                    .render(&block.samples[..block.len], block.delay_ms)?;
            }
        }
        let mut packets = Vec::new();
        while let Some(block) = self.shared.input.pop() {
            if block.epoch == epoch && self.shared.recording.load(Ordering::Acquire) {
                if block.at.elapsed() > AGE {
                    return Err("microphone samples expired");
                }
                packets.extend(self.processor.capture(&block.samples[..block.len])?);
            }
        }
        Ok(packets)
    }

    fn play(&mut self, samples: &[i16]) -> Result<(), &'static str> {
        if self.direction == Direction::Capture {
            return Err("session has no speaker");
        }
        let converted = self.playback.push(
            &samples
                .iter()
                .map(|&s| f32::from(s) / 32768.0)
                .collect::<Vec<_>>(),
        )?;
        if converted.len() > self.shared.output.capacity() - self.shared.output.len() {
            return Err("speaker queue is full");
        }
        let epoch = self.shared.playback_epoch.load(Ordering::Acquire);
        for sample in converted {
            self.shared
                .output
                .push((epoch, sample.clamp(-1.0, 1.0)))
                .map_err(|_| "speaker queue is full")?;
        }
        Ok(())
    }

    fn set_capture(&mut self, epoch: u64, capture: CaptureState) {
        self.shared.recording.store(false, Ordering::Release);
        self.shared.capture_cutoff.store(
            self.shared
                .clock
                .elapsed()
                .as_nanos()
                .min(u128::from(u64::MAX)) as u64,
            Ordering::Release,
        );
        self.shared.capture_epoch.store(epoch, Ordering::Release);
        while self.shared.input.pop().is_some() {}
        self.processor.reset();
        self.shared
            .recording
            .store(capture == CaptureState::Recording, Ordering::Release);
    }

    fn interrupt(&mut self, epoch: u64) {
        self.shared.playback_epoch.store(epoch, Ordering::Release);
        while self.shared.output.pop().is_some() {}
        while self.shared.reference.pop().is_some() {}
        self.playback.reset();
        self.processor.reset_render();
    }
}

fn make_stream(
    device: &cpal::Device,
    settings: &cpal::SupportedStreamConfig,
    shared: Arc<Shared>,
    direction: Direction,
) -> Result<cpal::Stream, &'static str> {
    macro_rules! stream {
        ($t:ty) => {
            match direction {
                Direction::Capture => input::<$t>(device, settings, shared),
                Direction::Playback => output::<$t>(device, settings, shared),
                Direction::Duplex => unreachable!(),
            }
        };
    }
    match settings.sample_format() {
        cpal::SampleFormat::F32 => stream!(f32),
        cpal::SampleFormat::F64 => stream!(f64),
        cpal::SampleFormat::I8 => stream!(i8),
        cpal::SampleFormat::I16 => stream!(i16),
        cpal::SampleFormat::I32 => stream!(i32),
        cpal::SampleFormat::I64 => stream!(i64),
        cpal::SampleFormat::U8 => stream!(u8),
        cpal::SampleFormat::U16 => stream!(u16),
        cpal::SampleFormat::U32 => stream!(u32),
        cpal::SampleFormat::U64 => stream!(u64),
        _ => return Err("unsupported device sample format"),
    }
    .map_err(|_| "audio stream creation failed")
}

fn input<T: SizedSample>(
    device: &cpal::Device,
    settings: &cpal::SupportedStreamConfig,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, cpal::Error>
where
    f32: FromSample<T>,
{
    let channels = settings.channels() as usize;
    let failed = shared.clone();
    device.build_input_stream(
        settings.config(),
        move |samples: &[T], info: &cpal::InputCallbackInfo| {
            if !shared.recording.load(Ordering::Acquire) {
                return;
            }
            let epoch = shared.capture_epoch.load(Ordering::Acquire);
            let stamp = info.timestamp();
            let Some(delay) = stamp.callback.checked_duration_since(stamp.capture) else {
                shared.failed.store(true, Ordering::Release);
                return;
            };
            if delay > AGE {
                shared.failed.store(true, Ordering::Release);
                return;
            }
            let Some(at) = Instant::now().checked_sub(delay) else {
                shared.failed.store(true, Ordering::Release);
                return;
            };
            if !shared.capture_allowed(at, epoch) {
                return;
            }
            for chunk in samples.chunks(BLOCK * channels) {
                let mut block = Block {
                    epoch,
                    at,
                    delay_ms: 0,
                    samples: [0.0; BLOCK],
                    len: 0,
                };
                for frame in chunk.chunks_exact(channels) {
                    let value =
                        frame.iter().map(|&s| s.to_sample::<f32>()).sum::<f32>() / channels as f32;
                    if !value.is_finite() {
                        shared.failed.store(true, Ordering::Release);
                        return;
                    }
                    block.samples[block.len] = value;
                    block.len += 1;
                }
                if shared.input.push(block).is_err() {
                    shared.failed.store(true, Ordering::Release);
                    break;
                }
            }
        },
        move |_| {
            failed.failed.store(true, Ordering::Release);
        },
        None,
    )
}

fn output<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    settings: &cpal::SupportedStreamConfig,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, cpal::Error> {
    let channels = settings.channels() as usize;
    let failed = shared.clone();
    device.build_output_stream(
        settings.config(),
        move |samples: &mut [T], info: &cpal::OutputCallbackInfo| {
            let epoch = shared.playback_epoch.load(Ordering::Acquire);
            let stamp = info.timestamp();
            let Some(delay) = stamp.playback.checked_duration_since(stamp.callback) else {
                samples.fill(T::from_sample(0.0));
                shared.failed.store(true, Ordering::Release);
                return;
            };
            let delay_ms = delay.as_millis().min(u128::from(u32::MAX)) as u32;
            for chunk in samples.chunks_mut(BLOCK * channels) {
                let mut reference = Block {
                    epoch,
                    at: Instant::now(),
                    delay_ms,
                    samples: [0.0; BLOCK],
                    len: 0,
                };
                for frame in chunk.chunks_mut(channels) {
                    let value = match shared.output.pop() {
                        Some((generation, sample))
                            if generation == shared.playback_epoch.load(Ordering::Acquire) =>
                        {
                            sample
                        }
                        _ => 0.0,
                    };
                    frame.fill(T::from_sample(value));
                    reference.samples[reference.len] = value;
                    reference.len += 1;
                }
                if shared.reference.push(reference).is_err() {
                    shared.failed.store(true, Ordering::Release);
                }
            }
        },
        move |_| {
            failed.failed.store(true, Ordering::Release);
        },
        None,
    )
}

#[cfg(test)]
#[path = "devices_tests.rs"]
mod tests;

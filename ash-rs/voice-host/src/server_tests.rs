use super::*;
use crate::Direction;
use crate::Processing;
use crate::SampleRate;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct Device {
    dropped: Arc<AtomicUsize>,
    processor: audio::CaptureProcessor,
    playback: Vec<i16>,
}
impl AudioDevice for Device {
    fn capture(&mut self) -> Result<Vec<Vec<i16>>, &'static str> {
        self.processor.capture(&[0.1; 960])
    }
    fn play(&mut self, samples: &[i16]) -> Result<(), &'static str> {
        self.playback.extend(samples);
        Ok(())
    }
    fn set_capture(&mut self, _: u64, _: CaptureState) {
        self.processor.reset();
    }
    fn interrupt(&mut self, _: u64) {
        self.playback.clear();
        self.processor.reset_render();
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

fn unused(_: AudioConfig, _: u64) -> Result<Device, &'static str> {
    panic!("must not open devices")
}

#[test]
fn session_controls_invalidate_old_audio_and_drop_devices_before_reply() {
    let mut controller = Controller::<Device>::new();
    assert!(controller.execute(Operation::Stop, unused).is_err());
    controller
        .execute(
            Operation::Hello {
                version: wire::VERSION,
            },
            unused,
        )
        .unwrap();
    let dropped = Arc::new(AtomicUsize::new(0));
    let config = AudioConfig {
        rate: SampleRate::Hz24000,
        direction: Direction::Duplex,
        processing: Processing::Unprocessed,
    };
    controller
        .execute(Operation::Start { config }, |config, _| {
            Ok(Device {
                dropped: dropped.clone(),
                processor: audio::CaptureProcessor::new(
                    48_000,
                    48_000,
                    config.rate,
                    config.processing,
                )?,
                playback: Vec::new(),
            })
        })
        .unwrap();
    assert!(
        controller
            .execute(Operation::Start { config }, unused)
            .is_err()
    );
    let old = controller.epoch;
    let capture_epoch = controller.capture_epoch;
    controller
        .execute(
            Operation::Play {
                epoch: old,
                samples: vec![5; 480],
            },
            unused,
        )
        .unwrap();
    controller.execute(Operation::Interrupt, unused).unwrap();
    assert_eq!(controller.capture_epoch, capture_epoch);
    assert!(controller.device.as_ref().unwrap().playback.is_empty());
    assert!(
        controller
            .execute(
                Operation::Play {
                    epoch: old,
                    samples: vec![5; 480]
                },
                unused
            )
            .is_err()
    );
    let playback_epoch = controller.playback_epoch;
    controller
        .execute(
            Operation::Play {
                epoch: playback_epoch,
                samples: vec![7; 480],
            },
            unused,
        )
        .unwrap();
    controller
        .execute(
            Operation::Capture {
                state: CaptureState::Muted,
            },
            unused,
        )
        .unwrap();
    assert_eq!(controller.playback_epoch, playback_epoch);
    assert_eq!(controller.device.as_ref().unwrap().playback.len(), 480);
    for _ in 0..10 {
        assert!(controller.poll().unwrap().is_empty());
    }
    controller
        .execute(
            Operation::Capture {
                state: CaptureState::Recording,
            },
            unused,
        )
        .unwrap();
    let packets: Vec<_> = (0..10).flat_map(|_| controller.poll().unwrap()).collect();
    assert!(!packets.is_empty());
    assert!(
        packets
            .iter()
            .all(|p| p.epoch == controller.capture_epoch && p.samples.len() == 480)
    );
    controller.execute(Operation::Stop, unused).unwrap();
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(controller.poll().unwrap().is_empty());
    assert!(
        controller
            .execute(
                Operation::Hello {
                    version: wire::VERSION
                },
                unused
            )
            .is_err()
    );
}

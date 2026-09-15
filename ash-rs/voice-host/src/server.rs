//! Device-owning process entry point. No network, service credentials or model protocol.

#[path = "audio.rs"]
mod audio;
#[path = "devices.rs"]
mod devices;

use crate::wire;
use crate::wire::AudioConfig;
use crate::wire::Capture;
use crate::wire::CaptureState;
use crate::wire::Event;
use crate::wire::Operation;
use crate::wire::Request;
use std::io;
use std::sync::mpsc;
use std::time::Duration;

/// The session boundary lets the same controller run against real devices and deterministic audio.
trait AudioDevice {
    fn capture(&mut self) -> Result<Vec<Vec<i16>>, &'static str>;
    fn play(&mut self, samples: &[i16]) -> Result<(), &'static str>;
    fn set_capture(&mut self, epoch: u64, capture: CaptureState);
    fn interrupt(&mut self, epoch: u64);
}

struct Controller<D> {
    device: Option<D>,
    config: Option<AudioConfig>,
    epoch: u64,
    capture_epoch: u64,
    playback_epoch: u64,
    sequence: u64,
    capture: CaptureState,
    greeted: bool,
}

impl<D: AudioDevice> Controller<D> {
    fn new() -> Self {
        Self {
            device: None,
            config: None,
            epoch: 0,
            capture_epoch: 0,
            playback_epoch: 0,
            sequence: 0,
            capture: CaptureState::Recording,
            greeted: false,
        }
    }

    fn advance(&mut self) -> Result<(), &'static str> {
        self.epoch = self.epoch.checked_add(1).ok_or("session epoch exhausted")?;
        Ok(())
    }

    fn execute(
        &mut self,
        op: Operation,
        open: impl FnOnce(AudioConfig, u64) -> Result<D, &'static str>,
    ) -> Result<(), &'static str> {
        if !self.greeted {
            return match op {
                Operation::Hello {
                    version: wire::VERSION,
                } => {
                    self.greeted = true;
                    Ok(())
                }
                _ => Err("audio protocol version must be negotiated first"),
            };
        }
        match op {
            Operation::Start { config } => {
                if self.device.is_some() {
                    return Err("audio session already active");
                }
                self.capture = CaptureState::Recording;
                self.advance()?;
                self.capture_epoch = self.epoch;
                self.playback_epoch = self.epoch;
                let device = open(config, self.epoch)?;
                self.device = Some(device);
                self.config = Some(config);
                self.sequence = 0;
            }
            Operation::Capture { state } => {
                if self.device.is_none() {
                    return Err("no audio session");
                }
                self.capture = state;
                self.advance()?;
                self.capture_epoch = self.epoch;
                self.device
                    .as_mut()
                    .ok_or("no audio session")?
                    .set_capture(self.epoch, state);
            }
            Operation::Play { epoch, samples } => {
                let config = self.config.ok_or("no audio session")?;
                if epoch != self.playback_epoch {
                    return Err("expired playback epoch");
                }
                if samples.len() != config.rate.packet_samples() {
                    return Err("expected twenty milliseconds of mono PCM16");
                }
                self.device
                    .as_mut()
                    .ok_or("no audio session")?
                    .play(&samples)?;
            }
            Operation::Interrupt => {
                if self.device.is_none() {
                    return Err("no audio session");
                }
                self.advance()?;
                self.playback_epoch = self.epoch;
                self.device
                    .as_mut()
                    .ok_or("no audio session")?
                    .interrupt(self.epoch);
            }
            Operation::Stop | Operation::Shutdown => {
                self.device = None; // Stop releases device handles before acknowledging.
                self.config = None;
                self.advance()?;
            }
            Operation::Hello { .. } => return Err("audio protocol already negotiated"),
        }
        Ok(())
    }

    fn poll(&mut self) -> Result<Vec<Capture>, &'static str> {
        let Some(device) = &mut self.device else {
            return Ok(Vec::new());
        };
        let packets = device.capture()?;
        let mut result = Vec::with_capacity(packets.len());
        for samples in packets {
            self.sequence = self
                .sequence
                .checked_add(1)
                .ok_or("capture sequence exhausted")?;
            if self.capture == CaptureState::Recording {
                result.push(Capture {
                    epoch: self.capture_epoch,
                    sequence: self.sequence,
                    samples,
                });
            }
        }
        Ok(result)
    }
}

pub fn run() -> io::Result<()> {
    let (requests_tx, requests) = mpsc::sync_channel(32);
    std::thread::Builder::new()
        .name("audio-control".into())
        .spawn(move || {
            let mut input = io::stdin().lock();
            loop {
                match wire::read::<Request>(&mut input) {
                    Ok(Some(request)) => {
                        if requests_tx.try_send(request).is_err() {
                            std::process::exit(1);
                        }
                    }
                    // OS teardown releases devices even when a platform device-open call is stuck.
                    Ok(None) => std::process::exit(0),
                    Err(_) => std::process::exit(1),
                }
            }
        })?;
    let (events, output) = mpsc::sync_channel(32);
    let writer = std::thread::Builder::new()
        .name("audio-events".into())
        .spawn(move || {
            let mut stdout = io::stdout().lock();
            for event in output {
                if wire::write(&mut stdout, &event).is_err() {
                    std::process::exit(1);
                }
            }
        })?;
    let mut controller = Controller::<devices::Devices>::new();
    let mut last_id = 0;
    loop {
        // Service controls before collecting the next microphone batch.
        for _ in 0..32 {
            let request = match requests.try_recv() {
                Ok(request) => request,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(_) => return Ok(()),
            };
            if request.id <= last_id {
                return Err(wire::invalid());
            }
            last_id = request.id;
            let shutdown = matches!(request.operation, Operation::Shutdown);
            let error = controller
                .execute(request.operation, devices::Devices::open)
                .err()
                .map(str::to_owned);
            let failed = error.is_some();
            events
                .try_send(Event::Reply {
                    id: request.id,
                    epoch: controller.epoch,
                    error,
                })
                .map_err(|_| wire::invalid())?;
            if shutdown && !failed {
                drop(events);
                writer.join().map_err(|_| wire::invalid())?;
                return Ok(());
            }
        }
        match controller.poll() {
            Ok(packets) => {
                for audio in packets {
                    match events.try_send(Event::Capture { audio }) {
                        Ok(()) | Err(mpsc::TrySendError::Full(_)) => {}
                        Err(_) => return Err(wire::invalid()),
                    }
                }
            }
            Err(_) => {
                controller.device = None;
                let _ = events.try_send(Event::Failed);
                return Err(io::Error::other("audio device failed"));
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

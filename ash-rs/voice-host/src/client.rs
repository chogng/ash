use crate::AudioError;
use crate::wire;
use crate::wire::AudioConfig;
use crate::wire::Capture;
use crate::wire::CaptureState;
use crate::wire::Event;
use crate::wire::Operation;
use crate::wire::Request;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(5);

struct RequestGuard<'a> {
    child: &'a mut Child,
    reader: &'a JoinHandle<()>,
    retired: &'a mut bool,
    complete: bool,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
            *self.retired = true;
            self.reader.abort();
            let _ = self.child.start_kill();
        }
    }
}

/// Owns one helper process. Control methods are serialized; capture is read independently.
/// Dropping the owner closes the pipe and kills the helper, including cancelled requests.
pub struct AudioHost {
    child: Child,
    input: ChildStdin,
    reader: JoinHandle<()>,
    replies: mpsc::Receiver<(u64, u64, Option<String>)>,
    audio: mpsc::Receiver<(Instant, Capture)>,
    next_id: u64,
    capture_epoch: u64,
    playback_epoch: u64,
    config: Option<AudioConfig>,
    retired: bool,
}

impl AudioHost {
    /// Launch an explicitly selected physical executable; no PATH search or runtime discovery.
    pub async fn spawn(executable: &Path) -> Result<Self, AudioError> {
        if !executable.is_absolute()
            || executable.canonicalize()? != executable
            || !executable.is_file()
        {
            return Err(AudioError::Protocol);
        }
        let mut command = Command::new(executable);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Preserve OS device/session variables, but never inject a caller's dynamic libraries.
        for key in [
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FRAMEWORK_PATH",
        ] {
            command.env_remove(key);
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or(AudioError::Protocol)?;
        let mut output = child.stdout.take().ok_or(AudioError::Protocol)?;
        let (reply_tx, replies) = mpsc::channel(16);
        let (audio_tx, audio) = mpsc::channel(8);
        let reader = tokio::spawn(async move {
            loop {
                let Ok(len) = output.read_u32_le().await else {
                    break;
                };
                if len == 0 || len as usize > wire::MAX_BYTES {
                    break;
                }
                let mut bytes = vec![0; len as usize];
                if output.read_exact(&mut bytes).await.is_err() {
                    break;
                }
                match serde_json::from_slice::<Event>(&bytes) {
                    Ok(Event::Reply { id, epoch, error }) => {
                        if reply_tx.try_send((id, epoch, error)).is_err() {
                            break;
                        }
                    }
                    Ok(Event::Capture { audio }) if audio.samples.len() <= 960 => {
                        // A slow consumer loses live audio instead of accumulating old speech.
                        if let Err(mpsc::error::TrySendError::Closed(_)) =
                            audio_tx.try_send((Instant::now(), audio))
                        {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        });
        let mut host = Self {
            child,
            input,
            reader,
            replies,
            audio,
            next_id: 0,
            capture_epoch: 0,
            playback_epoch: 0,
            config: None,
            retired: false,
        };
        host.request(Operation::Hello {
            version: wire::VERSION,
        })
        .await?;
        Ok(host)
    }

    async fn request(&mut self, operation: Operation) -> Result<u64, AudioError> {
        if self.retired {
            return Err(AudioError::Protocol);
        }
        self.next_id = self.next_id.checked_add(1).ok_or(AudioError::Protocol)?;
        let id = self.next_id;
        let bytes = wire::encode(&Request { id, operation })?;
        // Cancellation may interrupt a partial pipe write. Such a connection cannot be reused.
        let mut guard = RequestGuard {
            child: &mut self.child,
            reader: &self.reader,
            retired: &mut self.retired,
            complete: false,
        };
        let result = timeout(DEADLINE, async {
            self.input.write_all(&bytes).await?;
            loop {
                let (reply, epoch, error) =
                    self.replies.recv().await.ok_or(AudioError::Protocol)?;
                if reply != id {
                    return Err(AudioError::Protocol);
                }
                return match error {
                    Some(error) => Err(AudioError::Rejected(error)),
                    None => Ok(epoch),
                };
            }
        })
        .await
        .map_err(|_| AudioError::Timeout)?;
        guard.complete = result.is_ok() || matches!(result, Err(AudioError::Rejected(_)));
        result
    }

    pub async fn start(&mut self, config: AudioConfig) -> Result<(), AudioError> {
        let epoch = self.request(Operation::Start { config }).await?;
        self.capture_epoch = epoch;
        self.playback_epoch = epoch;
        self.config = Some(config);
        Ok(())
    }

    pub async fn set_capture(&mut self, state: CaptureState) -> Result<(), AudioError> {
        self.capture_epoch = self.request(Operation::Capture { state }).await?;
        while self.audio.try_recv().is_ok() {}
        Ok(())
    }

    pub async fn play(&mut self, samples: &[i16]) -> Result<(), AudioError> {
        let config = self.config.ok_or(AudioError::Inactive)?;
        if samples.len() != config.rate.packet_samples() {
            return Err(AudioError::Protocol);
        }
        self.request(Operation::Play {
            epoch: self.playback_epoch,
            samples: samples.to_vec(),
        })
        .await?;
        Ok(())
    }

    /// Stops queued playback immediately and invalidates packets prepared for the previous epoch.
    pub async fn interrupt(&mut self) -> Result<(), AudioError> {
        self.playback_epoch = self.request(Operation::Interrupt).await?;
        Ok(())
    }

    pub async fn next_capture(&mut self) -> Result<Capture, AudioError> {
        let config = self.config.ok_or(AudioError::Inactive)?;
        loop {
            let (arrival, audio) = self.audio.recv().await.ok_or(AudioError::Protocol)?;
            if arrival.elapsed() <= Duration::from_millis(200)
                && audio.epoch == self.capture_epoch
                && audio.samples.len() == config.rate.packet_samples()
            {
                return Ok(audio);
            }
        }
    }

    pub async fn stop(&mut self) -> Result<(), AudioError> {
        self.request(Operation::Stop).await?;
        self.config = None;
        while self.audio.try_recv().is_ok() {}
        Ok(())
    }

    pub async fn close(mut self) -> Result<(), AudioError> {
        // Cancellation already terminated the helper; cleanup must reap it without
        // sending another command over the invalidated pipe.
        let retired = self.retired;
        if !retired {
            self.request(Operation::Shutdown).await?;
        }
        let status = timeout(DEADLINE, self.child.wait())
            .await
            .map_err(|_| AudioError::Timeout)??;
        if !retired && !status.success() {
            return Err(AudioError::Protocol);
        }
        Ok(())
    }
}

impl Drop for AudioHost {
    fn drop(&mut self) {
        self.reader.abort();
        let _ = self.child.start_kill();
    }
}

#[cfg(all(test, unix))]
#[path = "client_tests.rs"]
mod tests;

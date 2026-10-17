use crate::AudioFrame;
use crate::AudioPublication;
use crate::MediaError;
use crate::MediaEvent;
use crate::MediaStats;
use crate::ScreenFrame;
use crate::ScreenSource;
use crate::ScreenTarget;
use crate::protocol;
use crate::protocol::Request;
use crate::protocol::Response;
use ash_external_ext::CancelReason;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocationHandle;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// One media resource in one provider incarnation. Dropping it releases the process;
/// an async consumer cancelling `next_event` never steals a pending control event.
pub struct MediaRoom {
    worker: Arc<ExtensionHostSupervisor>,
    events: mpsc::Receiver<MediaEvent>,
    audio: mpsc::Receiver<AudioFrame>,
    video: mpsc::Receiver<ScreenFrame>,
    pump: tokio::task::JoinHandle<()>,
}

impl MediaRoom {
    pub async fn connect(
        executable: &Path,
        server_url: &str,
        token: &str,
        publication: AudioPublication,
    ) -> Result<Self, MediaError> {
        crate::validate_url(server_url)?;
        let executable = executable.to_owned();
        let worker = tokio::task::spawn_blocking(move || open(&executable))
            .await
            .map_err(|_| MediaError::Connection)??;
        done(
            request_async(
                &worker,
                Request::Connect {
                    server_url: server_url.into(),
                    token: token.into(),
                    publication,
                },
            )
            .await?,
        )?;
        let (event_tx, events) = mpsc::channel(64);
        let (audio_tx, audio) = mpsc::channel(128);
        let (video_tx, video) = mpsc::channel(2);
        let source = Arc::clone(&worker);
        let pump = tokio::spawn(async move {
            loop {
                match request_async(&source, Request::Poll).await {
                    Ok(Response::Event(Some(MediaEvent::Audio(frame)))) => {
                        let _ = audio_tx.try_send(frame);
                    }
                    Ok(Response::Event(Some(MediaEvent::Video(frame)))) => {
                        let _ = video_tx.try_send(frame);
                    }
                    Ok(Response::Event(Some(event))) => {
                        let closed = matches!(event, MediaEvent::Disconnected);
                        if event_tx.send(event).await.is_err() || closed {
                            break;
                        }
                    }
                    Ok(Response::Event(None)) => {}
                    Ok(Response::Done | Response::Stats(_) | Response::ScreenSources(_))
                    | Err(_) => {
                        let _ = event_tx.send(MediaEvent::Disconnected).await;
                        break;
                    }
                }
            }
        });
        Ok(Self {
            worker,
            events,
            audio,
            video,
            pump,
        })
    }

    pub async fn send_audio(&self, samples: &[i16]) -> Result<(), MediaError> {
        if !matches!(samples.len(), 480 | 960) {
            return Err(MediaError::AudioFrame);
        }
        done(
            request_async(
                &self.worker,
                Request::SendAudio {
                    samples: samples.into(),
                },
            )
            .await?,
        )
    }
    pub fn mute(&self) -> Result<(), MediaError> {
        done(request(&self.worker, Request::Mute { muted: true })?)
    }
    pub fn unmute(&self) -> Result<(), MediaError> {
        done(request(&self.worker, Request::Mute { muted: false })?)
    }
    pub async fn stats(&self) -> Result<MediaStats, MediaError> {
        match request_async(&self.worker, Request::Stats).await? {
            Response::Stats(stats) => Ok(stats),
            Response::Done | Response::Event(_) | Response::ScreenSources(_) => {
                Err(MediaError::Protocol)
            }
        }
    }
    pub async fn next_event(&mut self) -> Option<MediaEvent> {
        tokio::select! {
            biased;
            event = self.events.recv() => event,
            frame = self.audio.recv() => frame.map(MediaEvent::Audio),
            frame = self.video.recv() => frame.map(MediaEvent::Video),
        }
    }
    pub async fn next_audio(&mut self) -> Option<AudioFrame> {
        loop {
            if let MediaEvent::Audio(frame) = self.next_event().await? {
                return Some(frame);
            }
        }
    }
    pub async fn start_screen_share(
        &mut self,
        target: ScreenTarget,
        fps: u32,
    ) -> Result<(), MediaError> {
        done(request_async(&self.worker, Request::ShareScreen { target, fps }).await?)?;
        Ok(())
    }
    pub async fn stop_screen_share(&mut self) -> Result<(), MediaError> {
        done(request_async(&self.worker, Request::StopScreen).await?)?;
        Ok(())
    }
    pub async fn close(self) -> Result<(), MediaError> {
        self.pump.abort();
        done(request_async(&self.worker, Request::Close).await?)
    }
}
impl Drop for MediaRoom {
    fn drop(&mut self) {
        self.pump.abort();
        let _ = self.worker.shutdown();
    }
}

pub fn screen_sources(executable: &Path) -> Result<Vec<ScreenSource>, MediaError> {
    let worker = open(executable)?;
    let response = request(&worker, Request::ScreenSources);
    let _ = worker.shutdown();
    match response? {
        Response::ScreenSources(sources) => Ok(sources),
        Response::Done | Response::Event(_) | Response::Stats(_) => Err(MediaError::Protocol),
    }
}

pub(crate) fn done(response: Response) -> Result<(), MediaError> {
    match response {
        Response::Done => Ok(()),
        Response::Event(_) | Response::Stats(_) | Response::ScreenSources(_) => {
            Err(MediaError::Protocol)
        }
    }
}

fn open(executable: &Path) -> Result<Arc<ExtensionHostSupervisor>, MediaError> {
    ExtensionHostSupervisor::start_product_resource(
        executable,
        protocol::EXTENSION_ID,
        protocol::MAX_PAYLOAD_BYTES,
    )
    .map(Arc::new)
    .map_err(|_| MediaError::Unavailable)
}
fn request(worker: &ExtensionHostSupervisor, value: Request) -> Result<Response, MediaError> {
    let handle = worker
        .begin_data_channel(
            protocol::CHANNEL_ID,
            serde_json::to_value(value).map_err(|_| MediaError::Protocol)?,
            Duration::from_secs(30),
        )
        .map_err(|_| MediaError::Connection)?;
    let result = handle.wait().map_err(|_| MediaError::Connection)?;
    serde_json::from_value(result.payload).map_err(|_| MediaError::Protocol)?
}
async fn request_async(
    worker: &ExtensionHostSupervisor,
    value: Request,
) -> Result<Response, MediaError> {
    let handle = Arc::new(
        worker
            .begin_data_channel(
                protocol::CHANNEL_ID,
                serde_json::to_value(value).map_err(|_| MediaError::Protocol)?,
                Duration::from_secs(30),
            )
            .map_err(|_| MediaError::Connection)?,
    );
    let cancel = Cancel(Arc::clone(&handle));
    let result = tokio::task::spawn_blocking(move || handle.wait())
        .await
        .map_err(|_| MediaError::Connection)?
        .map_err(|_| MediaError::Connection)?;
    drop(cancel);
    serde_json::from_value(result.payload).map_err(|_| MediaError::Protocol)?
}
struct Cancel(Arc<ExtensionInvocationHandle>);
impl Drop for Cancel {
    fn drop(&mut self) {
        let _ = self.0.cancel(CancelReason::Caller);
    }
}

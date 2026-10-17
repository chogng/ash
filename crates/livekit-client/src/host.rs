use external_ext_sdk::CancellationToken;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use livekit_client::MediaError;
use livekit_client::MediaEvent;
use livekit_client::ScreenSource;
use livekit_client::ScreenTarget;
use livekit_client::backend::MediaRoom;
use livekit_client::protocol::Request;
use livekit_client::protocol::Response;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

/// SDK callbacks share one resource owner. Activation itself opens no device or connection.
pub struct RoomHost(Arc<Shared>);
struct Shared {
    state: Mutex<State>,
    runtime: tokio::runtime::Runtime,
}
enum State {
    Idle,
    Starting,
    Room(Arc<Room>),
}
struct Room {
    commands: mpsc::Sender<Job>,
    events: tokio::sync::Mutex<mpsc::Receiver<MediaEvent>>,
    finished: tokio::sync::watch::Receiver<Option<Result<(), MediaError>>>,
}
struct Job {
    request: Request,
    token: CancellationToken,
    reply: oneshot::Sender<Result<Response, MediaError>>,
}
impl RoomHost {
    pub fn new() -> Result<Self, std::io::Error> {
        Ok(Self(Arc::new(Shared {
            state: Mutex::new(State::Idle),
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        })))
    }
}
impl Extension for RoomHost {
    fn id(&self) -> &str {
        livekit_client::protocol::EXTENSION_ID
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let room = Arc::clone(&self.0);
        context.data_channels.register(
            livekit_client::protocol::CHANNEL_ID,
            move |request, token| {
                token.check_cancelled()?;
                let result = room.runtime.block_on(room.request(request, &token));
                token.check_cancelled()?;
                Ok(result)
            },
        )?;
        Ok(())
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        // Dropping the last sender stops the room actor, which releases captures and RTC tasks.
        *self.0.state.lock().expect("media resource state") = State::Idle;
        Ok(())
    }
}

impl Shared {
    async fn request(
        &self,
        request: Request,
        token: &CancellationToken,
    ) -> Result<Response, MediaError> {
        match request {
            Request::Connect {
                server_url,
                token: credential,
                publication,
            } => {
                if server_url.len() > 8192 || credential.is_empty() || credential.len() > 64 * 1024
                {
                    return Err(MediaError::Address);
                }
                {
                    let mut state = self.state.lock().map_err(|_| MediaError::Connection)?;
                    if !matches!(*state, State::Idle) {
                        return Err(MediaError::Protocol);
                    }
                    *state = State::Starting;
                }
                let result = tokio::select! {
                    room = MediaRoom::connect(&server_url, &credential, publication) => room,
                    _ = cancelled(token) => Err(MediaError::Timeout),
                };
                let mut state = self.state.lock().map_err(|_| MediaError::Connection)?;
                match result {
                    Ok(room) => {
                        *state = State::Room(start_room(room));
                        Ok(Response::Done)
                    }
                    Err(error) => {
                        *state = State::Idle;
                        Err(error)
                    }
                }
            }
            Request::ScreenSources => {
                let mut sources = screen_capture::enumerate_displays()
                    .map_err(|error| MediaError::Capture(error.to_string()))?
                    .into_iter()
                    .map(|info| ScreenSource {
                        target: ScreenTarget::Display(info.id),
                        title: info.title,
                        width: info.width,
                        height: info.height,
                    })
                    .collect::<Vec<_>>();
                sources.extend(
                    screen_capture::enumerate_windows()
                        .map_err(|error| MediaError::Capture(error.to_string()))?
                        .into_iter()
                        .map(|info| ScreenSource {
                            target: ScreenTarget::Window(info.id),
                            title: info.title,
                            width: info.width,
                            height: info.height,
                        }),
                );
                Ok(Response::ScreenSources(sources))
            }
            request @ (Request::SendAudio { .. }
            | Request::Mute { .. }
            | Request::Poll
            | Request::Stats
            | Request::ShareScreen { .. }
            | Request::StopScreen
            | Request::Close) => {
                let room = {
                    let state = self.state.lock().map_err(|_| MediaError::Connection)?;
                    let State::Room(room) = &*state else {
                        return Err(MediaError::Connection);
                    };
                    Arc::clone(room)
                };
                if matches!(request, Request::Poll) {
                    let mut events = room.events.lock().await;
                    return tokio::select! {
                        _ = cancelled(token) => Err(MediaError::Timeout),
                        event = tokio::time::timeout(Duration::from_millis(100), events.recv()) => {
                            match event { Ok(Some(event)) => Ok(Response::Event(Some(event))), Ok(None) => Err(MediaError::Connection), Err(_) => Ok(Response::Event(None)) }
                        }
                    };
                }
                let (reply, result) = oneshot::channel();
                let closing = matches!(request, Request::Close);
                tokio::select! {
                    _ = cancelled(token) => Err(MediaError::Timeout),
                    result = async {
                        let sent = room.commands.send(Job { request, token: token.clone(), reply }).await;
                        if closing {
                            // A server-initiated disconnect can retire the actor before
                            // Close arrives. Await its actual cleanup result in either
                            // case so room rotation can safely open the next generation.
                            let mut finished = room.finished.clone();
                            let outcome = finished.wait_for(|result| result.is_some()).await
                                .map_err(|_| MediaError::Connection)?;
                            return outcome.as_ref().expect("completed room cleanup").clone().map(|()| Response::Done);
                        }
                        sent.map_err(|_| MediaError::Connection)?;
                        result.await.map_err(|_| MediaError::Connection)?
                    } => result,
                }
            }
        }
    }
}

async fn cancelled(token: &CancellationToken) {
    while !token.is_cancellation_requested() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn start_room(mut room: MediaRoom) -> Arc<Room> {
    let (commands, mut receiver) = mpsc::channel::<Job>(32);
    let (events, incoming) = mpsc::channel(128);
    let (completion, finished) = tokio::sync::watch::channel(None);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                command = receiver.recv() => {
                    let Some(job) = command else { break; };
                    if matches!(job.request, Request::Close) {
                        let result = room.close().await;
                        let _ = job.reply.send(result.clone().map(|()| Response::Done));
                        let _ = completion.send(Some(result));
                        return;
                    }
                    let result = tokio::select! {
                        _ = cancelled(&job.token) => Err(MediaError::Timeout),
                        result = room_operation(&mut room, job.request) => result,
                    };
                    let _ = job.reply.send(result);
                }
                event = room.next_event() => {
                    let Some(mut event) = event else { break; };
                    if let MediaEvent::Video(frame) = &mut event {
                        // The frontend displays at most 1080p. Bound IPC frames before encoding,
                        // independently of the remote publisher's chosen resolution.
                        if frame.width > 1920 || frame.height > 1080 {
                            let Some(image) = image::RgbaImage::from_raw(frame.width, frame.height, std::mem::take(&mut frame.rgba)) else { continue; };
                            let image = image::DynamicImage::ImageRgba8(image).thumbnail(1920, 1080).into_rgba8();
                            frame.width = image.width(); frame.height = image.height(); frame.rgba = image.into_raw();
                        }
                    }
                    match event {
                        MediaEvent::Audio(_) | MediaEvent::Video(_) => { let _ = events.try_send(event); }
                        event => { if events.send(event).await.is_err() { break; } }
                    }
                }
            }
        }
        let _ = completion.send(Some(room.close().await));
    });
    Arc::new(Room {
        commands,
        events: tokio::sync::Mutex::new(incoming),
        finished,
    })
}

async fn room_operation(room: &mut MediaRoom, request: Request) -> Result<Response, MediaError> {
    match request {
        Request::SendAudio { samples } => room.send_audio(&samples).await?,
        Request::Mute { muted } => {
            if muted {
                room.mute()?;
            } else {
                room.unmute()?;
            }
        }
        Request::Stats => return room.stats().await.map(Response::Stats),
        Request::ShareScreen { target, fps } => {
            if !(1..=30).contains(&fps) {
                return Err(MediaError::Protocol);
            }
            let source = match target {
                ScreenTarget::Display(id) => screen_capture::create_display_source(&id),
                ScreenTarget::Window(id) => screen_capture::create_window_source(&id),
            }
            .map_err(|error| MediaError::Capture(error.to_string()))?;
            room.start_screen_share(source.as_ref(), fps).await?;
        }
        Request::StopScreen => room.stop_screen_share().await?,
        Request::Connect { .. } | Request::ScreenSources | Request::Poll | Request::Close => {
            return Err(MediaError::Protocol);
        }
    }
    Ok(Response::Done)
}

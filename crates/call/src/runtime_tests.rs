use super::*;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use std::sync::Mutex;

type Log = Arc<Mutex<Vec<&'static str>>>;
struct Authority(crate::CallSnapshot);
impl HttpClient for Authority {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        std::thread::sleep(Duration::from_millis(10));
        Ok(HttpResponse::new(
            200,
            vec![],
            serde_json::to_vec(&self.0).unwrap(),
        ))
    }
}
struct Room {
    events: mpsc::Receiver<MediaEvent>,
    log: Log,
}
impl Media for Room {
    fn share_screen(&mut self, _: crate::ScreenTarget) -> Operation<'_, ()> {
        Box::pin(async {
            self.log.lock().unwrap().push("screen-started");
            Ok(())
        })
    }
    fn stop_screen_share(&mut self) -> Operation<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn next_event(&mut self) -> Operation<'_, Option<MediaEvent>> {
        Box::pin(async { Ok(self.events.recv().await) })
    }
    fn send_audio<'a>(&'a mut self, _: &'a [i16]) -> Operation<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn render(&mut self, samples: usize, _: Instant) -> Result<Vec<i16>, Failure> {
        Ok(vec![0; samples])
    }
    fn mute(&mut self) -> Result<(), Failure> {
        self.log.lock().unwrap().push("media-muted");
        Ok(())
    }
    fn unmute(&mut self) -> Result<(), Failure> {
        self.log.lock().unwrap().push("media-unmuted");
        Ok(())
    }
    fn clear_track(&mut self, _: &str) {}
    fn remove_track(&mut self, _: &str) {}
    fn remove_participant(&mut self, _: &str) {}
    fn clear(&mut self) {
        self.log.lock().unwrap().push("media-cleared");
    }
    fn set_volume(&mut self, _: &str, _: f32) -> Result<(), Failure> {
        Ok(())
    }
    fn rejoin<'a>(&'a mut self, _: &'a MediaJoin) -> Operation<'a, ()> {
        Box::pin(async { Err("unexpected rejoin".into()) })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.log.lock().unwrap().push("media-closed");
            Ok(())
        })
    }
}
struct Audio(Log);
impl Devices for Audio {
    fn next_capture(&mut self) -> Operation<'_, Vec<i16>> {
        Box::pin(std::future::pending())
    }
    fn play<'a>(&'a mut self, _: &'a [i16]) -> Operation<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn mute(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.lock().unwrap().push("capture-muted");
            Ok(())
        })
    }
    fn unmute(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.lock().unwrap().push("capture-started");
            Ok(())
        })
    }
    fn interrupt(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.lock().unwrap().push("playback-cleared");
            Ok(())
        })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.lock().unwrap().push("devices-closed");
            Ok(())
        })
    }
}

#[tokio::test]
async fn reconnect_stops_capture_and_leave_waits_for_media_and_device_cleanup() {
    let snapshot = crate::CallSnapshot {
        id: "call".into(),
        revision: 1,
        media_epoch: 1,
        media_room: "room".into(),
        media_state: MediaState::Ready,
        members: vec![],
    };
    let client = CallClient::new(
        "http://localhost:1",
        crate::MemberCredential::generate(),
        Arc::new(Authority(snapshot.clone())),
    )
    .unwrap();
    let log = Log::default();
    let (events, receiver) = mpsc::channel(8);
    let (changes, mut changed) = mpsc::unbounded_channel();
    let runtime = SessionRuntime {
        media: Box::new(Room {
            events: receiver,
            log: log.clone(),
        }),
        devices: Box::new(Audio(log.clone())),
        client,
        device: "device".into(),
        status: CallStatus {
            resource_id: "resource".into(),
            sequence: 0,
            connection: CallConnection::Connected,
            call: snapshot,
            member_id: "owner".into(),
            participants: vec![],
            muted: true,
            deafened: false,
            microphone_allowed: true,
            screen_sharing: false,
            error: None,
        },
        changed: Arc::new(move |status| {
            let _ = changes.send(status.clone());
        }),
    };
    let (commands, receiver) = mpsc::channel(8);
    let worker = tokio::spawn(runtime.run(receiver));
    let (reply, response) = oneshot::channel();
    commands
        .send((Some(CallControl::Unmute), reply))
        .await
        .unwrap();
    assert!(!response.await.unwrap().unwrap().muted);
    changed.recv().await.unwrap();
    events.send(MediaEvent::Reconnecting).await.unwrap();
    assert_eq!(
        changed.recv().await.unwrap().connection,
        CallConnection::Reconnecting
    );
    assert_eq!(
        &*log.lock().unwrap(),
        &[
            "capture-started",
            "media-unmuted",
            "media-cleared",
            "capture-muted",
            "playback-cleared"
        ]
    );
    events.send(MediaEvent::Reconnected).await.unwrap();
    assert_eq!(
        changed.recv().await.unwrap().connection,
        CallConnection::Connected
    );
    let (reply, response) = oneshot::channel();
    commands.send((None, reply)).await.unwrap();
    let stopped = response.await.unwrap().unwrap();
    assert!(stopped.muted && stopped.deafened && !stopped.microphone_allowed);
    assert_eq!(
        (stopped.connection, stopped.error),
        (CallConnection::Ended, None)
    );
    assert!(
        log.lock()
            .unwrap()
            .ends_with(&["capture-started", "media-closed", "devices-closed"])
    );
    worker.await.unwrap();
}

struct RecoveringAuthority {
    snapshot: crate::CallSnapshot,
    status: std::sync::atomic::AtomicU16,
    joins: std::sync::atomic::AtomicUsize,
}
impl HttpClient for RecoveringAuthority {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        use std::sync::atomic::Ordering;
        std::thread::sleep(Duration::from_millis(10));
        let status = self.status.load(Ordering::SeqCst);
        if status != 200 {
            return Ok(HttpResponse::new(status, vec![], vec![]));
        }
        let body = if request.url().ends_with("/join") {
            self.joins.fetch_add(1, Ordering::SeqCst);
            serde_json::json!({
                "call": self.snapshot,
                "member": {"id":"owner", "role":"owner"},
                "microphone": true,
                "participantId":"owner-device", "serverUrl":"ws://localhost:7880",
                "participantToken":"test", "expiresAt":u64::MAX
            })
        } else {
            serde_json::to_value(&self.snapshot).unwrap()
        };
        Ok(HttpResponse::new(
            200,
            vec![],
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}

struct RejoiningRoom {
    inner: Room,
    // The test controls completion of the real runtime's room rejoin operation.
    ready: mpsc::Receiver<()>,
}
impl Media for RejoiningRoom {
    fn share_screen(&mut self, target: crate::ScreenTarget) -> Operation<'_, ()> {
        self.inner.share_screen(target)
    }
    fn stop_screen_share(&mut self) -> Operation<'_, ()> {
        self.inner.stop_screen_share()
    }
    fn next_event(&mut self) -> Operation<'_, Option<MediaEvent>> {
        self.inner.next_event()
    }
    fn send_audio<'a>(&'a mut self, samples: &'a [i16]) -> Operation<'a, ()> {
        self.inner.send_audio(samples)
    }
    fn render(&mut self, samples: usize, now: Instant) -> Result<Vec<i16>, Failure> {
        self.inner.render(samples, now)
    }
    fn mute(&mut self) -> Result<(), Failure> {
        self.inner.mute()
    }
    fn unmute(&mut self) -> Result<(), Failure> {
        self.inner.unmute()
    }
    fn clear_track(&mut self, _: &str) {
        self.inner.log.lock().unwrap().push("track-cleared");
    }
    fn remove_track(&mut self, _: &str) {
        self.inner.log.lock().unwrap().push("track-removed");
    }
    fn remove_participant(&mut self, id: &str) {
        self.inner.remove_participant(id);
    }
    fn clear(&mut self) {
        self.inner.clear();
    }
    fn set_volume(&mut self, id: &str, volume: f32) -> Result<(), Failure> {
        self.inner.set_volume(id, volume)
    }
    fn rejoin<'a>(&'a mut self, _: &'a MediaJoin) -> Operation<'a, ()> {
        Box::pin(async {
            self.inner.log.lock().unwrap().push("rejoin-started");
            self.ready.recv().await.ok_or("rejoin cancelled")?;
            self.inner.log.lock().unwrap().push("rejoin-completed");
            Ok(())
        })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        self.inner.close()
    }
}

struct RunningCall {
    authority: Arc<RecoveringAuthority>,
    log: Log,
    events: mpsc::Sender<MediaEvent>,
    ready: mpsc::Sender<()>,
    commands: mpsc::Sender<SessionCommand>,
    changes: mpsc::UnboundedReceiver<CallStatus>,
    worker: tokio::task::JoinHandle<()>,
}
impl RunningCall {
    fn start() -> Self {
        Self::with_role(crate::CallRole::Owner)
    }

    fn with_role(role: crate::CallRole) -> Self {
        let snapshot = crate::CallSnapshot {
            id: "call".into(),
            revision: 1,
            media_epoch: 1,
            media_room: "room".into(),
            media_state: MediaState::Ready,
            members: vec![crate::CallMember {
                id: "owner".into(),
                role,
            }],
        };
        let authority = Arc::new(RecoveringAuthority {
            snapshot: snapshot.clone(),
            status: 200.into(),
            joins: 0.into(),
        });
        let log = Log::default();
        let (events, receiver) = mpsc::channel(8);
        let (ready, ready_rx) = mpsc::channel(1);
        let (changes, changed) = mpsc::unbounded_channel();
        let runtime = SessionRuntime {
            media: Box::new(RejoiningRoom {
                inner: Room {
                    events: receiver,
                    log: log.clone(),
                },
                ready: ready_rx,
            }),
            devices: Box::new(Audio(log.clone())),
            client: CallClient::new(
                "http://localhost:1",
                crate::MemberCredential::generate(),
                authority.clone(),
            )
            .unwrap(),
            device: "device".into(),
            status: CallStatus {
                resource_id: "resource".into(),
                sequence: 0,
                connection: CallConnection::Connected,
                call: snapshot,
                member_id: "owner".into(),
                participants: vec![],
                muted: false,
                deafened: false,
                microphone_allowed: true,
                screen_sharing: false,
                error: None,
            },
            changed: Arc::new(move |status| {
                let _ = changes.send(status.clone());
            }),
        };
        let (commands, receiver) = mpsc::channel(8);
        Self {
            authority,
            log,
            events,
            ready,
            commands,
            changes: changed,
            worker: tokio::spawn(runtime.run(receiver)),
        }
    }

    async fn changed(&mut self, connection: CallConnection) -> CallStatus {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let status = self.changes.recv().await.unwrap();
                if status.connection == connection {
                    return status;
                }
            }
        })
        .await
        .unwrap()
    }

    async fn wait_log(&self, value: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.log.lock().unwrap().contains(&value) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn leave(self) {
        let (reply, response) = oneshot::channel();
        self.commands.send((None, reply)).await.unwrap();
        let status = tokio::time::timeout(Duration::from_millis(500), response)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(status.connection, CallConnection::Ended);
        assert!(
            self.log
                .lock()
                .unwrap()
                .ends_with(&["media-closed", "devices-closed"])
        );
        self.worker.await.unwrap();
    }
}

#[tokio::test]
async fn transient_authority_failure_pauses_then_reauthorizes_before_resuming() {
    use std::sync::atomic::Ordering;
    let mut call = RunningCall::start();
    call.authority.status.store(503, Ordering::SeqCst);
    call.changed(CallConnection::Reconnecting).await;
    assert!(call.log.lock().unwrap().contains(&"capture-muted"));
    assert!(!call.log.lock().unwrap().contains(&"capture-started"));
    // Even a media reconnect cannot bypass the unavailable authority.
    call.events.send(MediaEvent::Reconnected).await.unwrap();
    call.authority.status.store(200, Ordering::SeqCst);
    call.wait_log("rejoin-started").await;
    assert_eq!(call.authority.joins.load(Ordering::SeqCst), 1);
    assert!(!call.log.lock().unwrap().contains(&"capture-started"));
    call.ready.send(()).await.unwrap();
    call.changed(CallConnection::Connected).await;
    call.wait_log("capture-started").await;
    call.leave().await;
}

#[tokio::test]
async fn denied_authority_ends_without_rejoin() {
    use std::sync::atomic::Ordering;
    let mut call = RunningCall::start();
    call.authority.status.store(403, Ordering::SeqCst);
    let status = call.changed(CallConnection::Failed).await;
    assert_eq!(status.error.as_deref(), Some("call access denied"));
    assert_eq!(call.authority.joins.load(Ordering::SeqCst), 0);
    assert!(!call.log.lock().unwrap().contains(&"capture-started"));
    call.worker.await.unwrap();
}

#[tokio::test]
async fn leave_cancels_pending_room_rejoin_without_resuming_capture() {
    let call = RunningCall::start();
    call.events.send(MediaEvent::Disconnected).await.unwrap();
    call.wait_log("rejoin-started").await;
    let log = call.log.clone();
    call.leave().await;
    assert!(!log.lock().unwrap().contains(&"rejoin-completed"));
    assert!(!log.lock().unwrap().contains(&"capture-started"));
}

#[tokio::test]
async fn leave_cancels_authority_retries() {
    use std::sync::atomic::Ordering;
    let mut call = RunningCall::start();
    call.authority.status.store(503, Ordering::SeqCst);
    call.changed(CallConnection::Reconnecting).await;
    call.leave().await;
}

#[tokio::test]
async fn muting_remote_track_only_clears_its_audio() {
    let call = RunningCall::start();
    call.events
        .send(MediaEvent::TrackMuted {
            track_id: "mic".into(),
        })
        .await
        .unwrap();
    call.wait_log("track-cleared").await;
    assert!(!call.log.lock().unwrap().contains(&"track-removed"));
    call.leave().await;
}

#[tokio::test]
async fn screen_permission_is_checked_before_starting_capture() {
    for role in [crate::CallRole::Listener, crate::CallRole::Agent] {
        let call = RunningCall::with_role(role);
        let (reply, response) = oneshot::channel();
        call.commands
            .send((
                Some(CallControl::ShareScreen {
                    target: crate::ScreenTarget::Window("42".into()),
                }),
                reply,
            ))
            .await
            .unwrap();
        assert!(response.await.unwrap().unwrap_err().contains("permission"));
        assert!(!call.log.lock().unwrap().contains(&"screen-started"));
        call.leave().await;
    }
}

#[tokio::test]
async fn screen_state_follows_stop_capture_failure_and_reconnect_without_restarting() {
    let mut call = RunningCall::with_role(crate::CallRole::Speaker);
    for stop in [Some(CallControl::StopScreenShare), None] {
        let (reply, response) = oneshot::channel();
        call.commands
            .send((
                Some(CallControl::ShareScreen {
                    target: crate::ScreenTarget::Window("42".into()),
                }),
                reply,
            ))
            .await
            .unwrap();
        assert!(response.await.unwrap().unwrap().screen_sharing);
        assert!(call.changed(CallConnection::Connected).await.screen_sharing);
        if let Some(control) = stop {
            let (reply, response) = oneshot::channel();
            call.commands.send((Some(control), reply)).await.unwrap();
            assert!(!response.await.unwrap().unwrap().screen_sharing);
            assert!(!call.changed(CallConnection::Connected).await.screen_sharing);
        } else {
            call.events
                .send(MediaEvent::ScreenStopped {
                    error: Some("capture target closed".into()),
                })
                .await
                .unwrap();
            let state = call.changed(CallConnection::Connected).await;
            assert!(!state.screen_sharing);
            assert_eq!(state.error.as_deref(), Some("capture target closed"));
        }
    }
    let (reply, response) = oneshot::channel();
    call.commands
        .send((
            Some(CallControl::ShareScreen {
                target: crate::ScreenTarget::Display("1".into()),
            }),
            reply,
        ))
        .await
        .unwrap();
    assert!(response.await.unwrap().unwrap().screen_sharing);
    call.changed(CallConnection::Connected).await;
    call.events.send(MediaEvent::Reconnecting).await.unwrap();
    assert!(
        !call
            .changed(CallConnection::Reconnecting)
            .await
            .screen_sharing
    );
    call.events.send(MediaEvent::Reconnected).await.unwrap();
    assert!(!call.changed(CallConnection::Connected).await.screen_sharing);
    assert_eq!(
        call.log
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| **entry == "screen-started")
            .count(),
        3
    );
    call.leave().await;
}

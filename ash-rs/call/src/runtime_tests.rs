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

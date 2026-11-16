use super::Calls;
use super::NotificationQueue;
use super::Session;
use ash_app_server_protocol::protocol::call::CallDeployment;
use ash_app_server_protocol::protocol::call::CallStartParams;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_http_client::NetworkAccess;
use ash_http_client::OutboundNetworkPolicy;
use call::Operation;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

#[test]
fn blocked_call_host_is_rejected_before_starting_local_devices() {
    let mut calls = Calls::default();
    calls.set_network_policy(OutboundNetworkPolicy::new(NetworkAccess::Hosts(
        BTreeSet::new(),
    )));
    let error = calls
        .start(
            1,
            CallStartParams {
                resource_id: "call-1".into(),
                operation_id: "start-1".into(),
                device_id: "device-1".into(),
                deployment: CallDeployment::Server {
                    url: "https://media.example.com".into(),
                    administrator: "unused".into(),
                },
            },
            Path::new("."),
            NotificationQueue::default(),
        )
        .unwrap_err();
    assert!(error.contains("blocked by application network policy"));
}

#[derive(Default)]
struct Capture {
    active: AtomicBool,
    closed: AtomicBool,
    dropped: AtomicBool,
}

struct Devices(Arc<Capture>);

impl call::Devices for Devices {
    fn next_capture(&mut self) -> Operation<'_, Vec<i16>> {
        Box::pin(std::future::pending())
    }
    fn play<'a>(&'a mut self, _: &'a [i16]) -> Operation<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn mute(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.active.store(false, Ordering::SeqCst);
            Ok(())
        })
    }
    fn unmute(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.active.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
    fn interrupt(&mut self) -> Operation<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.0.active.store(false, Ordering::SeqCst);
            self.0.closed.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
}

impl Drop for Devices {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::SeqCst);
        self.0.dropped.store(true, Ordering::SeqCst);
    }
}

struct Room {
    capture: Arc<Capture>,
    closing: std::sync::mpsc::Sender<()>,
    release: oneshot::Receiver<()>,
}

impl call::Media for Room {
    fn share_screen(&mut self, _: call::ScreenTarget) -> Operation<'_, ()> {
        Box::pin(async {
            self.capture.active.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
    fn stop_screen_share(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.capture.active.store(false, Ordering::SeqCst);
            Ok(())
        })
    }
    fn next_event(&mut self) -> Operation<'_, Option<call::MediaEvent>> {
        Box::pin(std::future::pending())
    }
    fn send_audio<'a>(&'a mut self, _: &'a [i16]) -> Operation<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn render(&mut self, samples: usize, _: Instant) -> Result<Vec<i16>, String> {
        Ok(vec![0; samples])
    }
    fn mute(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn unmute(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn clear_track(&mut self, _: &str) {}
    fn remove_track(&mut self, _: &str) {}
    fn remove_participant(&mut self, _: &str) {}
    fn clear(&mut self) {}
    fn set_volume(&mut self, _: &str, _: f32) -> Result<(), String> {
        Ok(())
    }
    fn rejoin<'a>(&'a mut self, _: &'a call::MediaJoin) -> Operation<'a, ()> {
        Box::pin(async { Err("unexpected rejoin".into()) })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async {
            self.closing.send(()).unwrap();
            // A controlled delay proves connection close waits for actual cleanup.
            let _ = (&mut self.release).await;
            self.capture.active.store(false, Ordering::SeqCst);
            self.capture.closed.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
}

impl Drop for Room {
    fn drop(&mut self) {
        self.capture.active.store(false, Ordering::SeqCst);
        self.capture.dropped.store(true, Ordering::SeqCst);
    }
}

struct Authority(call::CallSnapshot);

impl HttpClient for Authority {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        Ok(HttpResponse::new(
            200,
            vec![],
            serde_json::to_vec(&self.0).unwrap(),
        ))
    }
}

struct RunningCall {
    microphone: Arc<Capture>,
    screen: Arc<Capture>,
    closing: std::sync::mpsc::Receiver<()>,
    release: Option<oneshot::Sender<()>>,
}

impl RunningCall {
    fn start(calls: &Calls, owner: u64) -> Self {
        let snapshot = call::CallSnapshot {
            channel_id: None,
            documents: vec![],
            id: "call".into(),
            revision: 1,
            media_epoch: 1,
            media_room: "room".into(),
            media_state: call::MediaState::Ready,
            members: vec![call::CallMember {
                id: "owner".into(),
                role: call::CallRole::Owner,
            }],
        };
        let client = call::CallClient::new(
            "http://localhost:1",
            call::MemberCredential::generate(),
            Arc::new(Authority(snapshot.clone())),
        )
        .unwrap();
        let microphone = Arc::new(Capture::default());
        let screen = Arc::new(Capture::default());
        let (closing, closed) = std::sync::mpsc::channel();
        let (release, released) = oneshot::channel();
        let status = call::CallStatus {
            resource_id: "resource".into(),
            sequence: 0,
            connection: call::CallConnection::Connected,
            call: snapshot,
            member_id: "owner".into(),
            participants: vec![],
            muted: true,
            deafened: false,
            microphone_allowed: true,
            screen_sharing: false,
            error: None,
        };
        let state = Arc::new(Mutex::new(status.clone()));
        let changed = state.clone();
        let runtime = call::SessionRuntime {
            media: Box::new(Room {
                capture: screen.clone(),
                closing,
                release: released,
            }),
            devices: Box::new(Devices(microphone.clone())),
            status,
            client: client.clone(),
            device: "device".into(),
            changed: Arc::new(move |status| {
                *changed.lock().unwrap() = status.clone();
            }),
        };
        let (commands, receiver) = mpsc::channel(16);
        let retained_commands = commands.clone();
        let worker = calls.executor().unwrap().spawn(async move {
            // The real network-policy watcher also retains a sender for the whole call.
            let _retained_commands = retained_commands;
            runtime.run(receiver).await;
        });
        calls.sessions.lock().unwrap().insert(
            (owner, "resource".into()),
            Session {
                media: "unused".into(),
                client,
                url: "http://localhost:1".into(),
                state,
                screens: Arc::default(),
                invitations: BTreeMap::new(),
                fingerprint: [0; 32],
                commands,
                worker,
            },
        );
        calls
            .control(owner, "resource", Some(call::CallControl::Unmute))
            .unwrap();
        calls
            .control(
                owner,
                "resource",
                Some(call::CallControl::ShareScreen {
                    target: call::ScreenTarget::Display("1".into()),
                }),
            )
            .unwrap();
        assert!(microphone.active.load(Ordering::SeqCst));
        assert!(screen.active.load(Ordering::SeqCst));
        Self {
            microphone,
            screen,
            closing: closed,
            release: Some(release),
        }
    }

    fn assert_released(&self) {
        for capture in [&self.microphone, &self.screen] {
            assert!(!capture.active.load(Ordering::SeqCst));
            assert!(capture.closed.load(Ordering::SeqCst));
            assert!(capture.dropped.load(Ordering::SeqCst));
        }
    }
}

#[test]
fn connection_close_waits_for_capture_release_with_backend_and_other_owner_alive() {
    let server = Arc::new(crate::tests::server());
    let owner = server.product_host_connection();
    let owner_id = owner.connection_id;
    let other = server.product_host_connection();
    let other_id = other.connection_id;
    let mut call = RunningCall::start(&server.calls, owner_id);
    let mut other_call = RunningCall::start(&server.calls, other_id);
    let (finished, completed) = std::sync::mpsc::channel();
    let closing_server = server.clone();
    let closing = std::thread::spawn(move || {
        closing_server.close_connection(owner);
        finished.send(()).unwrap();
    });
    call.closing.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(
        completed.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    assert!(server.calls.has_active_audio());
    assert_eq!(server.calls.sessions.lock().unwrap().len(), 2);
    assert!(other_call.microphone.active.load(Ordering::SeqCst));
    assert!(other_call.screen.active.load(Ordering::SeqCst));
    // Release room cleanup only after observing close blocked on it.
    call.release.take().unwrap().send(()).unwrap();
    completed.recv_timeout(Duration::from_secs(5)).unwrap();
    closing.join().unwrap();
    call.assert_released();
    assert!(
        !server
            .calls
            .sessions
            .lock()
            .unwrap()
            .contains_key(&(owner_id, "resource".into()))
    );
    assert!(server.calls.has_active_audio());
    // Repeated cleanup is harmless and does not stop another connection's call.
    server.calls.close(owner_id);
    assert!(other_call.microphone.active.load(Ordering::SeqCst));
    other_call.release.take().unwrap().send(()).unwrap();
    server.close_connection(other);
    other_call.assert_released();
    assert!(!server.calls.has_active_audio());
    // The shared executor remains available after both owning interfaces disappear.
    assert_eq!(server.calls.executor().unwrap().block_on(async { 42 }), 42);
}

#[test]
fn dropping_session_cancels_worker_instead_of_detaching_active_capture() {
    let calls = Calls::default();
    let call = RunningCall::start(&calls, 1);
    let session = calls
        .sessions
        .lock()
        .unwrap()
        .remove(&(1, "resource".into()))
        .unwrap();
    let worker = session.worker.abort_handle();
    drop(session);
    calls.executor().unwrap().block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !worker.is_finished() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    });
    for capture in [&call.microphone, &call.screen] {
        assert!(!capture.active.load(Ordering::SeqCst));
        assert!(capture.dropped.load(Ordering::SeqCst));
    }
}

#[test]
fn close_cancels_stalled_cleanup_and_waits_for_capture_adapters_to_drop() {
    let calls = Arc::new(Calls::default());
    let call = RunningCall::start(&calls, 1);
    let (finished, completed) = std::sync::mpsc::channel();
    let closing_calls = calls.clone();
    let closing = std::thread::spawn(move || {
        closing_calls.close(1);
        finished.send(()).unwrap();
    });
    call.closing.recv_timeout(Duration::from_secs(5)).unwrap();
    // Do not release the room close operation. Exercise the production cleanup deadline.
    completed.recv_timeout(Duration::from_secs(35)).unwrap();
    closing.join().unwrap();
    for capture in [&call.microphone, &call.screen] {
        assert!(!capture.closed.load(Ordering::SeqCst));
        assert!(!capture.active.load(Ordering::SeqCst));
        assert!(capture.dropped.load(Ordering::SeqCst));
    }
    assert!(calls.sessions.lock().unwrap().is_empty());
    assert_eq!(calls.executor().unwrap().block_on(async { 42 }), 42);
}

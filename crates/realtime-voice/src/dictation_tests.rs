use super::*;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

type EventSink = Box<dyn Fn(DictationEvent) + Send + Sync>;

#[tokio::test]
async fn stopping_a_stalled_model_download_closes_the_connection_and_cleans_staging() {
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    let root = tempfile::tempdir().unwrap();
    // Hold the HTTPS proxy handshake open: cancellation must work without a response or body.
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let network = http_client::OutboundNetworkSnapshot::new(
        http_client::HttpClientConfig::new()
            .with_proxy_policy(http_client::ProxyPolicy::Explicit(format!(
                "http://{}",
                proxy.local_addr().unwrap()
            )))
            .with_timeouts(http_client::TransportTimeouts::new(
                http_client::Timeout::After(Duration::from_secs(5)),
                http_client::Timeout::Disabled,
                http_client::Timeout::Disabled,
                http_client::Timeout::After(Duration::from_secs(5)),
            )),
    )
    .unwrap();
    let manager = Arc::new(DictationManager::default());
    let (send, receive) = std::sync::mpsc::channel();
    manager
        .start(
            1,
            "downloading".into(),
            DictationRequest::Local(LocalDictationRequest {
                input_device: None,
                model_id: DEFAULT_MODEL_ID.into(),
                model_root: root.path().into(),
                audio_host: root.path().join("must-not-start-audio"),
                network,
            }),
            move |event| {
                send.send(event).unwrap();
            },
        )
        .unwrap();
    let (mut connection, _) = tokio::time::timeout(Duration::from_secs(5), proxy.accept())
        .await
        .unwrap()
        .unwrap();
    let mut headers = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(connection.read_u8().await.unwrap());
        }
    })
    .await
    .unwrap();
    assert!(headers.starts_with(b"CONNECT modelscope.cn:443 "));
    let staging = root.path().join(format!(".{DEFAULT_MODEL_ID}.installing"));
    assert!(staging.join("encoder.onnx.download").is_file());

    let stopping = Arc::clone(&manager);
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || stopping.stop(1, "downloading")),
        )
        .await
        .expect("stop must not wait for the download timeout")
        .unwrap()
        .unwrap(),
        None
    );
    assert!(!manager.is_active());
    assert!(!staging.exists());
    assert!(!root.path().join(DEFAULT_MODEL_ID).exists());
    let events: Vec<_> = receive.try_iter().collect();
    assert_eq!(events.last(), Some(&DictationEvent::Ended { error: None }));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, DictationEvent::Transcript { .. }))
    );
    let mut remaining = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        connection.read_to_end(&mut remaining),
    )
    .await
    .expect("the cancelled download must close its socket")
    .unwrap();
    assert!(remaining.is_empty());
    // The small lock file is retained, but its lock is released before stop acknowledges.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(format!(".{DEFAULT_MODEL_ID}.lock")))
        .unwrap();
    lock.try_lock().unwrap();
    assert_eq!(lock.metadata().unwrap().len(), 0);
}

#[tokio::test]
#[ignore = "requires ASH_TEST_DICTATION_MODEL_DIR and ASH_TEST_VOICE_HOST_PATH and a microphone"]
async fn real_microphone_capture_and_local_session_release_the_device() {
    use std::time::Duration;
    let directory = PathBuf::from(std::env::var("ASH_TEST_DICTATION_MODEL_DIR").unwrap());
    let executable = PathBuf::from(std::env::var("ASH_TEST_VOICE_HOST_PATH").unwrap())
        .canonicalize()
        .unwrap();
    // Inspect one real frame before running the production recognizer, without persisting audio.
    let mut audio = voice_host::AudioHost::spawn(&executable).await.unwrap();
    audio
        .start(voice_host::AudioConfig {
            rate: voice_host::SampleRate::Hz16000,
            direction: voice_host::Direction::Capture,
            processing: voice_host::Processing::Speech,
        })
        .await
        .unwrap();
    let capture = tokio::time::timeout(Duration::from_secs(10), audio.next_capture())
        .await
        .unwrap()
        .unwrap();
    assert!(!capture.samples.is_empty());
    audio.stop().await.unwrap();
    audio.close().await.unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let mut session = LocalSpeechSession::start(
        LocalDictationRequest {
            input_device: None,
            model_id: directory.file_name().unwrap().to_str().unwrap().into(),
            model_root: directory.parent().unwrap().into(),
            audio_host: executable,
            network:
                http_client::OutboundNetworkSnapshot::new(http_client::HttpClientConfig::new())
                    .unwrap(),
        },
        LocalSpeechMode::Dictation,
        move |event| {
            send.send(event).unwrap();
        },
    )
    .unwrap();
    loop {
        let event = receive.recv_timeout(Duration::from_secs(30)).unwrap();
        assert!(
            !matches!(event, LocalSpeechEvent::Ended { .. }),
            "{event:?}"
        );
        if event == LocalSpeechEvent::Ready {
            break;
        }
    }
    session.stop().unwrap();
    let events = receive.try_iter().collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, LocalSpeechEvent::Utterance { .. }))
    );
    assert_eq!(
        events.last(),
        Some(&LocalSpeechEvent::Ended { error: None })
    );
}

struct TestRecognizer {
    sink: Arc<Mutex<Option<EventSink>>>,
    stops: Arc<AtomicUsize>,
}

struct TestSession(Arc<AtomicUsize>);

impl Recognizer for TestRecognizer {
    fn start(
        &self,
        _request: DictationRequest,
        _audio: Option<audio_input::AudioReceiver>,
        _cancellation: async_utils::CancellationToken,
        on_event: EventSink,
    ) -> Result<Box<dyn RecognitionSession>, String> {
        *self.sink.lock().unwrap() = Some(on_event);
        Ok(Box::new(TestSession(Arc::clone(&self.stops))))
    }
}

impl RecognitionSession for TestSession {
    fn stop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn manager() -> (
    DictationManager,
    Arc<Mutex<Option<EventSink>>>,
    Arc<AtomicUsize>,
) {
    let sink = Arc::new(Mutex::new(None));
    let stops = Arc::new(AtomicUsize::new(0));
    let recognizer = TestRecognizer {
        sink: Arc::clone(&sink),
        stops: Arc::clone(&stops),
    };
    (
        DictationManager {
            recognizer: Box::new(recognizer),
            active: Mutex::new(None),
        },
        sink,
        stops,
    )
}

fn request() -> DictationRequest {
    DictationRequest::Local(LocalDictationRequest {
        input_device: None,
        model_id: DEFAULT_MODEL_ID.into(),
        model_root: PathBuf::new(),
        audio_host: PathBuf::new(),
        network: http_client::OutboundNetworkSnapshot::new(http_client::HttpClientConfig::new())
            .unwrap(),
    })
}

#[test]
fn cancel_discards_late_transcripts_and_releases_only_the_owner() {
    let (manager, sink, stops) = manager();
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&events);
    manager
        .start(1, "cancelled".into(), request(), move |event| {
            received.lock().unwrap().push(event)
        })
        .unwrap();
    assert!(manager.cancel(2, "cancelled").is_err());
    manager.cancel(1, "cancelled").unwrap();
    sink.lock().unwrap().as_ref().unwrap()(DictationEvent::Transcript {
        text: "discarded".into(),
        is_final: true,
    });
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    manager.start(2, "next".into(), request(), |_| {}).unwrap();
}

#[test]
fn cancellation_can_interrupt_a_worker_already_owned_by_stop() {
    struct BlockingRecognizer(std::sync::mpsc::Sender<()>);
    struct BlockingSession(async_utils::CancellationToken, std::sync::mpsc::Sender<()>);
    impl Recognizer for BlockingRecognizer {
        fn start(
            &self,
            _request: DictationRequest,
            _audio: Option<audio_input::AudioReceiver>,
            token: async_utils::CancellationToken,
            _sink: EventSink,
        ) -> Result<Box<dyn RecognitionSession>, String> {
            Ok(Box::new(BlockingSession(token, self.0.clone())))
        }
    }
    impl RecognitionSession for BlockingSession {
        fn stop(&mut self) {
            self.1.send(()).unwrap();
            let started = std::time::Instant::now();
            while !self.0.is_cancelled() {
                assert!(
                    started.elapsed() < std::time::Duration::from_secs(3),
                    "cancel did not reach upload"
                );
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
    let (send, receive) = std::sync::mpsc::channel();
    let manager = Arc::new(DictationManager {
        recognizer: Box::new(BlockingRecognizer(send)),
        active: Mutex::new(None),
    });
    manager
        .start(1, "upload".into(), request(), |_| {})
        .unwrap();
    let stopping = Arc::clone(&manager);
    let stop = std::thread::spawn(move || stopping.stop(1, "upload"));
    receive
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    assert!(manager.cancel(2, "upload").is_err());
    manager.cancel(1, "upload").unwrap();
    assert_eq!(stop.join().unwrap().unwrap(), None);
    assert!(!manager.is_active());
}

#[test]
fn session_events_reach_the_owner_and_stop_releases_the_microphone() {
    let (manager, sink, stops) = manager();
    let received = Arc::new(Mutex::new(Vec::new()));
    let owner_events = Arc::clone(&received);
    manager
        .start(1, "first".into(), request(), move |event| {
            owner_events.lock().unwrap().push(event);
        })
        .unwrap();
    sink.lock().unwrap().as_ref().unwrap()(DictationEvent::Transcript {
        text: "hello".into(),
        is_final: false,
    });
    assert_eq!(
        *received.lock().unwrap(),
        vec![DictationEvent::Transcript {
            text: "hello".into(),
            is_final: false
        }]
    );
    assert_eq!(
        manager
            .start(2, "second".into(), request(), |_| {})
            .unwrap_err(),
        "The microphone is already in use for dictation"
    );
    assert_eq!(
        manager.stop(2, "first").unwrap_err(),
        "Dictation session not found"
    );
    manager.stop(1, "first").unwrap();
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    manager
        .start(2, "second".into(), request(), |_| {})
        .unwrap();
}

#[test]
fn closing_a_connection_releases_only_its_own_session() {
    let (manager, _, stops) = manager();
    manager
        .start(1, "recording".into(), request(), |_| {})
        .unwrap();
    manager.close(2);
    assert_eq!(stops.load(Ordering::SeqCst), 0);
    manager.close(1);
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    manager
        .start(2, "recording".into(), request(), |_| {})
        .unwrap();
}

#[test]
fn invalid_resource_id_never_starts_a_recognizer() {
    let (manager, sink, _) = manager();
    assert_eq!(
        manager
            .start(1, "bad/id".into(), request(), |_| {})
            .unwrap_err(),
        "Invalid dictation resource ID"
    );
    assert!(sink.lock().unwrap().is_none());
}

#[test]
fn ended_recognition_releases_the_device_before_the_next_owner_starts() {
    let (manager, sink, stops) = manager();
    manager.start(1, "first".into(), request(), |_| {}).unwrap();
    sink.lock().unwrap().as_ref().unwrap()(DictationEvent::Ended { error: None });
    manager
        .start(2, "second".into(), request(), |_| {})
        .unwrap();
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        manager.stop(1, "first").unwrap_err(),
        "Dictation session not found"
    );
    manager.stop(2, "second").unwrap();
    assert_eq!(stops.load(Ordering::SeqCst), 2);
}

#[test]
fn stop_preserves_a_worker_failure_and_releases_the_session() {
    let (manager, sink, stops) = manager();
    manager.start(1, "first".into(), request(), |_| {}).unwrap();
    sink.lock().unwrap().as_ref().unwrap()(DictationEvent::Ended {
        error: Some("model download disconnected".into()),
    });
    assert_eq!(
        manager.stop(1, "first"),
        Err("model download disconnected".into())
    );
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    manager
        .start(1, "second".into(), request(), |_| {})
        .unwrap();
    manager.stop(1, "second").unwrap();
}

#[test]
fn streamed_audio_is_private_bounded_and_drained_before_stop_returns() {
    struct StreamRecognizer;
    struct StreamSession(Option<thread::JoinHandle<()>>);
    impl Recognizer for StreamRecognizer {
        fn start(
            &self,
            _request: DictationRequest,
            audio: Option<audio_input::AudioReceiver>,
            _cancellation: async_utils::CancellationToken,
            on_event: EventSink,
        ) -> Result<Box<dyn RecognitionSession>, String> {
            let mut audio = audio.expect("stream input");
            Ok(Box::new(StreamSession(Some(thread::spawn(move || {
                let mut samples = Vec::new();
                while let Some(chunk) = audio.blocking_recv() {
                    samples.extend(chunk);
                }
                on_event(DictationEvent::Transcript {
                    text: format!("{samples:?}"),
                    is_final: true,
                });
                on_event(DictationEvent::Ended { error: None });
            })))))
        }
    }
    impl RecognitionSession for StreamSession {
        fn stop(&mut self) {
            self.0.take().unwrap().join().unwrap();
        }
    }
    let manager = DictationManager {
        recognizer: Box::new(StreamRecognizer),
        active: Mutex::new(None),
    };
    manager
        .start_stream(7, "pcm".into(), request(), |_| {})
        .unwrap();
    assert!(manager.push_audio(8, "pcm", vec![9]).is_err());
    manager.push_audio(7, "pcm", vec![1, 2]).unwrap();
    manager.push_audio(7, "pcm", vec![3]).unwrap();
    assert_eq!(manager.stop(7, "pcm").unwrap(), Some("[1, 2, 3]".into()));
    assert!(manager.push_audio(7, "pcm", vec![4]).is_err());
}

#[test]
fn a_stalled_pcm_consumer_has_a_bounded_queue() {
    struct StalledRecognizer(Arc<Mutex<Option<audio_input::AudioReceiver>>>);
    impl Recognizer for StalledRecognizer {
        fn start(
            &self,
            _request: DictationRequest,
            audio: Option<audio_input::AudioReceiver>,
            _cancellation: async_utils::CancellationToken,
            _on_event: EventSink,
        ) -> Result<Box<dyn RecognitionSession>, String> {
            *self.0.lock().unwrap() = audio;
            Ok(Box::new(TestSession(Arc::new(AtomicUsize::new(0)))))
        }
    }
    let input = Arc::new(Mutex::new(None));
    let manager = DictationManager {
        recognizer: Box::new(StalledRecognizer(Arc::clone(&input))),
        active: Mutex::new(None),
    };
    manager
        .start_stream(7, "pcm".into(), request(), |_| {})
        .unwrap();
    for _ in 0..64 {
        manager.push_audio(7, "pcm", vec![1]).unwrap();
    }
    assert!(manager.push_audio(7, "pcm", vec![2]).is_err());
    manager.cancel(7, "pcm").unwrap();
    assert!(!manager.is_active());
}

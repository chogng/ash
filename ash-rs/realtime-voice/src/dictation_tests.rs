use super::*;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

type EventSink = Box<dyn Fn(DictationEvent) + Send + Sync>;

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

use super::*;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

type EventSink = Box<dyn Fn(DictationEvent) + Send>;

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

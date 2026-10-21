use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

fn token() -> CancellationToken {
    CancellationToken::new(
        1_900_000_000_000,
        external_ext_protocol::RequestContext::new(1, 1, 1),
    )
}
fn session() -> Value {
    json!({"session":{"id":"s1","type":"node","name":"test","configuration":{"type":"node","name":"test","request":"launch"},"workspaceFolder":null}})
}
struct Tracker(Arc<AtomicUsize>);
impl AdapterTracker for Tracker {
    fn event(&self, event: TrackerEvent, _: CancellationToken) -> Result<(), ExtensionError> {
        if matches!(event, TrackerEvent::Dispose) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
}
#[test]
fn tracker_handles_are_scoped_and_dispose_once() {
    let mut debug = Debug::default();
    let disposed = Arc::new(AtomicUsize::new(0));
    let events = Arc::clone(&disposed);
    debug
        .register_tracker_factory("observer", "*", move |_, _| {
            Ok(Some(Arc::new(Tracker(Arc::clone(&events)))))
        })
        .unwrap();
    let registration = &debug.registrations["observer"];
    let created = registration.handlers["createDebugAdapterTracker"](session(), token()).unwrap();
    let id = created["trackerId"].as_str().unwrap();
    let callback = &registration.handlers["debugAdapterTrackerEvent"];
    callback(json!({"trackerId":id,"event":"onDidSendMessage","message":{"type":"event","event":"output"}}), token()).unwrap();
    for _ in 0..2 {
        callback(json!({"trackerId":id,"event":"dispose"}), token()).unwrap();
    }
    assert_eq!(disposed.load(Ordering::Relaxed), 1);
    assert!(callback(json!({"trackerId":id,"event":"arbitrary"}), token()).is_err());
}
#[test]
fn tracker_rejects_malformed_sessions_and_registration_collisions() {
    let mut debug = Debug::default();
    debug
        .register_tracker_factory("observer", "node", |_, _| Ok(None))
        .unwrap();
    assert!(
        debug
            .register_tracker_factory("observer", "*", |_, _| Ok(None))
            .is_err()
    );
    let callback = &debug.registrations["observer"].handlers["createDebugAdapterTracker"];
    assert_eq!(callback(session(), token()).unwrap(), Value::Null);
    let mut input = session();
    input["session"]["configuration"]["request"] = json!("unknown");
    assert!(callback(input, token()).is_err());
}
#[test]
fn named_pipe_factory_uses_the_existing_descriptor_contract() {
    let mut debug = Debug::default();
    debug
        .register_connection_factory("adapter", "node", |_, _| {
            Ok(Connection::NamedPipe {
                path: "/private/runtime/dap".into(),
            })
        })
        .unwrap();
    let value = debug.registrations["adapter"].handlers["createDebugAdapterDescriptor"](json!({"configuration":{"type":"node","name":"test","request":"launch"},"session":{"id":"s1","workspaceFolder":null}}),token()).unwrap();
    assert_eq!(
        value,
        json!({"connection":{"type":"namedPipe","path":"/private/runtime/dap"}})
    );
}

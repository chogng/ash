use std::sync::Arc;
use std::sync::Mutex;

use super::ComponentRuntime;
use super::ComponentRuntimeError;
use super::ComponentSlot;
use super::ViewState;
use crate::ui::foundation::ElementId;

#[test]
fn local_state_survives_updates_and_unmounts_when_absent() {
    let component = ElementId::from_raw(41);
    let invalidated = Arc::new(Mutex::new(Vec::new()));
    let observed = invalidated.clone();
    let mut runtime = ComponentRuntime::new(move |id| observed.lock().unwrap().push(id));

    runtime.begin_frame();
    let state = runtime
        .local_state(component, ComponentSlot::new("counter"), || 1_u8)
        .unwrap();
    runtime.finish_frame();
    state.update(|value| *value += 1);

    runtime.begin_frame();
    let retained = runtime
        .local_state(component, ComponentSlot::new("counter"), || 99_u8)
        .unwrap();
    runtime.finish_frame();
    assert_eq!(retained.read(|value| *value), 2);
    assert_eq!(*invalidated.lock().unwrap(), vec![component]);

    runtime.begin_frame();
    runtime.finish_frame();
    assert!(!runtime.contains(component));
    invalidated.lock().unwrap().clear();
    state.update(|value| *value += 1);
    assert!(invalidated.lock().unwrap().is_empty());
}

#[test]
fn external_observation_rebinds_when_the_source_identity_changes() {
    let component = ElementId::from_raw(7);
    let first = ViewState::new(false);
    let second = ViewState::new(false);
    let invalidated = Arc::new(Mutex::new(Vec::new()));
    let observed = invalidated.clone();
    let mut runtime = ComponentRuntime::new(move |id| observed.lock().unwrap().push(id));

    runtime.begin_frame();
    runtime.observe_state(component, ComponentSlot::new("source"), &first);
    runtime.observe_state(component, ComponentSlot::new("source"), &second);
    runtime.finish_frame();
    first.update(|value| *value = true);
    second.update(|value| *value = true);

    assert_eq!(*invalidated.lock().unwrap(), vec![component]);
}

#[test]
fn a_slot_cannot_change_its_retained_state_type() {
    let component = ElementId::from_raw(3);
    let mut runtime = ComponentRuntime::default();
    runtime.begin_frame();
    runtime
        .local_state(component, ComponentSlot::new("value"), || 1_u8)
        .unwrap();

    assert!(matches!(
        runtime.local_state(component, ComponentSlot::new("value"), || String::from(
            "wrong"
        )),
        Err(ComponentRuntimeError::StateTypeMismatch { .. })
    ));
}

#[test]
fn retained_resources_drop_when_the_component_unmounts() {
    struct DropResource(Arc<Mutex<u8>>);
    impl Drop for DropResource {
        fn drop(&mut self) {
            *self.0.lock().unwrap() += 1;
        }
    }

    let component = ElementId::from_raw(5);
    let drops = Arc::new(Mutex::new(0));
    let mut runtime = ComponentRuntime::default();
    runtime.begin_frame();
    assert!(
        runtime
            .retain_resource(component, ComponentSlot::new("subscription"), || {
                DropResource(drops.clone())
            })
            .unwrap()
    );
    runtime.finish_frame();

    runtime.begin_frame();
    runtime.finish_frame();
    assert_eq!(*drops.lock().unwrap(), 1);
}

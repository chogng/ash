use crate::ExtensionRegistryBuilder;
use crate::ExtensionScope;
use crate::ThreadContext;
use crate::ThreadLifecycle;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
#[test]
fn registry_recomposition_shares_state_until_its_owner_retires_it() {
    let registry = ExtensionRegistryBuilder::new().build();
    let session = SessionId::new("s").unwrap();
    let thread = ThreadId::new("t").unwrap();
    let turn = TurnId::new("turn").unwrap();
    let thread_scope = ExtensionScope::Thread(session.clone(), thread.clone());
    let turn_scope = ExtensionScope::Turn(session.clone(), thread.clone(), turn.clone());
    let counter = registry
        .state()
        .get_or_insert::<AtomicUsize>(thread_scope.clone())
        .unwrap();
    counter.store(7, Ordering::Relaxed);
    let temporary = registry
        .state()
        .get_or_insert::<AtomicUsize>(turn_scope.clone())
        .unwrap();
    temporary.store(4, Ordering::Relaxed);
    let updated = ExtensionRegistryBuilder::from_registry(&registry).build();
    assert!(Arc::ptr_eq(
        &counter,
        &updated
            .state()
            .get_or_insert::<AtomicUsize>(thread_scope.clone())
            .unwrap()
    ));
    updated.thread_changed(
        ThreadContext {
            session_id: &session,
            thread_id: &thread,
            sequence: 3,
        },
        &ThreadLifecycle::TurnCompleted(turn),
    );
    assert_eq!(
        updated
            .state()
            .get_or_insert::<AtomicUsize>(turn_scope)
            .unwrap()
            .load(Ordering::Relaxed),
        0
    );
    assert_eq!(counter.load(Ordering::Relaxed), 7);
    updated.state().remove(&ExtensionScope::Session(session));
    assert_eq!(
        updated
            .state()
            .get_or_insert::<AtomicUsize>(thread_scope)
            .unwrap()
            .load(Ordering::Relaxed),
        0
    );
}
#[test]
fn the_same_thread_name_in_another_session_has_no_access_to_state() {
    let registry = ExtensionRegistryBuilder::new().build();
    let thread = ThreadId::new("t").unwrap();
    let a = registry
        .state()
        .get_or_insert::<AtomicUsize>(ExtensionScope::Thread(
            SessionId::new("a").unwrap(),
            thread.clone(),
        ))
        .unwrap();
    a.store(5, Ordering::Relaxed);
    let b = registry
        .state()
        .get_or_insert::<AtomicUsize>(ExtensionScope::Thread(SessionId::new("b").unwrap(), thread))
        .unwrap();
    assert_eq!(b.load(Ordering::Relaxed), 0);
}

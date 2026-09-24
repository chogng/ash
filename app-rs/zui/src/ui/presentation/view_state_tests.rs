use std::sync::Arc;
use std::sync::Mutex;

use super::StateRevision;
use super::ViewState;

#[test]
fn updates_publish_monotonic_revisions_after_mutation() {
    let state = ViewState::new(String::from("before"));
    let revisions = Arc::new(Mutex::new(Vec::new()));
    let observed = revisions.clone();
    let subscription = state.subscribe(move |revision| observed.lock().unwrap().push(revision));

    state.update(|value| *value = String::from("after"));
    let snapshot = state.snapshot();

    assert!(subscription.is_active());
    assert_eq!(snapshot.value(), "after");
    assert_eq!(snapshot.revision(), StateRevision(1));
    assert_eq!(*revisions.lock().unwrap(), vec![StateRevision(1)]);
}

#[test]
fn dropping_a_subscription_stops_future_notifications() {
    let state = ViewState::new(0_u8);
    let notifications = Arc::new(Mutex::new(0));
    let observed = notifications.clone();
    let subscription = state.subscribe(move |_| *observed.lock().unwrap() += 1);

    state.update(|value| *value += 1);
    drop(subscription);
    state.update(|value| *value += 1);

    assert_eq!(*notifications.lock().unwrap(), 1);
    assert_eq!(state.revision().into_raw(), 2);
}

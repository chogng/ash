use std::time::Duration;
use std::time::Instant;

use super::ScheduledTimer;
use super::TimerId;
use super::TimerRegistry;
use crate::runtime::TaskScope;

#[test]
fn timers_are_taken_in_deadline_then_identity_order() {
    let now = Instant::now();
    let mut timers = TimerRegistry::default();
    timers.schedule(ScheduledTimer {
        id: TimerId(2),
        deadline: now + Duration::from_millis(20),
        scope: TaskScope::Application,
        event: "later",
    });
    timers.schedule(ScheduledTimer {
        id: TimerId(3),
        deadline: now + Duration::from_millis(10),
        scope: TaskScope::Application,
        event: "second",
    });
    timers.schedule(ScheduledTimer {
        id: TimerId(1),
        deadline: now + Duration::from_millis(10),
        scope: TaskScope::Application,
        event: "first",
    });

    assert_eq!(
        timers.take_due(now + Duration::from_millis(10)),
        vec!["first", "second"]
    );
    assert_eq!(
        timers.next_deadline(),
        Some(now + Duration::from_millis(20))
    );
    assert_eq!(
        timers.take_due(now + Duration::from_millis(20)),
        vec!["later"]
    );
}

#[test]
fn timer_cancellation_removes_only_the_selected_identity() {
    let now = Instant::now();
    let mut timers = TimerRegistry::default();
    for id in [TimerId(1), TimerId(2)] {
        timers.schedule(ScheduledTimer {
            id,
            deadline: now,
            scope: TaskScope::Application,
            event: id,
        });
    }

    timers.cancel(TimerId(1));

    assert_eq!(timers.take_due(now), vec![TimerId(2)]);
}

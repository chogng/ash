use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use crate::app::AppProxy;
use crate::app::runtime_event::RuntimeEvent;
use crate::internal::NativeEventLoopClosed;

use super::task::TaskScope;

static NEXT_TIMER_ID: AtomicU64 = AtomicU64::new(1);

/// Stable identity assigned to one scheduled application event.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TimerId(u64);

pub(crate) struct ScheduledTimer<T> {
    pub(crate) id: TimerId,
    pub(crate) deadline: Instant,
    pub(crate) scope: TaskScope,
    pub(crate) event: T,
}

/// Failure to schedule an application event for future delivery.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimerScheduleError<T> {
    DeadlineOverflow(T),
    Disconnected(T),
}

impl<T> fmt::Display for TimerScheduleError<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeadlineOverflow(_) => {
                formatter.write_str("timer deadline exceeds Instant range")
            }
            Self::Disconnected(_) => {
                formatter.write_str("cannot schedule a timer after the application has exited")
            }
        }
    }
}

impl<T: fmt::Debug> Error for TimerScheduleError<T> {}

/// Cancellation handle for one event-loop timer.
///
/// Dropping the handle cancels the timer. Call [`Timer::detach`] to keep it scheduled without
/// retaining a handle.
#[must_use = "dropping a timer cancels it; call detach to keep it scheduled"]
pub struct Timer {
    id: TimerId,
    cancel: Arc<dyn Fn(TimerId) + Send + Sync>,
    detached: bool,
}

impl Timer {
    /// Returns the stable identity of this scheduled timer.
    pub const fn id(&self) -> TimerId {
        self.id
    }

    /// Cancels the timer before its event is delivered.
    pub fn cancel(mut self) {
        (self.cancel)(self.id);
        self.detached = true;
    }

    /// Keeps the timer scheduled after this handle is dropped.
    pub fn detach(mut self) {
        self.detached = true;
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if !self.detached {
            (self.cancel)(self.id);
        }
    }
}

/// Cloneable scheduler for delivering typed application events at event-loop deadlines.
pub struct TimerScheduler<T: 'static> {
    proxy: AppProxy<T>,
}

impl<T: 'static> Clone for TimerScheduler<T> {
    fn clone(&self) -> Self {
        Self {
            proxy: self.proxy.clone(),
        }
    }
}

impl<T: 'static> TimerScheduler<T> {
    pub(crate) const fn new(proxy: AppProxy<T>) -> Self {
        Self { proxy }
    }

    /// Schedules `event` relative to the current monotonic time.
    pub fn schedule_after(&self, delay: Duration, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        let Some(deadline) = Instant::now().checked_add(delay) else {
            return Err(TimerScheduleError::DeadlineOverflow(event));
        };
        self.schedule_at(deadline, event)
    }

    /// Schedules `event` at an explicit monotonic deadline.
    pub fn schedule_at(&self, deadline: Instant, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.schedule_at_in_scope(TaskScope::Application, deadline, event)
    }

    pub(crate) fn schedule_after_in_scope(
        &self,
        scope: TaskScope,
        delay: Duration,
        event: T,
    ) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        let Some(deadline) = Instant::now().checked_add(delay) else {
            return Err(TimerScheduleError::DeadlineOverflow(event));
        };
        self.schedule_at_in_scope(scope, deadline, event)
    }

    pub(crate) fn schedule_at_in_scope(
        &self,
        scope: TaskScope,
        deadline: Instant,
        event: T,
    ) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        let id = TimerId(NEXT_TIMER_ID.fetch_add(1, Ordering::Relaxed));
        let scheduled = ScheduledTimer {
            id,
            deadline,
            scope,
            event,
        };
        self.proxy
            .inner
            .send_event(RuntimeEvent::ScheduleTimer(scheduled))
            .map_err(|error| match error {
                NativeEventLoopClosed(RuntimeEvent::ScheduleTimer(scheduled)) => {
                    TimerScheduleError::Disconnected(scheduled.event)
                }
                NativeEventLoopClosed(
                    RuntimeEvent::Product(_)
                    | RuntimeEvent::Control(_)
                    | RuntimeEvent::OpenWindow(_)
                    | RuntimeEvent::CancelTimer(_),
                ) => {
                    unreachable!("timer scheduling must retain the scheduled event")
                }
                NativeEventLoopClosed(RuntimeEvent::MenuAction(_)) => {
                    unreachable!("timer scheduling cannot fail with a menu action")
                }
                NativeEventLoopClosed(RuntimeEvent::Tray(_)) => {
                    unreachable!("timer scheduling cannot fail with a tray event")
                }
                NativeEventLoopClosed(RuntimeEvent::GlobalShortcut(_)) => {
                    unreachable!("timer scheduling cannot fail with a global shortcut event")
                }
                NativeEventLoopClosed(RuntimeEvent::SecondInstance(_)) => {
                    unreachable!("timer scheduling cannot fail with a second-instance event")
                }
                #[cfg(target_os = "macos")]
                NativeEventLoopClosed(RuntimeEvent::Activated(_)) => {
                    unreachable!("timer scheduling cannot fail with an activation event")
                }
                #[cfg(target_os = "macos")]
                NativeEventLoopClosed(RuntimeEvent::OpenFile(_)) => {
                    unreachable!("timer scheduling cannot fail with an open-file event")
                }
                NativeEventLoopClosed(RuntimeEvent::OpenUrl(_)) => {
                    unreachable!("timer scheduling cannot fail with an application URL")
                }
                NativeEventLoopClosed(RuntimeEvent::Accessibility(_)) => {
                    unreachable!("timer scheduling cannot fail with an accessibility event")
                }
                NativeEventLoopClosed(RuntimeEvent::DevToolsWake) => {
                    unreachable!("timer scheduling cannot fail with a DevTools wakeup")
                }
            })?;
        let proxy = self.proxy.inner.clone();
        Ok(Timer {
            id,
            cancel: Arc::new(move |id| {
                let _ = proxy.send_event(RuntimeEvent::CancelTimer(id));
            }),
            detached: false,
        })
    }
}

pub(crate) struct TimerRegistry<T> {
    events: BTreeMap<(Instant, TimerId), TimerEntry<T>>,
}

impl<T> Default for TimerRegistry<T> {
    fn default() -> Self {
        Self {
            events: BTreeMap::new(),
        }
    }
}

struct TimerEntry<T> {
    scope: TaskScope,
    event: T,
}

impl<T> TimerRegistry<T> {
    pub(crate) fn len(&self) -> usize {
        self.events.len()
    }

    pub(crate) fn schedule(&mut self, timer: ScheduledTimer<T>) {
        self.events.insert(
            (timer.deadline, timer.id),
            TimerEntry {
                scope: timer.scope,
                event: timer.event,
            },
        );
    }

    pub(crate) fn cancel(&mut self, id: TimerId) {
        self.events.retain(|(_, timer_id), _| *timer_id != id);
    }

    pub(crate) fn cancel_scope(&mut self, scope: TaskScope) {
        self.events.retain(|_, entry| entry.scope != scope);
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.events
            .first_key_value()
            .map(|((deadline, _), _)| *deadline)
    }

    pub(crate) fn take_due(&mut self, now: Instant) -> Vec<T> {
        let due = self
            .events
            .range(..=(now, TimerId(u64::MAX)))
            .map(|(key, _)| *key)
            .collect::<Vec<_>>();
        due.into_iter()
            .filter_map(|key| self.events.remove(&key).map(|entry| entry.event))
            .collect()
    }
}

#[cfg(test)]
#[path = "timer_tests.rs"]
mod tests;

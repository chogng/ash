use std::cell::Cell;
use std::rc::Rc;
#[cfg(any(test, target_os = "linux"))]
use std::time::Duration;
use std::time::Instant;

#[cfg(target_os = "linux")]
const LINUX_POLL_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) struct DisplayChangeMonitor {
    #[cfg(target_os = "macos")]
    _inner: super::macos::ChangeMonitor,
    #[cfg(target_os = "linux")]
    poll: PollSchedule,
}

impl DisplayChangeMonitor {
    pub(crate) fn new(pending: Rc<Cell<bool>>) -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                _inner: super::macos::ChangeMonitor::new(pending),
            }
        }
        #[cfg(target_os = "linux")]
        {
            let _ = pending;
            Self {
                poll: PollSchedule::new(Instant::now(), LINUX_POLL_INTERVAL),
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = pending;
            Self {}
        }
    }

    pub(crate) fn poll_deadline(&self) -> Option<Instant> {
        #[cfg(target_os = "linux")]
        {
            Some(self.poll.deadline())
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }

    pub(crate) fn take_due_poll(&mut self, now: Instant) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.poll.take_due(now)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = now;
            false
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
struct PollSchedule {
    interval: Duration,
    next: Instant,
}

#[cfg(any(test, target_os = "linux"))]
impl PollSchedule {
    fn new(now: Instant, interval: Duration) -> Self {
        Self {
            interval,
            next: now + interval,
        }
    }

    const fn deadline(&self) -> Instant {
        self.next
    }

    fn take_due(&mut self, now: Instant) -> bool {
        if now < self.next {
            return false;
        }
        self.next = now + self.interval;
        true
    }
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;

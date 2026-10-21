//! Bounded callback admission that never waits for queue capacity. Waiting for
//! capacity here can deadlock notify's watch/unwatch command thread.

use notify::Event;
use notify::EventKind;
use notify::event::Flag;
use std::collections::VecDeque;
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio::time::sleep_until;

const MAX_EVENTS: usize = 1024;
const MAX_PATHS: usize = 4096;
const MAX_BYTES: usize = 1024 * 1024;
pub(crate) const RESCAN_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Pending {
    events: VecDeque<(Event, usize)>,
    paths: usize,
    bytes: usize,
    recovery: Option<Recovery>,
    senders: usize,
    closed: bool,
}

enum Recovery {
    Rescan,
    BackendError(String),
}

impl Pending {
    fn recover(&mut self, recovery: Recovery) {
        self.events.clear();
        self.paths = 0;
        self.bytes = 0;
        // A lost-sync marker must not hide a helper failure that needs recovery.
        if !matches!(self.recovery, Some(Recovery::BackendError(_))) {
            self.recovery = Some(recovery);
        }
    }
}

struct Shared {
    pending: Mutex<Pending>,
    ready: Notify,
}

pub(crate) struct EventSender(Arc<Shared>);

pub(crate) struct EventReceiver {
    shared: Arc<Shared>,
    next_recovery: Option<Instant>,
}

pub(crate) fn event_channel() -> (EventSender, EventReceiver) {
    let shared = Arc::new(Shared {
        pending: Mutex::new(Pending {
            senders: 1,
            ..Pending::default()
        }),
        ready: Notify::new(),
    });
    (
        EventSender(shared.clone()),
        EventReceiver {
            shared,
            next_recovery: None,
        },
    )
}

impl EventSender {
    pub(crate) fn send(&self, result: notify::Result<Event>) -> Result<(), ()> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.closed {
            return Err(());
        }
        match result {
            Err(error) => {
                if !matches!(pending.recovery, Some(Recovery::BackendError(_))) {
                    // Keep one useful diagnostic, not an unbounded list of errors/paths.
                    let message = error.to_string().chars().take(512).collect();
                    pending.recover(Recovery::BackendError(message));
                }
            }
            Ok(event) if event.need_rescan() => pending.recover(Recovery::Rescan),
            Ok(event)
                if matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) && !event.paths.is_empty() =>
            {
                if pending.recovery.is_some() {
                    return Ok(());
                }
                let bytes = event.paths.iter().fold(
                    event.paths.len().saturating_mul(size_of::<PathBuf>()),
                    |bytes, path| bytes.saturating_add(path.capacity()),
                );
                if pending.events.len() >= MAX_EVENTS
                    || event.paths.len() > MAX_PATHS.saturating_sub(pending.paths)
                    || bytes > MAX_BYTES.saturating_sub(pending.bytes)
                {
                    pending.recover(Recovery::Rescan);
                } else {
                    // The consumer uses only kind/paths. Do not retain arbitrary backend
                    // metadata or spare vector capacity outside the admission budget.
                    let mut change = Event::new(event.kind);
                    change.paths = event.paths.into_boxed_slice().into_vec();
                    pending.paths += change.paths.len();
                    pending.bytes += bytes;
                    pending.events.push_back((change, bytes));
                }
            }
            Ok(_) => return Ok(()),
        }
        drop(pending);
        self.0.ready.notify_one();
        Ok(())
    }
}

impl Clone for EventSender {
    fn clone(&self) -> Self {
        self.0
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .senders += 1;
        Self(self.0.clone())
    }
}

impl Drop for EventSender {
    fn drop(&mut self) {
        self.0
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .senders -= 1;
        self.0.ready.notify_one();
    }
}

impl EventReceiver {
    pub(crate) async fn recv(&mut self) -> Option<notify::Result<Event>> {
        // Unlike Tokio mpsc, this synchronous buffer does not spend the runtime's
        // cooperative budget itself. Keep a continuously ready queue from starving
        // cancellation, timers and other services on a current-thread runtime.
        tokio::task::consume_budget().await;
        loop {
            let notified = self.shared.ready.notified();
            let wait_until = {
                let mut pending = self
                    .shared
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if pending.recovery.is_some() {
                    if let Some(deadline) = self
                        .next_recovery
                        .filter(|deadline| *deadline > Instant::now())
                    {
                        Some(deadline)
                    } else {
                        self.next_recovery = Some(Instant::now() + RESCAN_INTERVAL);
                        return Some(match pending.recovery.take().unwrap() {
                            Recovery::Rescan => {
                                Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan))
                            }
                            Recovery::BackendError(message) => {
                                Err(notify::Error::generic(&message))
                            }
                        });
                    }
                } else if let Some((event, bytes)) = pending.events.pop_front() {
                    pending.bytes -= bytes;
                    pending.paths -= event.paths.len();
                    return Some(Ok(event));
                } else if pending.senders == 0 {
                    return None;
                } else {
                    None
                }
            };
            // The deadline survives cancellation; a steady storm cannot postpone recovery
            // forever or trigger one full reconciliation for every native rescan marker.
            if let Some(deadline) = wait_until {
                sleep_until(deadline).await;
            } else {
                notified.await;
            }
        }
    }
}

impl Drop for EventReceiver {
    fn drop(&mut self) {
        let mut pending = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.closed = true;
        pending.events.clear();
        pending.recovery = None;
        pending.paths = 0;
        pending.bytes = 0;
    }
}

#[cfg(test)]
#[path = "ingress_tests.rs"]
mod tests;

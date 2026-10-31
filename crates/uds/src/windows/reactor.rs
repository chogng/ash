//! One process-wide IOCP driver. Mio owns overlapped buffers through completion, including
//! writes whose last stream owner has dropped. Callers retain the synchronous Read/Write API.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mio::Events;
use mio::Interest;
use mio::Poll;
use mio::Registry;
use mio::Token;
use mio::windows::NamedPipe;

#[derive(Default)]
pub(super) struct Readiness {
    pub(super) readable: bool,
    pub(super) writable: bool,
    pub(super) closed: bool,
}

pub(super) struct Registration {
    token: Token,
    pub(super) ready: Arc<Signal>,
}

#[derive(Default)]
pub(super) struct Signal {
    state: Mutex<Readiness>,
    changed: Condvar,
}

impl Signal {
    pub(super) fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, Readiness>> {
        self.state.lock()
    }

    pub(super) fn notify(&self) {
        self.changed.notify_all();
    }

    /// A stream wakes only its own reader/writer. The shared condition below is reserved
    /// for the lifecycle listener waiting across several pending connections.
    pub(super) fn wait(
        &self,
        timeout: Option<Duration>,
        ready: impl Fn(&Readiness) -> bool,
    ) -> io::Result<()> {
        let deadline = timeout.and_then(|timeout| Instant::now().checked_add(timeout));
        let mut state = self.state.lock().unwrap();
        while !state.closed && !ready(&state) {
            state = match deadline {
                Some(deadline) => {
                    let remaining =
                        deadline
                            .checked_duration_since(Instant::now())
                            .ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    "local IPC deadline elapsed",
                                )
                            })?;
                    self.changed.wait_timeout(state, remaining).unwrap().0
                }
                None => self.changed.wait(state).unwrap(),
            };
        }
        Ok(())
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(reactor) = reactor() {
            reactor.shared.sources.lock().unwrap().remove(&self.token);
        }
    }
}

#[derive(Default)]
struct Shared {
    sources: Mutex<HashMap<Token, Weak<Signal>>>,
    // The generation lock spans readiness checks and entering the wait, preventing lost wakes.
    generation: Mutex<(u64, Option<String>)>,
    changed: Condvar,
}

impl Shared {
    fn notify(&self) {
        self.generation.lock().unwrap().0 += 1;
        self.changed.notify_all();
    }
}

struct Reactor {
    registry: Registry,
    next: AtomicUsize,
    shared: Arc<Shared>,
}

fn reactor() -> io::Result<&'static Reactor> {
    static REACTOR: OnceLock<Result<Reactor, String>> = OnceLock::new();
    REACTOR
        .get_or_init(|| {
            let mut poll = Poll::new().map_err(|error| error.to_string())?;
            let registry = poll
                .registry()
                .try_clone()
                .map_err(|error| error.to_string())?;
            let shared = Arc::new(Shared::default());
            let driver = shared.clone();
            std::thread::Builder::new()
                .name("ash-local-ipc".into())
                .spawn(move || {
                    let mut events = Events::with_capacity(128);
                    loop {
                        match poll.poll(&mut events, None) {
                            Ok(()) => {}
                            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                            Err(error) => {
                                driver.generation.lock().unwrap().1 = Some(error.to_string());
                                for signal in driver
                                    .sources
                                    .lock()
                                    .unwrap()
                                    .values()
                                    .filter_map(Weak::upgrade)
                                {
                                    signal.lock().unwrap().closed = true;
                                    signal.notify();
                                }
                                driver.notify();
                                break;
                            }
                        }
                        for event in &events {
                            let ready = driver
                                .sources
                                .lock()
                                .unwrap()
                                .get(&event.token())
                                .and_then(Weak::upgrade);
                            if let Some(signal) = ready {
                                let mut ready = signal.lock().unwrap();
                                ready.readable |= event.is_readable()
                                    || event.is_read_closed()
                                    || event.is_error();
                                ready.writable |= event.is_writable()
                                    || event.is_write_closed()
                                    || event.is_error();
                                drop(ready);
                                signal.notify();
                            }
                        }
                        driver.notify();
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(Reactor {
                registry,
                next: AtomicUsize::new(1),
                shared,
            })
        })
        .as_ref()
        .map_err(|error| io::Error::other(error.clone()))
}

pub(super) fn register(pipe: &mut NamedPipe) -> io::Result<Registration> {
    let reactor = reactor()?;
    let registration = Registration {
        token: Token(reactor.next.fetch_add(1, Ordering::Relaxed)),
        ready: Arc::new(Signal::default()),
    };
    reactor
        .shared
        .sources
        .lock()
        .unwrap()
        .insert(registration.token, Arc::downgrade(&registration.ready));
    reactor.registry.register(
        pipe,
        registration.token,
        Interest::READABLE | Interest::WRITABLE,
    )?;
    Ok(registration)
}

pub(super) fn notify() {
    if let Ok(reactor) = reactor() {
        reactor.shared.notify();
    }
}

pub(super) fn wait(timeout: Option<Duration>, mut ready: impl FnMut() -> bool) -> io::Result<()> {
    let shared = &reactor()?.shared;
    let deadline = timeout.and_then(|timeout| Instant::now().checked_add(timeout));
    let mut generation = shared.generation.lock().unwrap();
    loop {
        if let Some(error) = &generation.1 {
            return Err(io::Error::other(error.clone()));
        }
        if ready() {
            return Ok(());
        }
        generation = match deadline {
            Some(deadline) => {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "local IPC deadline elapsed",
                    ));
                };
                shared
                    .changed
                    .wait_timeout(generation, remaining)
                    .unwrap()
                    .0
            }
            None => shared.changed.wait(generation).unwrap(),
        };
    }
}

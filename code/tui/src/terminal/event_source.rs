use crossterm::event;
use crossterm::event::Event;
use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(crate) enum TerminalEvent {
    Input(Event),
    Tick,
    Failed(io::Error),
}

pub(crate) struct TerminalEventSource {
    task: Option<JoinHandle<()>>,
}

impl TerminalEventSource {
    pub(crate) fn start(
        stop: Arc<AtomicBool>,
        mut emit: impl FnMut(TerminalEvent) -> bool + Send + 'static,
    ) -> Result<Self, io::Error> {
        let task = thread::Builder::new()
            .name("ash-tui-terminal-events".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    match event::poll(POLL_INTERVAL) {
                        Ok(true) => match event::read() {
                            Ok(event) => {
                                if !emit(TerminalEvent::Input(event)) {
                                    return;
                                }
                            }
                            Err(error) => {
                                let _ = emit(TerminalEvent::Failed(error));
                                return;
                            }
                        },
                        Ok(false) => {
                            if !emit(TerminalEvent::Tick) {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = emit(TerminalEvent::Failed(error));
                            return;
                        }
                    }
                }
            })?;
        Ok(Self { task: Some(task) })
    }

    pub(crate) fn join(&mut self) -> Result<(), io::Error> {
        self.task
            .take()
            .map(JoinHandle::join)
            .transpose()
            .map(|_| ())
            .map_err(|_| io::Error::other("terminal event source panicked"))
    }
}

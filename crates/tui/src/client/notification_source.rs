use super::ClientEvent;
use super::map_event;
use ash_app_server_client::AppServerEvents;
use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc::RecvTimeoutError;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;

const RECEIVE_INTERVAL: Duration = Duration::from_millis(25);

pub(crate) struct ClientEventSource {
    task: Option<JoinHandle<()>>,
}

impl ClientEventSource {
    pub(crate) fn start(
        events: AppServerEvents,
        stop: Arc<AtomicBool>,
        mut emit: impl FnMut(ClientEvent) -> bool + Send + 'static,
    ) -> Result<Self, io::Error> {
        let task = thread::Builder::new()
            .name("ash-tui-client-events".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    match events.recv_timeout(RECEIVE_INTERVAL) {
                        Ok(event) => {
                            if let Some(event) = map_event(event)
                                && !emit(event)
                            {
                                return;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
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
            .map_err(|_| io::Error::other("App Server event source panicked"))
    }
}

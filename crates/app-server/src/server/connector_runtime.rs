use super::update_broker::UpdateBroker;
use connectors::ConnectorAuthority;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub(super) struct ConnectorWatcher {
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl ConnectorWatcher {
    pub(super) fn start(authority: &ConnectorAuthority, updates: Arc<UpdateBroker>) -> Self {
        let changes = authority.subscribe();
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-connector-notifications".into())
            .spawn(move || {
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(generation) => updates.publish_connectors_changed(generation.get()),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .ok();
        Self {
            shutdown: Some(shutdown),
            thread,
        }
    }
}

impl Drop for ConnectorWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

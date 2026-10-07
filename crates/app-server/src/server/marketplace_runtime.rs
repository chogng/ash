use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use ash_core_plugins::PluginsManager;

use super::UpdateBroker;

pub(crate) struct MarketplaceChangeWatcher {
    shutdown: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl MarketplaceChangeWatcher {
    pub(crate) fn start(manager: &Arc<PluginsManager>, updates: Arc<UpdateBroker>) -> Option<Self> {
        let changes = match manager.subscribe() {
            Ok(changes) => changes,
            Err(error) => {
                log::error!("failed to subscribe to Marketplace changes: {error}");
                return None;
            }
        };
        let source_id = manager.change_source_id().to_owned();
        let (shutdown, shutdown_receiver) = mpsc::channel();
        let thread = match std::thread::Builder::new()
            .name("ash-marketplace-changes".into())
            .spawn(move || {
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(generation) => {
                            let _change = updates.lock_marketplace_change();
                            updates.publish_marketplace_manager_changed(&source_id, generation);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                log::error!("failed to start Marketplace change watcher: {error}");
                return None;
            }
        };
        Some(Self {
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }
}

impl Drop for MarketplaceChangeWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

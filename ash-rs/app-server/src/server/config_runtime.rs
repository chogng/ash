use super::update_broker::UpdateBroker;
use ash_config::ConfigStore;
use std::sync::Arc;
use std::sync::RwLock;
use std::thread::JoinHandle;
use std::time::Duration;

pub(super) struct ConfigWatcher {
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    extensions: Arc<RwLock<Arc<ash_extension_api::ExtensionRegistry>>>,
}

impl ConfigWatcher {
    pub(super) fn start(
        config: &ConfigStore,
        updates: Arc<UpdateBroker>,
        extensions: Arc<ash_extension_api::ExtensionRegistry>,
    ) -> Self {
        let changes = config.subscribe_changes();
        let extensions = Arc::new(RwLock::new(extensions));
        let current_extensions = Arc::clone(&extensions);
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-config-notifications".into())
            .spawn(move || {
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(change) => {
                            let extensions = current_extensions
                                .read()
                                .expect("extension registry lock poisoned")
                                .clone();
                            extensions.config_changed(change.generation.get());
                            updates.publish_config_changed(change);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .ok();
        Self {
            shutdown: Some(shutdown),
            thread,
            extensions,
        }
    }

    /// Composition replaces the registry several times; keep one subscriber so those updates
    /// do not wait for the old notification thread's receive timeout on every replacement.
    pub(super) fn replace_extensions(&self, extensions: Arc<ash_extension_api::ExtensionRegistry>) {
        *self
            .extensions
            .write()
            .expect("extension registry lock poisoned") = extensions;
    }
}

impl Drop for ConfigWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[path = "config_runtime_tests.rs"]
mod tests;

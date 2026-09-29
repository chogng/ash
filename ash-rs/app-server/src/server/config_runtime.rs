use super::update_broker::UpdateBroker;
use ash_async_utils::CancellationSource;
use ash_config::ConfigStore;
use ash_hooks::DeclarativeHookRuntime;
use ash_protocol::HookEvent;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::HookService;
use std::sync::Arc;
use std::sync::RwLock;
use std::thread::JoinHandle;
use std::time::Duration;

pub(super) struct ConfigWatcher {
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    extensions: Arc<RwLock<Arc<ash_extension_api::ExtensionRegistry>>>,
    hooks: Arc<RwLock<Option<Arc<DeclarativeHookRuntime>>>>,
}

impl ConfigWatcher {
    pub(super) fn start(
        config: &ConfigStore,
        updates: Arc<UpdateBroker>,
        extensions: Arc<ash_extension_api::ExtensionRegistry>,
        hooks: Option<Arc<DeclarativeHookRuntime>>,
    ) -> Self {
        let changes = config.subscribe_changes();
        let extensions = Arc::new(RwLock::new(extensions));
        let current_extensions = Arc::clone(&extensions);
        let hooks = Arc::new(RwLock::new(hooks));
        let current_hooks = Arc::clone(&hooks);
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
                            let hooks = current_hooks
                                .read()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .clone();
                            if let Some(hooks) = hooks {
                                let cancellation = CancellationSource::new();
                                if let Err(error) = hooks.event(
                                    &HookEventRequest {
                                        event: HookEvent::ConfigChange,
                                        scope: HookEventScope::User,
                                        subject: None,
                                        tool_name: None,
                                    },
                                    &cancellation.token(),
                                ) {
                                    log::warn!("ConfigChange Hook failed: {error}");
                                }
                            }
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
            hooks,
        }
    }

    pub(super) fn bind_hooks(&self, hooks: Arc<DeclarativeHookRuntime>) {
        *self
            .hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hooks);
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

use super::update_broker::UpdateBroker;
use ash_async_utils::CancellationSource;
use ash_config::ConfigChange;
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

#[derive(Clone)]
struct LanguageConfigurationTarget {
    config: Arc<ConfigStore>,
    runtime: std::sync::Weak<std::sync::Mutex<super::language_runtime::AppServerLanguageRuntime>>,
}

pub(super) struct ConfigWatcher {
    _subscription: ConfigSubscription,
    extensions: Arc<RwLock<Arc<ash_extension_api::ExtensionRegistry>>>,
    hooks: Arc<RwLock<Option<Arc<DeclarativeHookRuntime>>>>,
    language: Arc<RwLock<Option<LanguageConfigurationTarget>>>,
}

pub(super) enum ConfigNotifications {
    Standalone(Arc<UpdateBroker>),
    // A composed AppServer can outlive the profile handle supplied by its caller.
    Profile {
        _subscription: Arc<ConfigSubscription>,
    },
}

impl ConfigWatcher {
    pub(super) fn start(
        config: &ConfigStore,
        notifications: ConfigNotifications,
        extensions: Arc<ash_extension_api::ExtensionRegistry>,
        hooks: Option<Arc<DeclarativeHookRuntime>>,
    ) -> Self {
        let extensions = Arc::new(RwLock::new(extensions));
        let current_extensions = Arc::clone(&extensions);
        let hooks = Arc::new(RwLock::new(hooks));
        let current_hooks = Arc::clone(&hooks);
        let language = Arc::new(RwLock::new(None::<LanguageConfigurationTarget>));
        let current_language = Arc::clone(&language);
        let subscription = ConfigSubscription::start(config, move |change| {
            if let Some(target) = current_language
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
                && let Some(owner) = target.runtime.upgrade()
                && let Ok(snapshot) = target.config.read_snapshot()
                && let Ok(mut runtime) = owner.lock()
            {
                runtime.reconcile_configuration(&snapshot.values.language_servers);
            }
            let extensions = current_extensions
                .read()
                .expect("extension registry lock poisoned")
                .clone();
            extensions.config_changed(change.generation.get());
            if let ConfigNotifications::Standalone(notifications) = &notifications {
                notifications.publish_config_changed(change);
            }
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
        });
        Self {
            _subscription: subscription,
            extensions,
            hooks,
            language,
        }
    }

    pub(super) fn bind_language(
        &self,
        config: Arc<ConfigStore>,
        language: &Arc<std::sync::Mutex<super::language_runtime::AppServerLanguageRuntime>>,
    ) {
        *self
            .language
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(LanguageConfigurationTarget {
                config,
                runtime: Arc::downgrade(language),
            });
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

pub(crate) struct ConfigSubscription {
    shutdown: std::sync::mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl ConfigSubscription {
    pub(crate) fn start(
        config: &ConfigStore,
        on_change: impl Fn(ConfigChange) + Send + 'static,
    ) -> Self {
        let changes = config.subscribe_changes();
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-config-notifications".into())
            .spawn(move || {
                while shutdown_receiver.try_recv().is_err() {
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(change) => on_change(change),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .ok();
        Self { shutdown, thread }
    }
}

impl Drop for ConfigSubscription {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[path = "config_runtime_tests.rs"]
mod tests;

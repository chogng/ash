use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use ash_core_plugins::ExtensionPackageManager;

use super::UpdateBroker;

pub(crate) struct ExtensionsChangeWatcher {
    shutdown: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl ExtensionsChangeWatcher {
    pub(super) fn start_editor_policy(
        policy: &ash_core_plugins::EditorExtensionPolicy,
        runtime: super::extension_packages_language_runtime::ExtensionsLanguageRuntime,
        language: Arc<std::sync::Mutex<super::language_runtime::AppServerLanguageRuntime>>,
    ) -> Option<Self> {
        let changes = policy.subscribe();
        let mut provider_ids = runtime
            .providers()
            .ok()
            .map(|providers| providers.ids().map(str::to_owned).collect::<Vec<_>>());
        let (shutdown, shutdown_receiver) = mpsc::channel();
        let thread = match std::thread::Builder::new()
            .name("ash-editor-policy-changes".into())
            .spawn(move || {
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(_) => {
                            while changes.try_recv().is_ok() {}
                            match runtime.providers() {
                                Ok(providers) => {
                                    let ids =
                                        providers.ids().map(str::to_owned).collect::<Vec<_>>();
                                    if let Ok(mut language) = language.lock() {
                                        if provider_ids.as_ref() != Some(&ids) {
                                            language.set_server_providers(providers);
                                            provider_ids = Some(ids);
                                        }
                                        // Other directory hosts share this profile policy. Retire
                                        // extension-owned LSPs on revocation even without a request.
                                        language.invalidate_extensions();
                                    }
                                }
                                Err(error) => log::error!(
                                    "failed to reconcile editor policy language servers: {error}"
                                ),
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                log::error!("failed to start editor policy change watcher: {error}");
                return None;
            }
        };
        Some(Self {
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }

    pub(crate) fn start(
        manager: &Arc<ExtensionPackageManager>,
        updates: Arc<UpdateBroker>,
    ) -> Option<Self> {
        let changes = match manager.subscribe() {
            Ok(changes) => changes,
            Err(error) => {
                log::error!("failed to subscribe to Extensions changes: {error}");
                return None;
            }
        };
        let source_id = manager.change_source_id().to_owned();
        let (shutdown, shutdown_receiver) = mpsc::channel();
        let thread = match std::thread::Builder::new()
            .name("ash-extension_packages-changes".into())
            .spawn(move || {
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(generation) => {
                            let _change = updates.lock_extension_packages_change();
                            updates
                                .publish_extension_packages_manager_changed(&source_id, generation);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                log::error!("failed to start Extensions change watcher: {error}");
                return None;
            }
        };
        Some(Self {
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }
}

impl Drop for ExtensionsChangeWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

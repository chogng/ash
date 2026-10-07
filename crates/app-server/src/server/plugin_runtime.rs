use super::update_broker::UpdateBroker;
use ash_core_plugins::PluginActivationAuthority;
use ash_skills_extension::SkillCatalogReload;
use ash_skills_extension::SkillRuntime;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub(super) struct PluginWatcher {
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl PluginWatcher {
    pub(super) fn start(
        authority: &PluginActivationAuthority,
        updates: Arc<UpdateBroker>,
        skills: Option<Arc<SkillRuntime>>,
    ) -> Self {
        let changes = authority.subscribe();
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-plugin-notifications".into())
            .spawn(move || {
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(change) => {
                            updates.publish_plugins_changed(
                                change.revision,
                                change.activation_generation,
                            );
                            if let Some(skills) = &skills
                                && let Err(error) = skills.list(SkillCatalogReload::Refresh)
                            {
                                log::error!("failed to reconcile Plugin Skill sources: {error}");
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
        }
    }
}

impl Drop for PluginWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

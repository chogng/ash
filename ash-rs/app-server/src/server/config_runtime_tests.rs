use super::ConfigWatcher;
use super::UpdateBroker;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::ConfigStore;
use ash_config::PreferencesUpdate;
use ash_config::UserConfigCommand;
use ash_extension_api::ExtensionRegistry;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::LifecycleObserver;
use ash_extension_api::ThreadContext;
use ash_extension_api::ThreadLifecycle;
use ash_protocol::CommandId;
use ash_protocol::Patch;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

struct ConfigObserver(mpsc::Sender<u64>);

impl LifecycleObserver for ConfigObserver {
    fn thread_changed(&self, _: ThreadContext<'_>, _: &ThreadLifecycle) {}

    fn config_changed(&self, generation: u64) {
        self.0.send(generation).unwrap();
    }
}

fn registry(sender: mpsc::Sender<u64>) -> Arc<ExtensionRegistry> {
    let mut builder = ExtensionRegistryBuilder::new();
    builder.lifecycle_observer("config-watcher-test", Arc::new(ConfigObserver(sender)));
    Arc::new(builder.build())
}

#[test]
fn config_changes_reach_the_current_extension_registry() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::open(directory.path().join("config.sqlite3")).unwrap();
    let (old_sender, old_receiver) = mpsc::channel();
    let (current_sender, current_receiver) = mpsc::channel();
    let watcher = ConfigWatcher::start(
        &config,
        Arc::new(UpdateBroker::default()),
        registry(old_sender),
    );
    watcher.replace_extensions(registry(current_sender));

    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("change-gui").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                gui: Patch::Value(BTreeMap::from([(
                    "theme".into(),
                    serde_json::json!("ash-dark"),
                )])),
                ..PreferencesUpdate::default()
            }),
        })
        .unwrap();

    assert_eq!(
        current_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        1
    );
    assert!(old_receiver.try_recv().is_err());
}

use super::ConfigNotifications;
use super::ConfigSubscription;
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
fn config_changes_reach_each_current_extension_registry_once() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::open(directory.path().join("config.sqlite3")).unwrap();
    let (first_sender, first_receiver) = mpsc::channel();
    let (second_sender, second_receiver) = mpsc::channel();
    let (third_sender, third_receiver) = mpsc::channel();
    let watcher = ConfigWatcher::start(
        &config,
        ConfigNotifications::Standalone(Arc::new(UpdateBroker::default())),
        registry(first_sender),
        None,
    );
    update_gui(&config, 0);
    assert_eq!(
        first_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        1
    );

    watcher.replace_extensions(registry(second_sender));
    update_gui(&config, 1);
    assert_eq!(
        second_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        2
    );

    watcher.replace_extensions(registry(third_sender));
    update_gui(&config, 2);
    assert_eq!(
        third_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        3
    );
    assert!(first_receiver.try_recv().is_err());
    assert!(second_receiver.try_recv().is_err());
    assert!(third_receiver.try_recv().is_err());
}

#[test]
fn profile_config_changes_keep_publishing_while_a_directory_watcher_is_live() {
    let directory = tempfile::tempdir().unwrap();
    let config = ConfigStore::open(directory.path().join("config.sqlite3")).unwrap();
    let (published, changes) = mpsc::channel();
    let subscription = Arc::new(ConfigSubscription::start(&config, move |change| {
        published.send(change).unwrap();
    }));
    let (observed, extension_changes) = mpsc::channel();
    let watcher = ConfigWatcher::start(
        &config,
        ConfigNotifications::Profile {
            _subscription: subscription,
        },
        registry(observed),
        None,
    );

    update_gui(&config, 0);
    let change = changes.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(change.generation.get(), 1);
    assert_eq!(
        extension_changes
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        1
    );
    drop(watcher);
    assert_eq!(changes.try_recv(), Err(mpsc::TryRecvError::Disconnected));
}

fn update_gui(config: &ConfigStore, revision: u64) {
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new(format!("change-gui-{revision}")).unwrap(),
            expected_revision: ConfigRevision::new(revision),
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                gui: Patch::Value(BTreeMap::from([(
                    "theme".into(),
                    serde_json::json!(format!("ash-dark-{revision}")),
                )])),
                ..PreferencesUpdate::default()
            }),
        })
        .unwrap();
}

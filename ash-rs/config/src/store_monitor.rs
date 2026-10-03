use crate::ConfigChange;
use crate::ConfigError;
use crate::ResolvedConfigSnapshot;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) fn start(
    mut connection: Connection,
    config_path: PathBuf,
    shutdown: Receiver<()>,
    subscribers: Arc<Mutex<Vec<Sender<ConfigChange>>>>,
    committed: Arc<Mutex<ResolvedConfigSnapshot>>,
) -> Result<JoinHandle<()>, ConfigError> {
    std::thread::Builder::new()
        .name("ash-config-sqlite".into())
        .spawn(move || {
            loop {
                match shutdown.recv_timeout(Duration::from_millis(100)) {
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                // Reading both sources also observes metadata committed by another ConfigStore.
                // Publish the validated document and its revision together, never metadata alone.
                if let Ok(snapshot) =
                    crate::store::reconcile_external_snapshot(&mut connection, &config_path)
                {
                    publish(&subscribers, &committed, snapshot);
                }
            }
        })
        .map_err(|error| ConfigError(error.to_string()))
}

pub(crate) fn publish(
    subscribers: &Mutex<Vec<Sender<ConfigChange>>>,
    committed: &Mutex<ResolvedConfigSnapshot>,
    snapshot: ResolvedConfigSnapshot,
) {
    let mut current = committed
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A slower reader may publish after a newer transaction has already been observed.
    if snapshot.generation <= current.generation {
        return;
    }
    let change = ConfigChange {
        revision: snapshot.revision,
        generation: snapshot.generation,
    };
    *current = snapshot;
    subscribers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|subscriber| subscriber.send(change).is_ok());
}

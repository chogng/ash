use crate::ConfigChange;
use crate::ConfigError;
use crate::ResolvedConfigSnapshot;
use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;

#[derive(PartialEq, Eq)]
struct Observation {
    generation: u64,
    pending: bool,
    file: Option<FileStamp>,
}

#[derive(PartialEq, Eq)]
struct FileStamp {
    modified: SystemTime,
    len: u64,
    #[cfg(unix)]
    identity_and_change: (u64, u64, i64, i64),
    #[cfg(windows)]
    created: u64,
}

fn observe(connection: &Connection, config_path: &Path) -> Option<Observation> {
    let file = match fs::metadata(config_path) {
        Ok(metadata) => {
            #[cfg(unix)]
            use std::os::unix::fs::MetadataExt;
            #[cfg(windows)]
            use std::os::windows::fs::MetadataExt;
            Some(FileStamp {
                modified: metadata.modified().ok()?,
                len: metadata.len(),
                #[cfg(unix)]
                identity_and_change: (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                ),
                #[cfg(windows)]
                created: metadata.creation_time(),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return None,
    };
    // The database is shared with other domains. Check this row rather than the global data
    // version so that commits to Thread history or Queue do not trigger a TOML read.
    let (generation, pending) = connection
        .prepare_cached(
            "SELECT generation, EXISTS(SELECT 1 FROM config_pending_command)
                         FROM config_metadata WHERE authority_id = 1",
        )
        .ok()?
        .query_row([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?))
        })
        .ok()?;
    Some(Observation {
        generation: u64::try_from(generation).ok()?,
        pending,
        file,
    })
}
use tokio::sync::watch;

pub(crate) fn start(
    connection: Connection,
    config_path: PathBuf,
    shutdown: Receiver<()>,
    subscribers: Arc<Mutex<Vec<Sender<ConfigChange>>>>,
    committed: Arc<watch::Sender<ResolvedConfigSnapshot>>,
) -> Result<JoinHandle<()>, ConfigError> {
    std::thread::Builder::new()
        .name("ash-config-sqlite".into())
        .spawn(move || {
            let mut previous = None;
            let mut retry_at = None;
            loop {
                match shutdown.recv_timeout(Duration::from_millis(100)) {
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                let mut observed = observe(&connection, &config_path);
                if observed.is_some()
                    && observed == previous
                    && retry_at.is_none_or(|deadline| Instant::now() < deadline)
                {
                    continue;
                }
                match crate::store::reconcile_external_snapshot(&connection, &config_path) {
                    Ok(snapshot) => {
                        if let Some(observed) = &mut observed {
                            observed.generation = snapshot.generation.get();
                        }
                        retry_at = None;
                        publish(&subscribers, &committed, snapshot);
                    }
                    Err(_) => {
                        // A subsequent edit should be observed promptly. Slow down retries
                        // against the same invalid document or temporarily unavailable store.
                        retry_at = Some(Instant::now() + Duration::from_secs(1));
                    }
                }
                previous = observed;
            }
        })
        .map_err(|error| ConfigError(error.to_string()))
}

pub(crate) fn publish(
    subscribers: &Mutex<Vec<Sender<ConfigChange>>>,
    committed: &watch::Sender<ResolvedConfigSnapshot>,
    snapshot: ResolvedConfigSnapshot,
) {
    committed.send_if_modified(|current| {
        // A slower reader may publish after a newer transaction has already been observed.
        if snapshot.generation <= current.generation {
            return false;
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
        true
    });
}

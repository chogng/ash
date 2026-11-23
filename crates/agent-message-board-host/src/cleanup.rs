use agent_message_board::AccessToken;
use agent_message_board::Error;
use agent_message_board::RemoteBoardLocation;
use agent_message_board::Result;
use agent_message_board::Store;
use agent_message_board_client::RemoteMessageBoard;
use ash_async_utils::CancelOnDrop;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Default)]
pub(super) struct RemoteCleanup(Mutex<Option<Worker>>);

struct Worker {
    wake: mpsc::SyncSender<()>,
    _cancellation: CancelOnDrop,
}

impl RemoteCleanup {
    pub(super) fn resume(&self, store: &Arc<Store>, http: &Arc<dyn HttpClient>) {
        match store.pending_remote_deletions() {
            Ok(jobs) if !jobs.is_empty() => self.wake(store, http),
            Ok(_) => {}
            Err(error) => log::warn!("Could not read pending board cleanup: {error}"),
        }
    }

    pub(super) fn wake(&self, store: &Arc<Store>, http: &Arc<dyn HttpClient>) {
        let mut worker = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(worker) = worker.as_ref() {
            let _ = worker.wake.try_send(());
            return;
        }
        let (wake, requests) = mpsc::sync_channel(1);
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let store = store.clone();
        let http = http.clone();
        match std::thread::Builder::new()
            .name("agent-board-cleanup".into())
            .spawn(move || {
                while !token.is_cancelled() {
                    if clean_pending(&store, &http, &token) {
                        if matches!(
                            requests.recv_timeout(Duration::from_secs(5)),
                            Err(mpsc::RecvTimeoutError::Disconnected)
                        ) {
                            break;
                        }
                    } else if requests.recv().is_err() {
                        break;
                    }
                }
            }) {
            Ok(_) => {
                *worker = Some(Worker {
                    wake,
                    _cancellation: cancellation.cancel_on_drop(),
                })
            }
            Err(error) => log::warn!("Could not start pending board cleanup: {error}"),
        }
    }
}

fn clean_pending(
    store: &Store,
    http: &Arc<dyn HttpClient>,
    cancellation: &CancellationToken,
) -> bool {
    let jobs = match store.pending_remote_deletions() {
        Ok(jobs) => jobs,
        Err(error) => {
            log::warn!("Could not read pending board cleanup: {error}");
            return true;
        }
    };
    let mut retry = false;
    for (session, location) in jobs {
        if cancellation.is_cancelled() {
            return false;
        }
        let result = connect(&location, http)
            .and_then(|board| board.delete_session_with_cancellation(&session, cancellation))
            .and_then(|()| store.confirm_remote_deletion(&session, &location));
        if let Err(error) = result {
            if !cancellation.is_cancelled() {
                log::warn!("Remote board cleanup remains pending for Session {session}: {error}");
            }
            retry = true;
        }
    }
    retry
}

pub(super) fn connect(
    location: &RemoteBoardLocation,
    http: &Arc<dyn HttpClient>,
) -> Result<RemoteMessageBoard> {
    let credential = std::env::var(&location.credential_env).map_err(|_| {
        Error::Input("configured message-board credential is missing or invalid".into())
    })?;
    RemoteMessageBoard::new(
        http.clone(),
        &location.endpoint,
        AccessToken::new(credential)?,
    )
}

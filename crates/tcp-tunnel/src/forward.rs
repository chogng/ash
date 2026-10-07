use std::net::SocketAddr;

use async_utils::CancelOnDrop;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use crate::ConnectTarget;
use crate::Error;
use crate::Requests;
use crate::Result;

/// Failure of an individual accepted socket; the listener continues accepting.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForwardEvent {
    ConnectFailed(Error),
    TransferFailed(Error),
}

/// Owns one loopback listener, independently of other listeners or streams.
/// Dropping it cancels it; `close().await` joins its sockets and releases its port.
pub struct LocalForward {
    address: SocketAddr,
    source: CancellationSource,
    events: broadcast::Sender<ForwardEvent>,
    finished: oneshot::Receiver<Result<()>>,
    _cancel_on_drop: CancelOnDrop,
}

impl LocalForward {
    pub(super) fn new(
        address: SocketAddr,
        source: CancellationSource,
        guard: CancelOnDrop,
        events: broadcast::Sender<ForwardEvent>,
        finished: oneshot::Receiver<Result<()>>,
    ) -> Self {
        Self {
            address,
            source,
            events,
            finished,
            _cancel_on_drop: guard,
        }
    }

    /// Listening readiness only; target readiness is gated by each socket's CONNECT.
    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    /// A bounded event subscription. Lagging consumers receive broadcast's Lagged error.
    pub fn subscribe(&self) -> broadcast::Receiver<ForwardEvent> {
        self.events.subscribe()
    }

    pub async fn close(self) -> Result<()> {
        self.source.cancel();
        self.finished.await.map_err(|_| Error::Task)?
    }
}

pub(super) async fn serve(
    listener: TcpListener,
    target: ConnectTarget,
    requests: Requests,
    cancellation: CancellationToken,
    events: broadcast::Sender<ForwardEvent>,
) -> Result<()> {
    let sockets_source = cancellation.child_source();
    let mut sockets = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => break Ok(()),
            completed = sockets.join_next(), if !sockets.is_empty() => match completed {
                Some(Ok(Ok(()))) | None => {},
                Some(Ok(Err(event))) => { let _ = events.send(event); },
                Some(Err(_)) => break Err(Error::Task),
            },
            accepted = listener.accept() => {
                let (mut socket, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(_) => break Err(Error::LocalIo),
                };
                let requests = requests.clone();
                let target = target.clone();
                let token = sockets_source.token();
                sockets.spawn(async move {
                    let mut stream = requests.open(target, token.clone()).await.map_err(ForwardEvent::ConnectFailed)?;
                    let result = tokio::select! {
                        biased;
                        _ = token.cancelled() => Ok(()),
                        result = tokio::io::copy_bidirectional(&mut socket, &mut stream) => {
                            result.map(|_| ()).map_err(|_| ForwardEvent::TransferFailed(Error::Transport))
                        },
                    };
                    stream.close().await.map_err(ForwardEvent::TransferFailed)?;
                    result
                });
            }
        }
    };
    // Joining this set is part of listener shutdown; no socket outlives its owner.
    drop(listener);
    sockets_source.cancel();
    while sockets.join_next().await.is_some() {}
    result
}

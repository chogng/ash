//! The synchronous facade blocks only its calling thread; Tokio owns IOCP registration,
//! readiness, timers and wakeups. One worker drives IPC for all synchronous callers.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

use futures::future::select_all;
use tokio::runtime::Builder;
use tokio::runtime::EnterGuard;
use tokio::runtime::Runtime;

use super::pipe::Direction;

pub(super) fn enter() -> io::Result<EnterGuard<'static>> {
    static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(1)
                .thread_name("ash-local-ipc")
                .enable_io()
                .enable_time()
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map(Runtime::enter)
        .map_err(|error| io::Error::other(error.clone()))
}

pub(super) fn wait(
    future: impl Future<Output = io::Result<()>>,
    timeout: Option<Duration>,
) -> io::Result<()> {
    let _runtime = enter()?;
    // Synchronous callers may already be polling a Tokio or futures task. This bridge
    // permits nesting and owns its wake signal, while our worker keeps driving IO.
    futures_lite::future::block_on(async {
        match timeout {
            Some(timeout) => tokio::time::timeout(timeout, future).await.map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "local IPC deadline elapsed")
            })?,
            None => future.await,
        }
    })
}

pub(crate) fn wait_for_ipc_activity(
    listener: Option<&crate::IpcListener>,
    readers: &[&crate::IpcStream],
    writers: &[&crate::IpcStream],
    timeout: Duration,
) -> io::Result<()> {
    let mut pending: Vec<Pin<Box<dyn Future<Output = io::Result<()>> + '_>>> = Vec::new();
    if let Some(listener) = listener {
        pending.push(Box::pin(listener.ready()));
    }
    pending.extend(
        readers
            .iter()
            .map(|stream| Box::pin(stream.ready(Direction::Read)) as _),
    );
    pending.extend(
        writers
            .iter()
            .map(|stream| Box::pin(stream.ready(Direction::Write)) as _),
    );
    if pending.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "IPC wait requires an endpoint",
        ));
    }
    match wait(async { select_all(pending).await.0 }, Some(timeout)) {
        Err(error) if error.kind() == io::ErrorKind::TimedOut => Ok(()),
        result => result,
    }
}

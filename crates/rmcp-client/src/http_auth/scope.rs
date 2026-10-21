use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

/// Transport lifetime for one login. Closing it rejects admission and wakes HTTP/SSE work;
/// draining waits for those futures and response bodies to release their resources.
#[derive(Default)]
pub struct HttpCredentialScope {
    state: Mutex<State>,
    drained: Condvar,
    closed: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
}

impl HttpCredentialScope {
    pub fn acquire(self: &Arc<Self>) -> Option<HttpCredentialLease> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return None;
        }
        state.active += 1;
        Some(HttpCredentialLease(Arc::clone(self)))
    }

    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.closed.send_replace(true);
    }

    pub fn drain(&self, timeout: Duration) -> Result<(), std::io::Error> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap();
        while state.active != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "MCP authorization retirement did not drain",
                ));
            }
            state = self.drained.wait_timeout(state, remaining).unwrap().0;
        }
        Ok(())
    }

    pub(crate) async fn cancelled(&self) {
        let mut closed = self.closed.subscribe();
        let _ = closed.wait_for(|closed| *closed).await;
    }
}

/// Keeps an admitted transport operation visible until its future or stream is dropped.
pub struct HttpCredentialLease(Arc<HttpCredentialScope>);

impl Drop for HttpCredentialLease {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.active -= 1;
        if state.active == 0 {
            self.0.drained.notify_all();
        }
    }
}

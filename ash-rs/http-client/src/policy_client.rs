use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientError;
use crate::HttpRequest;
use crate::HttpResponse;
use crate::OutboundNetworkPolicy;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const POLICY_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Ends a caller's active HTTP operation when its target becomes disallowed.
///
/// The transport is also required to check the policy before each network hop.
pub struct PolicyHttpClient {
    inner: Arc<dyn HttpClient>,
    policy: OutboundNetworkPolicy,
}

impl PolicyHttpClient {
    pub fn new(inner: Arc<dyn HttpClient>, policy: OutboundNetworkPolicy) -> Self {
        Self { inner, policy }
    }
}

impl HttpClient for PolicyHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.policy.check_url(request.url())?;
        let inner = Arc::clone(&self.inner);
        let url = request.url().to_owned();
        let request = request.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("ash-policy-http".into())
            .spawn(move || {
                let _ = sender.send(inner.execute(&request));
            })
            .map_err(|_| HttpClientError::Transport("failed to start HTTP request".into()))?;
        loop {
            self.policy.check_url(&url)?;
            match receiver.recv_timeout(POLICY_POLL_INTERVAL) {
                Ok(result) => {
                    self.policy.check_url(&url)?;
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HttpClientError::Transport(
                        "HTTP request ended without a result".into(),
                    ));
                }
            }
        }
    }

    fn execute_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        self.policy.check_url(request.url())?;
        let inner = Arc::clone(&self.inner);
        let url = request.url().to_owned();
        let request = request.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("ash-policy-http-stream".into())
            .spawn(move || {
                let mut channel_sink = ChannelSink {
                    sender: sender.clone(),
                };
                let result = inner.execute_streaming(&request, &mut channel_sink);
                let _ = sender.send(StreamMessage::Complete(result));
            })
            .map_err(|_| HttpClientError::Transport("failed to start HTTP stream".into()))?;
        loop {
            self.policy.check_url(&url)?;
            match receiver.recv_timeout(POLICY_POLL_INTERVAL) {
                Ok(StreamMessage::Chunk(chunk)) => {
                    self.policy.check_url(&url)?;
                    sink.emit(&chunk)?;
                }
                Ok(StreamMessage::Complete(result)) => {
                    self.policy.check_url(&url)?;
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HttpClientError::Transport(
                        "HTTP stream ended without a result".into(),
                    ));
                }
            }
        }
    }
}

enum StreamMessage {
    Chunk(Vec<u8>),
    Complete(Result<HttpResponse, HttpClientError>),
}

struct ChannelSink {
    sender: mpsc::SyncSender<StreamMessage>,
}

impl HttpBodySink for ChannelSink {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        self.sender
            .send(StreamMessage::Chunk(chunk.to_vec()))
            .map_err(|_| HttpClientError::Transport("stream consumer disconnected".into()))
    }
}

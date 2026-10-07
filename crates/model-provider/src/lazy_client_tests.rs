use super::LazyOperationClient;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct FixedClient;

impl OperationClient for FixedClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Ok(ClientResponse::new(200, Vec::new(), b"ok".to_vec()))
    }
}

#[test]
fn initializes_once_when_the_first_operation_executes() {
    let calls = Arc::new(AtomicUsize::new(0));
    let factory_calls = Arc::clone(&calls);
    let client = LazyOperationClient::new(move || {
        factory_calls.fetch_add(1, Ordering::Relaxed);
        Ok(Arc::new(FixedClient))
    });
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let request = request();

    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn caches_initialization_failure_as_a_transport_error() {
    let calls = Arc::new(AtomicUsize::new(0));
    let factory_calls = Arc::clone(&calls);
    let client = LazyOperationClient::new(move || {
        factory_calls.fetch_add(1, Ordering::Relaxed);
        Err(ClientError::Transport("platform roots unavailable".into()))
    });
    let request = request();

    for _ in 0..2 {
        assert_eq!(
            client.execute(&request),
            Err(ClientError::Transport("platform roots unavailable".into()))
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

fn request() -> ClientRequest {
    ClientRequest::post(
        "https://example.test/v1/responses",
        Vec::new(),
        Vec::new(),
        RetryPolicy::never(),
    )
    .unwrap()
}

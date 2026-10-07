use ash_async_utils::CancellationToken;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use std::sync::Arc;
use std::sync::OnceLock;

type ClientFactory =
    dyn Fn() -> Result<Arc<dyn OperationClient>, ClientError> + Send + Sync + 'static;

/// Defers fallible network-client construction until the first provider operation.
///
/// The first success or failure is cached for this runtime generation. Product composition can
/// therefore inspect configuration and start offline services without touching platform TLS or
/// proxy state, while the first real invocation still receives an explicit transport error.
pub(crate) struct LazyOperationClient {
    factory: Box<ClientFactory>,
    client: OnceLock<Result<Arc<dyn OperationClient>, ClientError>>,
}

impl LazyOperationClient {
    pub(crate) fn new(
        factory: impl Fn() -> Result<Arc<dyn OperationClient>, ClientError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            factory: Box::new(factory),
            client: OnceLock::new(),
        }
    }

    fn client(&self) -> Result<&dyn OperationClient, ClientError> {
        match self.client.get_or_init(|| (self.factory)()) {
            Ok(client) => Ok(client.as_ref()),
            Err(error) => Err(error.clone()),
        }
    }
}

impl OperationClient for LazyOperationClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.client()?.execute(request)
    }

    fn execute_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, ClientError> {
        cancellation
            .check()
            .map_err(|signal| ClientError::Cancelled(signal.reason().to_string()))?;
        self.client()?
            .execute_with_cancellation(request, cancellation)
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.client()?.execute_streaming(request, sink)
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        cancellation
            .check()
            .map_err(|signal| ClientError::Cancelled(signal.reason().to_string()))?;
        self.client()?
            .execute_streaming_with_cancellation(request, cancellation, sink)
    }
}

#[cfg(test)]
#[path = "lazy_client_tests.rs"]
mod tests;

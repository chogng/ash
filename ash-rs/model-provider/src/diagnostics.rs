use ash_async_utils::CancellationToken;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use response_debug_context::AuthHeader;
use response_debug_context::AuthRecovery;
use response_debug_context::DiagnosticOutcome;
use response_debug_context::RequestAttempt;
use response_debug_context::RequestOutcome;
use response_debug_context::ResponseDebugContext;
use response_debug_context::ResponseDiagnostic;
use response_debug_context::ResponseDiagnosticSink;
use response_debug_context::ResponseOperation;
use std::sync::Mutex;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

/// One invocation's evidence, collected before protocol/status decoding discards headers.
/// This wrapper observes operation results; replay policy remains with the wrapped client.
pub(crate) struct DiagnosticClient {
    client: Arc<dyn OperationClient>,
    sink: Option<Arc<dyn ResponseDiagnosticSink>>,
    diagnostic: Mutex<ResponseDiagnostic>,
    finished: AtomicBool,
}

impl DiagnosticClient {
    pub(crate) fn new(
        client: Arc<dyn OperationClient>,
        sink: Option<Arc<dyn ResponseDiagnosticSink>>,
        operation: ResponseOperation,
    ) -> Self {
        Self {
            client,
            sink,
            diagnostic: Mutex::new(ResponseDiagnostic::new(operation)),
            finished: AtomicBool::new(false),
        }
    }

    pub(crate) fn recovery(&self, recovery: AuthRecovery) {
        self.diagnostic
            .lock()
            .expect("response diagnostic lock poisoned")
            .recovery = recovery;
    }

    pub(crate) fn finish<T>(&self, result: &Result<T, crate::ModelProviderError>) {
        self.finish_with(match result {
            Ok(_) => DiagnosticOutcome::Succeeded,
            Err(crate::ModelProviderError::Cancelled(_)) => DiagnosticOutcome::Cancelled,
            Err(_) => DiagnosticOutcome::Failed,
        });
    }

    pub(crate) fn finish_with(&self, outcome: DiagnosticOutcome) {
        if self.finished.swap(true, Ordering::Relaxed) {
            return;
        }
        if let Some(sink) = &self.sink {
            let mut diagnostic = self
                .diagnostic
                .lock()
                .expect("response diagnostic lock poisoned")
                .clone();
            diagnostic.outcome = outcome;
            sink.record_response(diagnostic);
        }
    }

    fn observe(
        &self,
        request: &ClientRequest,
        result: Result<ClientResponse, ClientError>,
    ) -> Result<ClientResponse, ClientError> {
        let mut auth_headers = Vec::new();
        for header in request
            .headers()
            .iter()
            .filter(|header| !header.value().is_empty())
        {
            if let Some(name) = AuthHeader::from_name(header.name()) {
                if !auth_headers.contains(&name) {
                    auth_headers.push(name);
                }
            }
        }
        let (outcome, response) = match &result {
            Ok(response) => (
                RequestOutcome::Http {
                    status: response.status(),
                },
                ResponseDebugContext::from_headers(
                    response
                        .headers()
                        .iter()
                        .map(|header| (header.name(), header.value())),
                ),
            ),
            Err(error) => (
                match error {
                    ClientError::Cancelled(_) => RequestOutcome::Cancelled,
                    ClientError::InvalidRequest(_) => RequestOutcome::InvalidRequest,
                    ClientError::InvalidResponse(_) | ClientError::Framing(_) => {
                        RequestOutcome::InvalidResponse
                    }
                    ClientError::Transport(_) => RequestOutcome::TransportFailure,
                },
                ResponseDebugContext::default(),
            ),
        };
        self.diagnostic
            .lock()
            .expect("response diagnostic lock poisoned")
            .record(RequestAttempt {
                auth_headers,
                outcome,
                response,
            });
        result
    }
}

impl Drop for DiagnosticClient {
    fn drop(&mut self) {
        // A dropped catalog future or unwinding invocation must not erase its evidence.
        self.finish_with(DiagnosticOutcome::Abandoned);
    }
}

impl OperationClient for DiagnosticClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.observe(request, self.client.execute(request))
    }
    fn execute_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, ClientError> {
        self.observe(
            request,
            self.client.execute_with_cancellation(request, cancellation),
        )
    }
    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.observe(request, self.client.execute_streaming(request, sink))
    }
    fn execute_streaming_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.observe(
            request,
            self.client
                .execute_streaming_with_cancellation(request, cancellation, sink),
        )
    }
}

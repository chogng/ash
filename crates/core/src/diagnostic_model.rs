use crate::CoreError;
use crate::ModelStreamSink;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_rollout_trace::ModelAttemptTrace;

/// Records original semantic deltas before a consumer can reject or transform them.
pub(crate) struct DiagnosticStream<'a> {
    pub(crate) attempt: &'a mut ModelAttemptTrace,
    pub(crate) downstream: Option<&'a mut dyn ModelStreamSink>,
}

impl ModelStreamSink for DiagnosticStream<'_> {
    fn request_prepared(&mut self, request: &ModelRequest) {
        self.attempt.prepared_request(request);
        if let Some(downstream) = &mut self.downstream {
            downstream.request_prepared(request);
        }
    }

    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), CoreError> {
        self.attempt.output(&event);
        match &mut self.downstream {
            Some(sink) => sink.emit(event),
            None => Ok(()),
        }
    }
}

pub(crate) fn finish_attempt(
    attempt: &mut ModelAttemptTrace,
    result: &Result<ModelResponse, CoreError>,
) {
    match result {
        Ok(response) => attempt.complete(response),
        Err(CoreError::Cancelled(reason)) => attempt.cancel(reason),
        Err(error) => attempt.fail(&error.to_string()),
    }
}

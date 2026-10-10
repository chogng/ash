use crate::CoreError;
use crate::ModelStreamSink;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use core_api::ExecutionDiagnostics;
use core_api::InferenceContext;
use core_api::ModelAttemptObserver;

/// Records original semantic deltas before a consumer can reject or transform them.
pub(crate) struct DiagnosticStream<'a> {
    pub(crate) attempt: &'a mut Option<Box<dyn ModelAttemptObserver>>,
    pub(crate) downstream: Option<&'a mut dyn ModelStreamSink>,
}

impl ModelStreamSink for DiagnosticStream<'_> {
    fn request_prepared(&mut self, request: &ModelRequest) {
        if let Some(attempt) = self.attempt {
            attempt.prepared_request(request);
        }
        if let Some(downstream) = &mut self.downstream {
            downstream.request_prepared(request);
        }
    }

    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), CoreError> {
        if let Some(attempt) = self.attempt {
            attempt.output(&event);
        }
        match &mut self.downstream {
            Some(sink) => sink.emit(event),
            None => Ok(()),
        }
    }
}

pub(crate) fn finish_attempt(
    attempt: &mut Option<Box<dyn ModelAttemptObserver>>,
    result: &Result<ModelResponse, CoreError>,
) {
    let Some(attempt) = attempt else {
        return;
    };
    match result {
        Ok(response) => attempt.complete(response),
        Err(CoreError::Cancelled(reason)) => attempt.cancel(reason),
        Err(error) => attempt.fail(&error.to_string()),
    }
}

pub(crate) fn start_attempt(
    diagnostics: Option<&dyn ExecutionDiagnostics>,
    context: InferenceContext,
    request: &ModelRequest,
) -> Option<Box<dyn ModelAttemptObserver>> {
    diagnostics.and_then(|diagnostics| diagnostics.start_attempt(context, request))
}

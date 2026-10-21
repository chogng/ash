use crate::CoreError;
use crate::ModelStreamSink;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use core_api::ExecutionDiagnostics;
use core_api::InferenceContext;
use core_api::ModelAttemptObserver;
use std::time::Instant;

#[cfg(test)]
#[path = "diagnostic_model_tests.rs"]
mod tests;

/// Observes semantic body deltas even when diagnostic recording is disabled.
pub(crate) struct InvocationTimer {
    started: Instant,
    first_text_us: Option<u64>,
    text_delta_count: u64,
}

impl InvocationTimer {
    pub(crate) fn start() -> Self {
        Self {
            started: Instant::now(),
            first_text_us: None,
            text_delta_count: 0,
        }
    }

    fn observe(&mut self, event: &ModelStreamEvent, elapsed_us: u64) {
        let text = match event {
            ModelStreamEvent::TextDelta(text) | ModelStreamEvent::MessageDelta { text, .. } => text,
            ModelStreamEvent::ReasoningDelta(_)
            | ModelStreamEvent::MessageStarted { .. }
            | ModelStreamEvent::MessageCompleted(_) => return,
        };
        if !text.is_empty() {
            self.first_text_us.get_or_insert(elapsed_us);
            self.text_delta_count = self.text_delta_count.saturating_add(1);
        }
    }

    pub(crate) fn finish(
        &self,
        response: Option<&ModelResponse>,
    ) -> ash_protocol::ModelInvocationTiming {
        ash_protocol::ModelInvocationTiming {
            total_us: self.elapsed_us(),
            first_text_us: self.first_text_us,
            text_delta_count: self.text_delta_count,
            tool_call_count: response.map_or(0, |response| response.tool_calls().count() as u64),
        }
    }

    fn elapsed_us(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_micros()).unwrap_or(u64::MAX)
    }
}

/// Records original semantic deltas before a consumer can reject or transform them.
pub(crate) struct DiagnosticStream<'a> {
    pub(crate) timing: &'a mut InvocationTimer,
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
        self.timing.observe(&event, self.timing.elapsed_us());
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

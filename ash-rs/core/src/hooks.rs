use crate::CoreError;
use ash_async_utils::CancellationToken;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookDecision;
use core_api::BeforeToolHookRequest;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookService;
use core_api::TurnCompletedHookRequest;

/// Default Hook port for hosts that have no configured runtime.
pub struct NoHooks;

impl HookService for NoHooks {
    fn has_enabled_event(&self, _: ash_protocol::HookEvent) -> bool {
        false
    }

    fn event(
        &self,
        _: &HookEventRequest,
        cancellation: &CancellationToken,
    ) -> Result<HookEventDecision, CoreError> {
        check_cancellation(cancellation)?;
        Ok(HookEventDecision::Continue)
    }

    fn before_tool(
        &self,
        _: &BeforeToolHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<BeforeToolHookDecision, CoreError> {
        check_cancellation(cancellation)?;
        Ok(BeforeToolHookDecision::Continue)
    }

    fn after_tool(
        &self,
        _: &AfterToolHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError> {
        check_cancellation(cancellation)
    }

    fn turn_completed(
        &self,
        _: &TurnCompletedHookRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), CoreError> {
        check_cancellation(cancellation)
    }
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), CoreError> {
    cancellation
        .check()
        .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))
}

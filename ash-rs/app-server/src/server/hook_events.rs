use super::AppServer;
use super::RpcError;
use super::core_error;
use ash_async_utils::CancellationSource;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookService;

impl AppServer {
    pub(super) fn emit_hook_event(
        &self,
        request: &HookEventRequest,
    ) -> Result<HookEventDecision, RpcError> {
        let Some(hooks) = self.local_hook_runtime() else {
            return Ok(HookEventDecision::Continue);
        };
        let cancellation = CancellationSource::new();
        hooks
            .event(request, &cancellation.token())
            .map_err(core_error)
    }
}

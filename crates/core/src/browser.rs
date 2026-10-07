use ash_async_utils::CancellationToken;
use core_api::BrowserAction;
use core_api::BrowserActionResult;
use core_api::BrowserCapability;
use core_api::BrowserError;
use core_api::BrowserObservation;
use core_api::BrowserObserveRequest;
use core_api::BrowserTargetId;
use core_api::CreateBrowserTargetRequest;
use core_api::CreateBrowserTargetResult;

pub struct UnsupportedBrowserCapability;
impl BrowserCapability for UnsupportedBrowserCapability {
    fn create_target(
        &self,
        _: CreateBrowserTargetRequest,
        _: &CancellationToken,
    ) -> Result<CreateBrowserTargetResult, BrowserError> {
        Err(BrowserError::CapabilityUnavailable)
    }
    fn observe(
        &self,
        _: BrowserObserveRequest,
        _: &CancellationToken,
    ) -> Result<BrowserObservation, BrowserError> {
        Err(BrowserError::CapabilityUnavailable)
    }
    fn perform(
        &self,
        _: BrowserAction,
        _: &CancellationToken,
    ) -> Result<BrowserActionResult, BrowserError> {
        Err(BrowserError::CapabilityUnavailable)
    }
    fn close_target(&self, _: BrowserTargetId, _: &CancellationToken) -> Result<(), BrowserError> {
        Err(BrowserError::CapabilityUnavailable)
    }
}

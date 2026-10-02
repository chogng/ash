//! Start Plan billing and request policy, using the caller's ZCode account token.

use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::start_plan::ClientConfigs;
use backend_models::start_plan::Response;
use client::OperationClient;
use client::ResolvedApiTarget;

pub use backend_models::start_plan::Balance;

pub const SERVICE_URL: &str = "https://zcode.z.ai";
pub const MODEL_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

pub fn read_balance(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<Balance, RequestError> {
    let http = crate::client::Client::new(transport, target)?;
    let url = http.endpoint(["api", "v1", "zcode-plan", "billing", "balance"])?;
    let response: Response<Balance> = http.get(url, &[], cancellation)?;
    if response.code != 0 {
        return Err(RequestError::InvalidResponse);
    }
    Ok(response.data)
}

/// A model call can proceed without a captcha only when the current server policy says so.
/// Verification-required policy is not bypassed by reusing a proof or retrying the model call.
pub fn model_request_allowed(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<bool, RequestError> {
    let http = crate::client::Client::new(transport, target)?;
    let url = http.endpoint(["api", "v1", "client", "configs"])?;
    let response: Response<ClientConfigs> = http.get(url, &[], cancellation)?;
    if response.code != 0 {
        return Err(RequestError::InvalidResponse);
    }
    let captcha = response.data.configs.captcha;
    Ok(!captcha.enabled || captcha.skip_model_request)
}

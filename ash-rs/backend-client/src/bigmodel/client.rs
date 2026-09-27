//! BigModel Coding Plan business HTTP API with caller-owned login credentials.

use crate::RequestError;
use async_utils::CancellationToken;
use client::OperationClient;
use client::ResolvedApiTarget;

pub const BUSINESS_URL: &str = "https://bigmodel.cn";

/// Resolves a model request credential from an authenticated BigModel account.
pub fn issue_api_key(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<String, RequestError> {
    crate::coding_plan::issue_api_key(transport, target, false, cancellation)
}

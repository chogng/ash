//! BigModel Coding Plan business HTTP API with caller-owned login credentials.

use crate::RequestError;
use async_utils::CancellationToken;
use client::OperationClient;
use client::ResolvedApiTarget;

use crate::QuotaLimit;

pub const BUSINESS_URL: &str = "https://bigmodel.cn";
pub const MONITOR_URL: &str = "https://open.bigmodel.cn";

/// Reads quota with the current Coding Plan request key.
pub fn read_quota(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<Vec<QuotaLimit>, RequestError> {
    crate::coding_plan::read_quota(transport, target, cancellation)
}

/// Resolves a model request credential from an authenticated BigModel account.
pub fn issue_api_key(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<String, RequestError> {
    crate::coding_plan::issue_api_key(transport, target, false, cancellation)
}

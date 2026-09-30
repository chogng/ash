//! Z.AI Coding Plan business HTTP API with caller-owned login credentials.

use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::coding_plan::BusinessResponse;
use backend_models::zai::LoginRequest;
use backend_models::zai::LoginResponse;
use client::OperationClient;
use client::ResolvedApiTarget;

use crate::QuotaLimit;

pub const BUSINESS_URL: &str = "https://api.z.ai";

/// Reads quota with the current Coding Plan request key.
pub fn read_quota(
    transport: &dyn OperationClient,
    request_key: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<QuotaLimit>, RequestError> {
    let target = ResolvedApiTarget::new(
        BUSINESS_URL,
        vec![http_client::HttpHeader::new("Authorization", request_key)],
    );
    crate::coding_plan::read_quota(transport, &target, cancellation)
}

/// Exchanges the login token for a business token and resolves model request credentials.
pub fn issue_api_key(
    transport: &dyn OperationClient,
    oauth_access_token: &str,
    cancellation: &CancellationToken,
) -> Result<String, RequestError> {
    if oauth_access_token.trim().is_empty() {
        return Err(RequestError::InvalidRequest);
    }
    let target = ResolvedApiTarget::new(BUSINESS_URL, vec![]);
    let http = crate::client::Client::new(transport, &target)?;
    let response: BusinessResponse<LoginResponse> = http.post(
        http.endpoint(["api", "auth", "z", "login"])?,
        &LoginRequest {
            token: oauth_access_token,
        },
        cancellation,
    )?;
    let data = crate::coding_plan::data(response)?;
    if data.access_token.trim().is_empty() {
        return Err(RequestError::InvalidResponse);
    }
    let business_token = data.access_token;
    let business_target = ResolvedApiTarget::new(
        BUSINESS_URL,
        vec![http_client::HttpHeader::new(
            "Authorization",
            format!("Bearer {business_token}"),
        )],
    );
    crate::coding_plan::issue_api_key(transport, &business_target, true, cancellation)
}

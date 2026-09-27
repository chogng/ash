//! Z.AI Coding Plan business HTTP API with caller-owned login credentials.

use crate::RequestError;
use async_utils::CancellationToken;
use client::OperationClient;
use client::ResolvedApiTarget;
use serde_json::Value;

pub const BUSINESS_URL: &str = "https://api.z.ai";

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
    let response: Value = http.post(
        http.endpoint(["api", "auth", "z", "login"])?,
        &serde_json::json!({"token": oauth_access_token}),
        cancellation,
    )?;
    let data = crate::coding_plan::data(&response)?;
    let business_token = data["access_token"]
        .as_str()
        .or_else(|| data["accessToken"].as_str())
        .filter(|token| !token.trim().is_empty())
        .ok_or(RequestError::InvalidResponse)?;
    let business_target = ResolvedApiTarget::new(
        BUSINESS_URL,
        vec![http_client::HttpHeader::new(
            "Authorization",
            format!("Bearer {business_token}"),
        )],
    );
    crate::coding_plan::issue_api_key(transport, &business_target, true, cancellation)
}

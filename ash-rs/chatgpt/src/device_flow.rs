use crate::credential::TokenResponse;
use crate::oauth::AUTH_BASE_URL;
use crate::oauth::CLIENT_ID;
use crate::oauth::ChatGptError;
use ash_async_utils::CancellationToken;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use serde::Deserialize;
use serde::Serialize;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const DEVICE_USER_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URL: &str = "https://auth.openai.com/deviceauth/callback";
const DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
const MAX_POLL_DURATION: Duration = Duration::from_secs(15 * 60);
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub(crate) struct DeviceCode {
    pub(crate) verification_url: String,
    pub(crate) user_code: String,
    device_auth_id: String,
    interval: Duration,
}

#[derive(Serialize)]
struct UserCodeRequest<'a> {
    client_id: &'a str,
}

#[derive(Deserialize)]
struct UserCodeResponse {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    #[serde(default, deserialize_with = "deserialize_interval")]
    interval: u64,
}

#[derive(Serialize)]
struct PollRequest<'a> {
    device_auth_id: &'a str,
    user_code: &'a str,
}

#[derive(Deserialize)]
struct PollResponse {
    authorization_code: String,
    code_verifier: String,
}

pub(crate) fn request_device_code(
    client: &dyn OperationClient,
) -> Result<DeviceCode, ChatGptError> {
    let body = serde_json::to_vec(&UserCodeRequest {
        client_id: CLIENT_ID,
    })
    .map_err(|_| ChatGptError::new("ChatGPT device login could not be encoded"))?;
    let request = json_request(DEVICE_USER_CODE_URL, body)?;
    let response = client
        .execute(&request)
        .map_err(|_| ChatGptError::new("ChatGPT OAuth service is unavailable"))?;
    if !response.is_success() {
        return Err(ChatGptError::new(format!(
            "ChatGPT device authorization failed with HTTP {}",
            response.status()
        )));
    }
    let response: UserCodeResponse = serde_json::from_slice(response.body()).map_err(|_| {
        ChatGptError::new("OpenAI returned an invalid device authorization response")
    })?;
    if response.device_auth_id.trim().is_empty() || response.user_code.trim().is_empty() {
        return Err(ChatGptError::new(
            "OpenAI returned an incomplete device authorization response",
        ));
    }
    Ok(DeviceCode {
        verification_url: DEVICE_VERIFICATION_URL.into(),
        user_code: response.user_code,
        device_auth_id: response.device_auth_id,
        interval: Duration::from_secs(response.interval.max(1)),
    })
}

pub(crate) fn complete_device_login(
    client: &dyn OperationClient,
    device: &DeviceCode,
    cancellation: &CancellationToken,
) -> Result<TokenResponse, ChatGptError> {
    let deadline = Instant::now() + MAX_POLL_DURATION;
    loop {
        cancellation
            .check()
            .map_err(|_| ChatGptError::new("ChatGPT device authorization was cancelled"))?;
        let body = serde_json::to_vec(&PollRequest {
            device_auth_id: &device.device_auth_id,
            user_code: &device.user_code,
        })
        .map_err(|_| ChatGptError::new("ChatGPT device login could not be encoded"))?;
        let request = json_request(DEVICE_TOKEN_URL, body)?;
        let response = client
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| ChatGptError::new("ChatGPT OAuth service is unavailable"))?;
        if response.is_success() {
            let code: PollResponse = serde_json::from_slice(response.body())
                .map_err(|_| ChatGptError::new("OpenAI returned an invalid device token"))?;
            if code.authorization_code.trim().is_empty() || code.code_verifier.trim().is_empty() {
                return Err(ChatGptError::new(
                    "OpenAI returned an incomplete device token",
                ));
            }
            return exchange_code(client, &code, cancellation);
        }
        if response.status() != 403 && response.status() != 404 {
            return Err(ChatGptError::new(format!(
                "ChatGPT device authorization failed with HTTP {}",
                response.status()
            )));
        }
        if Instant::now() >= deadline {
            return Err(ChatGptError::new("ChatGPT device authorization expired"));
        }
        wait_with_cancellation(
            device
                .interval
                .min(deadline.saturating_duration_since(Instant::now())),
            cancellation,
        )?;
    }
}

fn exchange_code(
    client: &dyn OperationClient,
    code: &PollResponse,
    cancellation: &CancellationToken,
) -> Result<TokenResponse, ChatGptError> {
    let fields = [
        ("grant_type", "authorization_code"),
        ("code", code.authorization_code.as_str()),
        ("redirect_uri", DEVICE_REDIRECT_URL),
        ("client_id", CLIENT_ID),
        ("code_verifier", code.code_verifier.as_str()),
    ];
    let body = fields
        .iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                urlencoding::encode(name),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
        .into_bytes();
    let request = ClientRequest::post(
        format!("{AUTH_BASE_URL}/oauth/token"),
        vec![
            HttpHeader::new("Content-Type", "application/x-www-form-urlencoded"),
            HttpHeader::new("Accept", "application/json"),
            HttpHeader::new("User-Agent", super::oauth::user_agent()),
        ],
        body,
        RetryPolicy::never(),
    )
    .map_err(|_| ChatGptError::new("ChatGPT token exchange could not be constructed"))?;
    let response = client
        .execute_with_cancellation(&request, cancellation)
        .map_err(|_| ChatGptError::new("ChatGPT OAuth service is unavailable"))?;
    if !response.is_success() {
        return Err(ChatGptError::new(format!(
            "ChatGPT token exchange failed with HTTP {}",
            response.status()
        )));
    }
    serde_json::from_slice(response.body())
        .map_err(|_| ChatGptError::new("OpenAI returned an invalid token response"))
}

fn json_request(url: &str, body: Vec<u8>) -> Result<ClientRequest, ChatGptError> {
    ClientRequest::post(
        url,
        vec![
            HttpHeader::new("Content-Type", "application/json"),
            HttpHeader::new("Accept", "application/json"),
            HttpHeader::new("User-Agent", super::oauth::user_agent()),
        ],
        body,
        RetryPolicy::never(),
    )
    .map_err(|_| ChatGptError::new("ChatGPT OAuth request could not be constructed"))
}

fn wait_with_cancellation(
    duration: Duration,
    cancellation: &CancellationToken,
) -> Result<(), ChatGptError> {
    let mut remaining = duration;
    while !remaining.is_zero() {
        cancellation
            .check()
            .map_err(|_| ChatGptError::new("ChatGPT device authorization was cancelled"))?;
        let slice = remaining.min(CANCELLATION_POLL_INTERVAL);
        thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
    Ok(())
}

fn deserialize_interval<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Interval {
        Number(u64),
        Text(String),
    }
    match Interval::deserialize(deserializer)? {
        Interval::Number(value) => Ok(value),
        Interval::Text(value) => value.trim().parse().map_err(serde::de::Error::custom),
    }
}

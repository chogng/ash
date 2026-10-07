use crate::CallError;
use crate::CallMember;
use crate::CallRole;
use crate::CallSnapshot;
use crate::MemberCredential;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

/// Member-scoped authority client. Media credentials never enter the product UI.
#[derive(Clone)]
pub struct CallClient {
    url: String,
    credential: Arc<MemberCredential>,
    transport: Arc<dyn HttpClient>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJoin {
    pub call: CallSnapshot,
    pub member: CallMember,
    pub microphone: bool,
    pub participant_id: String,
    pub server_url: String,
    pub participant_token: String,
    pub expires_at: u64,
}

impl CallClient {
    pub fn new(
        url: &str,
        credential: MemberCredential,
        transport: Arc<dyn HttpClient>,
    ) -> Result<Self, CallError> {
        let parsed = url::Url::parse(url).map_err(|_| CallError::Invalid)?;
        let loopback = match parsed.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if parsed.host().is_none()
            || !matches!(parsed.scheme(), "http" | "https")
            || (parsed.scheme() == "http" && !loopback)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err(CallError::Invalid);
        }
        Ok(Self {
            url: url.trim_end_matches('/').into(),
            credential: Arc::new(credential),
            transport,
        })
    }

    pub fn create(&self, administrator: &str, operation: &str) -> Result<CallSnapshot, CallError> {
        self.request(
            HttpMethod::Post,
            "/v1/calls/create",
            administrator,
            json!({"operationId": operation, "ownerCredential": self.credential.expose()}),
        )
    }

    pub fn read(&self) -> Result<CallSnapshot, CallError> {
        self.request(
            HttpMethod::Get,
            "/v1/calls/read",
            self.credential.expose(),
            Value::Null,
        )
    }

    pub fn watch(&self, revision: u64) -> Result<CallSnapshot, CallError> {
        self.request(
            HttpMethod::Get,
            &format!("/v1/calls/watch?afterRevision={revision}"),
            self.credential.expose(),
            Value::Null,
        )
    }

    pub fn join(&self, device: &str) -> Result<MediaJoin, CallError> {
        self.member_request("join", json!({"deviceId": device}))
    }

    pub fn invite(
        &self,
        operation: &str,
        revision: u64,
        credential: &MemberCredential,
        role: CallRole,
    ) -> Result<CallSnapshot, CallError> {
        self.member_request("invite", json!({"operationId":operation, "revision":revision, "memberCredential":credential.expose(), "role":role}))
    }

    pub fn remove(
        &self,
        operation: &str,
        revision: u64,
        member: &str,
    ) -> Result<CallSnapshot, CallError> {
        self.member_request(
            "remove",
            json!({"operationId":operation, "revision":revision, "memberId":member}),
        )
    }

    pub fn set_role(
        &self,
        operation: &str,
        revision: u64,
        member: &str,
        role: CallRole,
    ) -> Result<CallSnapshot, CallError> {
        self.member_request(
            "role",
            json!({"operationId":operation, "revision":revision, "memberId":member,"role":role}),
        )
    }

    pub fn select_device(
        &self,
        operation: &str,
        revision: u64,
        device: &str,
    ) -> Result<CallSnapshot, CallError> {
        self.member_request(
            "device",
            json!({"operationId":operation, "revision":revision, "deviceId":device}),
        )
    }

    pub fn end(&self, operation: &str, revision: u64) -> Result<CallSnapshot, CallError> {
        self.member_request("end", json!({"operationId":operation, "revision":revision}))
    }

    fn member_request<T: DeserializeOwned>(
        &self,
        operation: &str,
        body: Value,
    ) -> Result<T, CallError> {
        self.request(
            HttpMethod::Post,
            &format!("/v1/calls/{operation}"),
            self.credential.expose(),
            body,
        )
    }

    fn request<T: DeserializeOwned>(
        &self,
        method: HttpMethod,
        path: &str,
        token: &str,
        body: Value,
    ) -> Result<T, CallError> {
        let request = HttpRequest::new(
            method,
            format!("{}{path}", self.url),
            vec![
                HttpHeader::new("Authorization", format!("Bearer {token}")),
                HttpHeader::new("Content-Type", "application/json"),
            ],
            if body.is_null() {
                Vec::new()
            } else {
                serde_json::to_vec(&body).map_err(|_| CallError::Invalid)?
            },
        )
        .map_err(|_| CallError::Invalid)?;
        let response = self
            .transport
            .execute(&request)
            .map_err(|_| CallError::Transport)?;
        match response.status() {
            200 => serde_json::from_slice(response.body()).map_err(|_| CallError::Transport),
            401 | 403 => Err(CallError::Denied),
            409 => {
                let body: Value =
                    serde_json::from_slice(response.body()).map_err(|_| CallError::Transport)?;
                if body["error"]["code"] == "mediaNotReady" {
                    Err(CallError::NotReady)
                } else {
                    Err(CallError::Conflict)
                }
            }
            400 => Err(CallError::Invalid),
            _ => Err(CallError::Transport),
        }
    }
}

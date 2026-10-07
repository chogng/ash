use crate::ClientError;
use crate::ClientRequest;
use crate::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use sha2::Digest;
use sha2::Sha256;
use std::fmt;
use url::Url;

/// The credential owner supplies identity from the same snapshot as its headers.
/// API keys and pre-login exchanges have a connection identity; signed-in domains
/// additionally bind their account and persisted credential revision.
#[derive(Clone, Default, Eq, PartialEq)]
pub enum RequestIdentity {
    #[default]
    Anonymous,
    Connection {
        connection: String,
        revision: [u8; 32],
    },
    Account {
        connection: String,
        account_id: String,
        revision: u64,
    },
}

impl RequestIdentity {
    pub fn connection(connection: impl Into<String>, credential: &[u8]) -> Self {
        Self::Connection {
            connection: connection.into(),
            revision: Sha256::digest(credential).into(),
        }
    }

    pub fn account(
        connection: impl Into<String>,
        account_id: impl Into<String>,
        revision: u64,
    ) -> Self {
        Self::Account {
            connection: connection.into(),
            account_id: account_id.into(),
            revision,
        }
    }
}

impl fmt::Debug for RequestIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Anonymous => f.write_str("Anonymous"),
            Self::Connection { connection, .. } => f
                .debug_struct("Connection")
                .field("connection", connection)
                .finish_non_exhaustive(),
            Self::Account { connection, .. } => f
                .debug_struct("Account")
                .field("connection", connection)
                .finish_non_exhaustive(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestPurpose {
    /// Generation, semantic inference and model-service catalog operations.
    Model,
    /// Preflight counting, with its separately configured protocol and destination.
    InputTokenCount,
    /// Subscription business operations, including their account-scoped catalogs.
    Account,
}

/// A resolved operation never changes purpose or identity after credential resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestBinding {
    purpose: RequestPurpose,
    identity: RequestIdentity,
}

impl RequestBinding {
    pub fn new(purpose: RequestPurpose, identity: RequestIdentity) -> Self {
        Self { purpose, identity }
    }
    pub fn purpose(&self) -> RequestPurpose {
        self.purpose
    }
    pub fn identity(&self) -> &RequestIdentity {
        &self.identity
    }
}

/// An immutable credential destination issued by its owning domain. Adapters may
/// add protocol headers and paths, but cannot move credentials to another origin.
#[derive(Clone, Eq, PartialEq)]
pub struct ResolvedApiTarget {
    base_url: String,
    headers: Vec<HttpHeader>,
    retry_policy: RetryPolicy,
    binding: RequestBinding,
}

impl fmt::Debug for ResolvedApiTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Invalid caller URLs may embed secrets. Only a validated origin is safe
        // to include, even before an endpoint has attempted network dispatch.
        f.debug_struct("ResolvedApiTarget")
            .field(
                "origin",
                &self.base().map(|url| url.origin().ascii_serialization()),
            )
            .field("headers", &self.headers)
            .field("retry_policy", &self.retry_policy)
            .field("binding", &self.binding)
            .finish()
    }
}

impl ResolvedApiTarget {
    pub fn new(
        base_url: impl Into<String>,
        headers: Vec<HttpHeader>,
        binding: RequestBinding,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            headers,
            retry_policy: RetryPolicy::never(),
            binding,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
    pub fn headers(&self) -> &[HttpHeader] {
        &self.headers
    }
    pub fn retry_policy(&self) -> RetryPolicy {
        self.retry_policy
    }
    pub fn binding(&self) -> &RequestBinding {
        &self.binding
    }

    pub fn require_purpose(&self, purpose: RequestPurpose) -> Result<(), ClientError> {
        if self.binding.purpose != purpose {
            return Err(ClientError::InvalidRequest(
                "API request purpose does not match its credential binding".into(),
            ));
        }
        Ok(())
    }

    pub fn with_retry_policy(mut self, retry_policy: RetryPolicy) -> Self {
        self.retry_policy = retry_policy;
        self
    }

    pub fn with_headers(mut self, headers: Vec<HttpHeader>) -> Result<Self, ClientError> {
        self.headers = merge_headers(self.headers, headers)?;
        Ok(self)
    }

    pub fn endpoint(&self, path: &str) -> Result<String, ClientError> {
        let base = self.base()?;
        // Reject traversal before URL normalization can erase the offending segments.
        if path.contains(['\\', '?', '#'])
            || path.contains("://")
            || path.starts_with("//")
            || path.split('/').any(|part| {
                matches!(part, "." | "..")
                    || part.to_ascii_lowercase().contains("%2e")
                    || part.to_ascii_lowercase().contains("%2f")
                    || part.to_ascii_lowercase().contains("%5c")
            })
        {
            return Err(ClientError::InvalidRequest(
                "invalid API endpoint path".into(),
            ));
        }
        Ok(format!(
            "{}/{}",
            base.as_str().trim_end_matches('/'),
            path.trim_start_matches('/')
        ))
    }

    /// Checks the final HTTP or equivalent WebSocket origin, including effective port.
    /// Business endpoints may own several paths on this origin; only their domain
    /// decides which base and operation-purpose binding to issue.
    pub fn validate_destination(&self, destination: &str) -> Result<(), ClientError> {
        let base = self.base()?;
        let mut url = Url::parse(destination).map_err(|_| invalid_target())?;
        match url.scheme() {
            "ws" => {
                url.set_scheme("http").map_err(|_| invalid_target())?;
            }
            "wss" => {
                url.set_scheme("https").map_err(|_| invalid_target())?;
            }
            "http" | "https" => {}
            _ => return Err(invalid_target()),
        }
        if url.origin() != base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(ClientError::InvalidRequest(
                "API destination is outside its credential origin".into(),
            ));
        }
        Ok(())
    }

    pub fn request(
        &self,
        method: HttpMethod,
        destination: impl Into<String>,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
    ) -> Result<ClientRequest, ClientError> {
        let destination = destination.into();
        self.validate_destination(&destination)?;
        let headers = merge_headers(self.headers.clone(), headers)?;
        // Even connection-specific proof headers must never cross a redirect. This
        // rule follows the binding, not a guessed list of credential header names.
        Ok(
            ClientRequest::new(method, destination, headers, body, self.retry_policy)?
                .without_redirects(),
        )
    }

    fn base(&self) -> Result<Url, ClientError> {
        let url = Url::parse(&self.base_url).map_err(|_| invalid_target())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid_target());
        }
        Ok(url)
    }
}

fn invalid_target() -> ClientError {
    ClientError::InvalidRequest("invalid API credential destination".into())
}

/// One case-insensitive merge rule for domain and protocol headers. Conflicts
/// fail before transport; diagnostics contain the header name, never its value.
pub fn merge_headers(
    input: Vec<HttpHeader>,
    additional: impl IntoIterator<Item = HttpHeader>,
) -> Result<Vec<HttpHeader>, ClientError> {
    let mut headers: Vec<HttpHeader> = Vec::new();
    for header in input.into_iter().chain(additional) {
        header.validate()?;
        if let Some(existing) = headers
            .iter()
            .find(|existing| existing.name().eq_ignore_ascii_case(header.name()))
        {
            if existing.value() != header.value() {
                return Err(ClientError::InvalidRequest(format!(
                    "conflicting API request header: {}",
                    header.name()
                )));
            }
        } else {
            headers.push(header);
        }
    }
    Ok(headers)
}

#[cfg(test)]
#[path = "target_tests.rs"]
mod tests;

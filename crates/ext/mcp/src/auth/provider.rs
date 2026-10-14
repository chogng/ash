//! Standard HTTP MCP OAuth adapter. Protocol state stays in the private lifecycle credential;
//! the MCP transport receives only the bearer and never owns discovery or persistence.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_secrets::SecretValue;
use serde::Deserialize;
use serde::Serialize;
use url::Url;
use zeroize::Zeroize;

use super::*;

pub struct HttpOAuthProvider {
    http: Arc<dyn HttpClient>,
    pending: Mutex<BTreeMap<String, (Instant, Registration)>>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Registration {
    issuer: String,
    require_issuer: bool,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    client_id: String,
    client_secret: Option<String>,
    resource: String,
    scopes: Vec<String>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.client_secret.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
struct Tokens {
    registration: Registration,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
}

impl Drop for Tokens {
    fn drop(&mut self) {
        self.refresh_token.zeroize();
    }
}

#[derive(Deserialize)]
struct ResourceMetadata {
    resource: String,
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Deserialize)]
struct Metadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    revocation_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    client_id_metadata_document_supported: bool,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

impl HttpOAuthProvider {
    pub fn new(http: Arc<dyn HttpClient>) -> Self {
        Self {
            http,
            pending: Mutex::new(BTreeMap::new()),
        }
    }

    fn request(
        &self,
        method: HttpMethod,
        endpoint: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> Result<HttpResponse, McpOAuthError> {
        self.request_authenticated(method, endpoint, content_type, body, None)
    }

    fn request_authenticated(
        &self,
        method: HttpMethod,
        endpoint: &str,
        content_type: &str,
        body: Vec<u8>,
        registration: Option<&Registration>,
    ) -> Result<HttpResponse, McpOAuthError> {
        endpoint_url(endpoint)?;
        let mut headers = vec![
            HttpHeader::new("Content-Type", content_type),
            HttpHeader::new("Accept", "application/json, text/event-stream"),
        ];
        if let Some(registration) = registration
            && let Some(secret) = &registration.client_secret
        {
            use base64::Engine as _;
            let encoded_id = form(&[("", registration.client_id.as_str())]);
            let encoded_secret = zeroize::Zeroizing::new(form(&[("", secret.as_str())]));
            let pair =
                zeroize::Zeroizing::new([&encoded_id[1..], b":", &encoded_secret[1..]].concat());
            headers.push(HttpHeader::new(
                "Authorization",
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(pair.as_slice())
                ),
            ));
        }
        let request = HttpRequest::new(method, endpoint, headers, body)
            .map_err(|_| failure())?
            .without_redirects();
        let response = self.http.execute(&request).map_err(|_| failure())?;
        if response.body().len() > 1024 * 1024 {
            return Err(failure());
        }
        Ok(response)
    }

    fn json<T: serde::de::DeserializeOwned>(&self, endpoint: &str) -> Result<T, McpOAuthError> {
        let response = self.request(HttpMethod::Get, endpoint, "application/json", Vec::new())?;
        if !response.is_success() {
            return Err(failure());
        }
        serde_json::from_slice(response.body()).map_err(|_| failure())
    }

    fn discover(
        &self,
        target: &McpOAuthTarget,
    ) -> Result<(ResourceMetadata, Metadata, Option<String>), McpOAuthError> {
        // Initialize is protocol discovery, never a tool invocation. Probe POST because an MCP
        // server may disable GET/SSE and publish its protected-resource metadata only in a 401.
        let response = self.request(HttpMethod::Post, target.endpoint().as_str(), "application/json", serde_json::to_vec(&serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
                "protocolVersion":"2025-11-25", "capabilities":{}, "clientInfo":{"name":"Ash","version":"1"}
            }
        })).map_err(|_| failure())?)?;
        let challenge = response
            .headers()
            .iter()
            .find(|h| h.name().eq_ignore_ascii_case("www-authenticate"))
            .map(|h| h.value());
        let metadata_url = challenge.and_then(|h| challenge_value(h, "resource_metadata"));
        let scope = challenge.and_then(|h| challenge_value(h, "scope"));
        let base = target.endpoint().origin().ascii_serialization();
        let resource: ResourceMetadata = if let Some(url) = metadata_url {
            self.json(&url)?
        } else {
            self.json(&format!(
                "{base}/.well-known/oauth-protected-resource{}",
                target.endpoint().path().trim_end_matches('/')
            ))
            .or_else(|_| self.json(&format!("{base}/.well-known/oauth-protected-resource")))?
        };
        if resource.resource.trim_end_matches('/')
            != target.endpoint().as_str().trim_end_matches('/')
        {
            return Err(failure());
        }
        let issuer = resource.authorization_servers.first().ok_or_else(failure)?;
        let metadata = self.metadata(issuer)?;
        Ok((resource, metadata, scope))
    }

    fn metadata(&self, issuer: &str) -> Result<Metadata, McpOAuthError> {
        let url = endpoint_url(issuer)?;
        let base = url.origin().ascii_serialization();
        let path = url.path().trim_end_matches('/');
        let metadata: Metadata = self
            .json(&format!(
                "{base}/.well-known/oauth-authorization-server{path}"
            ))
            .or_else(|_| self.json(&format!("{base}/.well-known/openid-configuration{path}")))
            .or_else(|_| self.json(&format!("{issuer}/.well-known/openid-configuration")))?;
        if metadata.issuer != issuer
            || !metadata
                .code_challenge_methods_supported
                .iter()
                .any(|value| value == "S256")
        {
            return Err(failure());
        }
        endpoint_url(&metadata.authorization_endpoint)?;
        endpoint_url(&metadata.token_endpoint)?;
        Ok(metadata)
    }

    fn token(
        &self,
        registration: Registration,
        fields: &[(&str, &str)],
        previous_refresh: Option<String>,
    ) -> Result<McpOAuthCredential, McpOAuthError> {
        let mut fields = fields.to_vec();
        fields.push(("client_id", &registration.client_id));
        fields.push(("resource", &registration.resource));
        let response = self.request_authenticated(
            HttpMethod::Post,
            &registration.token_endpoint,
            "application/x-www-form-urlencoded",
            form(&fields),
            Some(&registration),
        )?;
        if !response.is_success() {
            let rejected = serde_json::from_slice::<serde_json::Value>(response.body())
                .ok()
                .is_some_and(|v| v["error"] == "invalid_grant");
            return Err(if rejected {
                oauth_error(
                    McpOAuthErrorKind::ReauthenticationRequired,
                    "MCP OAuth requires sign-in",
                )
            } else {
                failure()
            });
        }
        #[derive(Deserialize)]
        struct Response {
            access_token: String,
            token_type: String,
            refresh_token: Option<String>,
            expires_in: Option<u64>,
        }
        impl Drop for Response {
            fn drop(&mut self) {
                self.access_token.zeroize();
                self.refresh_token.zeroize();
            }
        }
        let mut response: Response =
            serde_json::from_slice(response.body()).map_err(|_| failure())?;
        if !response.token_type.eq_ignore_ascii_case("bearer")
            || response.access_token.trim().is_empty()
            || response.access_token.contains(['\r', '\n'])
        {
            return Err(failure());
        }
        let tokens = Tokens {
            registration,
            refresh_token: response.refresh_token.take().or(previous_refresh),
            expires_at: response
                .expires_in
                .map(|seconds| now().saturating_add(seconds)),
        };
        Ok(McpOAuthCredential {
            runtime_secret: SecretValue::new(
                std::mem::take(&mut response.access_token).into_bytes(),
            ),
            lifecycle_secret: SecretValue::new(serde_json::to_vec(&tokens).map_err(|_| failure())?),
        })
    }
}

impl McpOAuthProvider for HttpOAuthProvider {
    fn cancel(&self, challenge: &str) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(challenge);
    }

    fn authorization_url(
        &self,
        target: &McpOAuthTarget,
        challenge: McpOAuthChallenge<'_>,
    ) -> Result<String, McpOAuthError> {
        let (resource, metadata, challenged_scope) = self.discover(target)?;
        if !metadata.authorization_response_iss_parameter_supported {
            use sha2::Digest;
            let expected_path = format!(
                "/mcp-oauth/{:x}/callback",
                sha2::Sha256::digest(target.endpoint().as_str().as_bytes())
            );
            if Url::parse(challenge.redirect_uri)
                .map_err(|_| failure())?
                .path()
                != expected_path
            {
                return Err(oauth_error(
                    McpOAuthErrorKind::InvalidRequest,
                    "MCP OAuth callback must be bound to this server",
                ));
            }
        }
        let mut scopes: Vec<String> = if let Some(scope) = challenged_scope {
            scope.split_whitespace().map(str::to_owned).collect()
        } else if !resource.scopes_supported.is_empty() {
            resource.scopes_supported
        } else {
            challenge.options.scopes.clone()
        };
        if metadata
            .scopes_supported
            .iter()
            .any(|scope| scope == "offline_access")
            && !scopes.iter().any(|scope| scope == "offline_access")
        {
            scopes.push("offline_access".into());
        }
        let (client_id, client_secret) = if let Some(id) = &challenge.options.client_id {
            if id.trim().is_empty() {
                return Err(failure());
            }
            (id.clone(), None)
        } else if let Some(url) = &challenge.options.client_metadata_url
            && metadata.client_id_metadata_document_supported
        {
            endpoint_url(url)?;
            (url.clone(), None)
        } else {
            let endpoint = metadata.registration_endpoint.as_deref().ok_or_else(|| {
                oauth_error(
                    McpOAuthErrorKind::RegistrationRequired,
                    "MCP OAuth needs a registered client ID",
                )
            })?;
            let response = self.request(HttpMethod::Post, endpoint, "application/json", serde_json::to_vec(&serde_json::json!({
                "client_name": "Ash", "redirect_uris": [challenge.redirect_uri], "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "token_endpoint_auth_method": "none", "application_type": "native", "scope": scopes.join(" ")
            })).map_err(|_| failure())?)?;
            #[derive(Deserialize)]
            struct Registered {
                client_id: String,
                client_secret: Option<String>,
            }
            if !response.is_success() {
                return Err(failure());
            }
            let registered: Registered =
                serde_json::from_slice(response.body()).map_err(|_| failure())?;
            if registered.client_id.trim().is_empty() {
                return Err(failure());
            }
            (
                registered.client_id,
                registered.client_secret.filter(|secret| !secret.is_empty()),
            )
        };
        // A callback carries `iss` separately; the service validates it before any code exchange.
        let mut url = endpoint_url(&metadata.authorization_endpoint)?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", challenge.redirect_uri)
            .append_pair("state", challenge.state)
            .append_pair("code_challenge", challenge.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", challenge.resource.as_str())
            .append_pair("scope", &scopes.join(" "));
        let registration = Registration {
            require_issuer: metadata.authorization_response_iss_parameter_supported,
            issuer: metadata.issuer,
            token_endpoint: metadata.token_endpoint,
            revocation_endpoint: metadata.revocation_endpoint,
            client_id,
            client_secret,
            resource: challenge.resource.to_string(),
            scopes,
        };
        let mut pending = self.pending.lock().map_err(|_| failure())?;
        pending.retain(|_, (started, _)| started.elapsed() <= FLOW_LIFETIME);
        if pending.len() >= MAX_PENDING_OAUTH_FLOWS {
            return Err(failure());
        }
        // The verifier-derived challenge avoids any second source of PKCE/state authority.
        pending.insert(
            challenge.code_challenge.to_owned(),
            (Instant::now(), registration),
        );
        Ok(url.to_string())
    }

    fn exchange(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthExchangeRequest<'_>,
    ) -> Result<McpOAuthCredential, McpOAuthError> {
        let (_, registration) = self
            .pending
            .lock()
            .map_err(|_| failure())?
            .remove(&pkce_challenge(request.pkce_verifier))
            .ok_or_else(failure)?;
        if registration.resource != request.resource.as_str()
            || request
                .issuer
                .is_some_and(|issuer| issuer != registration.issuer)
            || (registration.require_issuer && request.issuer.is_none())
        {
            return Err(failure());
        }
        let code =
            std::str::from_utf8(request.authorization_code.expose()).map_err(|_| failure())?;
        self.token(
            registration,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", request.pkce_verifier),
                ("redirect_uri", request.redirect_uri),
            ],
            None,
        )
    }

    fn validate_credential(
        &self,
        target: &McpOAuthTarget,
        credential: &SecretValue,
    ) -> Result<(), McpOAuthError> {
        let tokens: Tokens = serde_json::from_slice(credential.expose()).map_err(|_| failure())?;
        if tokens.registration.resource != target.endpoint().as_str() {
            return Err(oauth_error(
                McpOAuthErrorKind::ReauthenticationRequired,
                "MCP OAuth endpoint changed; sign-in required",
            ));
        }
        endpoint_url(&tokens.registration.issuer)?;
        endpoint_url(&tokens.registration.token_endpoint)?;
        Ok(())
    }

    fn needs_refresh(&self, credential: &SecretValue) -> Result<bool, McpOAuthError> {
        let tokens: Tokens = serde_json::from_slice(credential.expose()).map_err(|_| failure())?;
        Ok(tokens
            .expires_at
            .is_some_and(|expiry| expiry <= now().saturating_add(30)))
    }

    fn access_is_usable(&self, credential: &SecretValue) -> Result<bool, McpOAuthError> {
        let tokens: Tokens = serde_json::from_slice(credential.expose()).map_err(|_| failure())?;
        Ok(tokens.expires_at.is_none_or(|expiry| expiry > now()))
    }

    fn refresh(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthRefreshRequest<'_>,
    ) -> Result<McpOAuthCredentialReplacement, McpOAuthError> {
        let mut tokens: Tokens =
            serde_json::from_slice(request.credential.expose()).map_err(|_| failure())?;
        if tokens.registration.resource != request.resource.as_str() {
            return Err(failure());
        }
        let metadata = self.metadata(&tokens.registration.issuer)?;
        if metadata.token_endpoint != tokens.registration.token_endpoint {
            return Err(failure());
        }
        let refresh = tokens.refresh_token.take().ok_or_else(|| {
            oauth_error(
                McpOAuthErrorKind::ReauthenticationRequired,
                "MCP OAuth requires sign-in",
            )
        })?;
        let registration: Registration = tokens.registration.clone();
        let mut refresh = refresh;
        let result = self.token(
            registration,
            &[("grant_type", "refresh_token"), ("refresh_token", &refresh)],
            Some(refresh.clone()),
        );
        refresh.zeroize();
        let value = result?;
        Ok(McpOAuthCredentialReplacement {
            runtime_secret: value.runtime_secret,
            lifecycle_secret: value.lifecycle_secret,
        })
    }

    fn revoke(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthRevokeRequest<'_>,
    ) -> Result<(), McpOAuthError> {
        let tokens: Tokens =
            serde_json::from_slice(request.credential.expose()).map_err(|_| failure())?;
        if tokens.registration.resource != request.resource.as_str() {
            return Err(failure());
        }
        let endpoint = tokens
            .registration
            .revocation_endpoint
            .as_deref()
            .ok_or_else(failure)?;
        let refresh = tokens.refresh_token.as_deref().ok_or_else(failure)?;
        let fields = vec![
            ("client_id", tokens.registration.client_id.as_str()),
            ("token", refresh),
            ("token_type_hint", "refresh_token"),
        ];
        let response = self.request_authenticated(
            HttpMethod::Post,
            endpoint,
            "application/x-www-form-urlencoded",
            form(&fields),
            Some(&tokens.registration),
        )?;
        if !response.is_success() {
            return Err(failure());
        }
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn failure() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::ProviderFailure,
        "MCP OAuth operation failed",
    )
}
fn endpoint_url(value: &str) -> Result<Url, McpOAuthError> {
    let url = Url::parse(value).map_err(|_| failure())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(failure());
    }
    Ok(url)
}
fn form(fields: &[(&str, &str)]) -> Vec<u8> {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields.iter().copied())
        .finish()
        .into_bytes()
}
fn challenge_value(header: &str, name: &str) -> Option<String> {
    header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))?
        .split(',')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.trim().trim_matches('"').to_owned())
        })
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;

use super::DYNAMIC_CLIENT;
use super::ISSUER;
use super::RESOURCE;
use super::failure;
use super::storage::Registration;
use super::storage::Tokens;
use super::storage::now;
use crate::ChatGptError;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use base64::Engine;
use jsonwebtoken::Algorithm;
use jsonwebtoken::DecodingKey;
use jsonwebtoken::Validation;
use jsonwebtoken::jwk::JwkSet;
use serde::Deserialize;
use sha2::Digest;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use url::Url;
use zeroize::Zeroize;
use zeroize::Zeroizing;

const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

pub(super) struct Grant {
    listener: TcpListener,
    pub(super) url: String,
    pub(super) selected: Option<Registration>,
    redirect_uri: String,
    state: String,
    nonce: String,
    verifier: Zeroizing<String>,
}

impl Grant {
    pub(super) fn new(host: &str, selected: Option<Registration>) -> Result<Self, ChatGptError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|_| failure("ChatGPT callback listener is unavailable"))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| failure("ChatGPT callback listener is unavailable"))?;
        let port = listener
            .local_addr()
            .map_err(|_| failure("ChatGPT callback port is unavailable"))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");
        let state = random()?;
        let nonce = random()?;
        let verifier = Zeroizing::new(random()?);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        let mut url = Url::parse("https://auth.openai.com/api/accounts/authorize")
            .expect("constant authorize URL");
        url.query_pairs_mut().extend_pairs([
            (
                "client_id",
                selected
                    .as_ref()
                    .map_or(DYNAMIC_CLIENT, |account| account.client_id.as_str()),
            ),
            ("ext_agent_host_id", host),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", state.as_str()),
            ("nonce", nonce.as_str()),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
        ]);
        if selected.is_none() {
            url.query_pairs_mut().append_pair("agent_name_hint", "Ash");
        }
        // LoginService returns browser instructions over RPC. Omit the optional ID-token hint
        // here so no retained token enters renderer state, diagnostics or event transcripts.
        Ok(Self {
            listener,
            url: url.into(),
            selected,
            redirect_uri,
            state,
            nonce,
            verifier,
        })
    }
}

// OAuth network operations have a shorter lifetime than the profile credential
// owner; a callback worker can retain this client without retaining saved state.
#[derive(Clone)]
pub(super) struct Client {
    transport: Arc<dyn OperationClient>,
}

impl Client {
    pub(super) fn new(transport: Arc<dyn OperationClient>) -> Self {
        Self { transport }
    }

    pub(super) fn authorize(
        &self,
        grant: Grant,
        cancellation: &CancellationToken,
    ) -> Result<Registration, ChatGptError> {
        let expires = Instant::now() + Duration::from_secs(600);
        loop {
            if cancellation.is_cancelled() {
                return Err(failure("ChatGPT authorization was cancelled"));
            }
            if Instant::now() >= expires {
                return Err(failure("ChatGPT authorization expired"));
            }
            match grant.listener.accept() {
                Ok((mut stream, _)) => {
                    let callback = read_callback(&mut stream, &grant)?;
                    let Some((code, client_id)) = callback else {
                        continue;
                    };
                    let response = self.form(
                        TOKEN_URL,
                        &[
                            ("grant_type", "authorization_code"),
                            ("client_id", &client_id),
                            ("code", &code),
                            ("code_verifier", &grant.verifier),
                            ("redirect_uri", &grant.redirect_uri),
                            ("resource", RESOURCE),
                        ],
                        cancellation,
                    )?;
                    let mut response = token_response(&response)?;
                    let id_token = response
                        .id_token
                        .as_deref()
                        .ok_or_else(|| failure("ChatGPT omitted the ID token"))?;
                    let identity = self.verify_identity(
                        id_token,
                        &client_id,
                        Some(&grant.nonce),
                        cancellation,
                    )?;
                    if let Some(selected) = &grant.selected
                        && identity.sub != selected.subject
                    {
                        return Err(failure(
                            "ChatGPT returned a different account; saved credentials were preserved",
                        ));
                    }
                    let tokens = response.into_tokens(None)?;
                    return Ok(Registration {
                        client_id,
                        subject: identity.sub,
                        email: identity.email,
                        revision: grant
                            .selected
                            .as_ref()
                            .map_or(1, |account| account.revision + 1),
                        tokens: Some(tokens),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => return Err(failure("ChatGPT callback listener failed")),
            }
        }
    }

    pub(super) fn refresh(&self, registration: &mut Registration) -> Result<(), ChatGptError> {
        let tokens = registration
            .tokens
            .as_ref()
            .ok_or_else(|| failure("ChatGPT plan is signed out"))?;
        let cancellation = CancellationSource::new().token();
        let response = self.form(
            TOKEN_URL,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &registration.client_id),
                ("refresh_token", &tokens.refresh_token),
                ("resource", RESOURCE),
            ],
            &cancellation,
        )?;
        if !response.is_success() {
            let error = serde_json::from_slice::<OAuthError>(response.body()).ok();
            if error.as_ref().is_some_and(|error| {
                matches!(
                    error.error.as_str(),
                    "invalid_grant"
                        | "invalid_refresh_token"
                        | "token_expired"
                        | "refresh_token_expired"
                        | "refresh_token_invalidated"
                        | "refresh_token_reused"
                )
            }) {
                registration.tokens = None;
                registration.revision += 1;
                return Err(failure(
                    "ChatGPT plan session expired; continue with the saved account",
                ));
            }
            return Err(failure("ChatGPT plan token refresh was rejected"));
        }
        let mut response = token_response(&response)?;
        if let Some(id_token) = &response.id_token {
            let identity =
                self.verify_identity(id_token, &registration.client_id, None, &cancellation)?;
            if identity.sub != registration.subject {
                return Err(failure("ChatGPT refresh returned a different account"));
            }
        }
        let refreshed = response.into_tokens(Some(tokens))?;
        registration.tokens = Some(refreshed);
        registration.revision += 1;
        Ok(())
    }

    pub(super) fn revoke(&self, registration: &Registration) -> Result<(), ChatGptError> {
        let Some(tokens) = &registration.tokens else {
            return Ok(());
        };
        let cancellation = CancellationSource::new().token();
        let discovery = self.discovery(&cancellation)?;
        let endpoint = discovery.revocation_endpoint.ok_or_else(|| {
            failure("Remote sign-out was not confirmed; disconnect Ash in ChatGPT Settings")
        })?;
        trusted_auth_url(&endpoint)?;
        for attempt in 0..3 {
            match self.form(
                &endpoint,
                &[
                    ("token", &tokens.refresh_token),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", &registration.client_id),
                ],
                &cancellation,
            ) {
                Ok(response) if response.status() == 200 => return Ok(()),
                Ok(response) if response.status() < 500 => break,
                _ if attempt < 2 => std::thread::sleep(Duration::from_millis(100 << attempt)),
                _ => break,
            }
        }
        Err(failure(
            "Signed out locally; remote revocation was not confirmed. Disconnect Ash in ChatGPT Settings",
        ))
    }

    fn form(
        &self,
        endpoint: &str,
        fields: &[(&str, &str)],
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, ChatGptError> {
        trusted_auth_url(endpoint)?;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish();
        self.send(
            HttpMethod::Post,
            endpoint,
            vec![HttpHeader::new(
                "Content-Type",
                "application/x-www-form-urlencoded",
            )],
            body.into_bytes(),
            cancellation,
        )
    }

    fn send(
        &self,
        method: HttpMethod,
        url: &str,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, ChatGptError> {
        let request = ClientRequest::new(method, url, headers, body, RetryPolicy::never())
            .map_err(|_| failure("ChatGPT authorization request is invalid"))?
            .without_redirects();
        let response = self
            .transport
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| failure("ChatGPT authorization service is unavailable"))?;
        if response.body().len() > 1024 * 1024 {
            return Err(failure("ChatGPT authorization response is too large"));
        }
        Ok(response)
    }

    fn discovery(&self, cancellation: &CancellationToken) -> Result<Discovery, ChatGptError> {
        let response = self.send(
            HttpMethod::Get,
            "https://auth.openai.com/.well-known/openid-configuration",
            Vec::new(),
            Vec::new(),
            cancellation,
        )?;
        if !response.is_success() {
            return Err(failure("ChatGPT identity discovery is unavailable"));
        }
        let discovery: Discovery = serde_json::from_slice(response.body())
            .map_err(|_| failure("ChatGPT identity discovery is invalid"))?;
        if discovery.issuer != ISSUER {
            return Err(failure("ChatGPT identity issuer is invalid"));
        }
        trusted_auth_url(&discovery.jwks_uri)?;
        Ok(discovery)
    }

    fn verify_identity(
        &self,
        token: &str,
        client_id: &str,
        nonce: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Identity, ChatGptError> {
        let discovery = self.discovery(cancellation)?;
        // Authorization and refresh are infrequent. Fetch current JWKS for every verification
        // so a new signing key never needs an unsafe decode or a stale-key retry.
        let response = self.send(
            HttpMethod::Get,
            &discovery.jwks_uri,
            Vec::new(),
            Vec::new(),
            cancellation,
        )?;
        if !response.is_success() {
            return Err(failure("ChatGPT signing keys are unavailable"));
        }
        let keys: JwkSet = serde_json::from_slice(response.body())
            .map_err(|_| failure("ChatGPT signing keys are invalid"))?;
        verify_identity(token, client_id, nonce, &keys)
    }
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
}
#[derive(Deserialize)]
struct OAuthError {
    error: String,
}
#[derive(Deserialize)]
struct Identity {
    sub: String,
    email: Option<String>,
    nonce: Option<String>,
}

fn verify_identity(
    token: &str,
    client_id: &str,
    nonce: Option<&str>,
    keys: &JwkSet,
) -> Result<Identity, ChatGptError> {
    let header =
        jsonwebtoken::decode_header(token).map_err(|_| failure("ChatGPT ID token is invalid"))?;
    if header.alg != Algorithm::RS256 {
        return Err(failure("ChatGPT ID token signing algorithm is invalid"));
    }
    let key = header
        .kid
        .as_deref()
        .and_then(|kid| keys.find(kid))
        .ok_or_else(|| failure("ChatGPT ID token signing key is unknown"))?;
    let key = DecodingKey::from_jwk(key)
        .map_err(|_| failure("ChatGPT ID token signing key is invalid"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    validation.leeway = 5;
    validation.validate_nbf = true;
    let identity = jsonwebtoken::decode::<Identity>(token, &key, &validation)
        .map_err(|_| failure("ChatGPT ID token signature or claims could not be verified"))?
        .claims;
    if identity.sub.is_empty()
        || nonce.is_some_and(|nonce| identity.nonce.as_deref() != Some(nonce))
    {
        return Err(failure("ChatGPT ID token identity or nonce does not match"));
    }
    Ok(identity)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
    #[serde(default)]
    earliest_refresh_at: u64,
}

impl TokenResponse {
    fn into_tokens(&mut self, previous: Option<&Tokens>) -> Result<Tokens, ChatGptError> {
        if !self.token_type.eq_ignore_ascii_case("Bearer")
            || self.access_token.is_empty()
            || self.refresh_token.is_empty()
            || self.expires_in == 0
        {
            return Err(failure("ChatGPT returned incomplete plan credentials"));
        }
        let scopes = match &self.scope {
            Some(scope) => scope.split_whitespace().map(str::to_owned).collect(),
            None => previous
                .map(|tokens| tokens.scopes.clone())
                .ok_or_else(|| failure("ChatGPT omitted granted permissions"))?,
        };
        let tokens = Tokens {
            access_token: std::mem::take(&mut self.access_token),
            refresh_token: std::mem::take(&mut self.refresh_token),
            id_token: self
                .id_token
                .take()
                .or_else(|| previous.map(|tokens| tokens.id_token.clone()))
                .ok_or_else(|| failure("ChatGPT omitted the ID token"))?,
            scopes,
            expires_at: now()
                .checked_add(self.expires_in)
                .ok_or_else(|| failure("ChatGPT returned an invalid expiry"))?,
            earliest_refresh_at: self.earliest_refresh_at,
        };
        if !tokens.has_plan_scope() {
            return Err(failure(
                "ChatGPT plan usage was not authorized; enable Ash in ChatGPT Settings",
            ));
        }
        Ok(tokens)
    }
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}

fn token_response(response: &ClientResponse) -> Result<TokenResponse, ChatGptError> {
    if response.status() != 200 {
        return Err(failure(
            "ChatGPT token exchange was rejected; start authorization again",
        ));
    }
    serde_json::from_slice(response.body())
        .map_err(|_| failure("ChatGPT returned an invalid token response"))
}

fn trusted_auth_url(endpoint: &str) -> Result<(), ChatGptError> {
    let url = Url::parse(endpoint).map_err(|_| failure("ChatGPT identity endpoint is invalid"))?;
    if url.origin().ascii_serialization() != ISSUER
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure("ChatGPT identity endpoint has an untrusted origin"));
    }
    Ok(())
}

fn random() -> Result<String, ChatGptError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| failure("ChatGPT authorization randomness is unavailable"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn read_callback(
    stream: &mut TcpStream,
    grant: &Grant,
) -> Result<Option<(Zeroizing<String>, String)>, ChatGptError> {
    stream
        .set_nonblocking(false)
        .and_then(|_| stream.set_read_timeout(Some(Duration::from_secs(2))))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(2))))
        .map_err(|_| failure("ChatGPT callback failed"))?;
    let mut buffer = Zeroizing::new([0_u8; 16384]);
    let mut length = 0;
    while length < buffer.len() {
        let received = stream
            .read(&mut buffer[length..])
            .map_err(|_| failure("ChatGPT callback failed"))?;
        if received == 0 {
            break;
        }
        length += received;
        if buffer[..length]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            break;
        }
    }
    let request =
        std::str::from_utf8(&buffer[..length]).map_err(|_| failure("ChatGPT callback failed"))?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.split_once(" HTTP/1.1").map(|(target, _)| target));
    let Some(target) = target.filter(|target| target.starts_with('/') && !target.starts_with("//"))
    else {
        reply(stream, 400);
        return Ok(None);
    };
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| failure("ChatGPT callback failed"))?;
    if url.path() != "/auth/callback" {
        reply(stream, 404);
        return Ok(None);
    }
    let mut values = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            reply(stream, 400);
            return Ok(None);
        }
    }
    if values.get("state") != Some(&grant.state) {
        reply(stream, 400);
        return Ok(None);
    }
    if values.contains_key("error") {
        reply(stream, 400);
        return Err(failure("ChatGPT authorization was declined"));
    }
    let client_id = match &grant.selected {
        Some(selected)
            if values
                .get("client_id")
                .is_none_or(|id| id == &selected.client_id) =>
        {
            selected.client_id.clone()
        }
        Some(_) => {
            reply(stream, 400);
            return Err(failure("ChatGPT callback changed the registered client"));
        }
        None => values
            .remove("client_id")
            .filter(|id| !id.is_empty() && id != DYNAMIC_CLIENT)
            .ok_or_else(|| failure("ChatGPT registration did not return an issued client ID"))?,
    };
    let code = values
        .remove("code")
        .filter(|code| !code.is_empty())
        .ok_or_else(|| failure("ChatGPT callback omitted its authorization code"))?;
    reply(stream, 200);
    Ok(Some((Zeroizing::new(code), client_id)))
}

fn reply(stream: &mut TcpStream, status: u16) {
    // Empty callback responses keep product strings in the localized Ash UI.
    let _ = stream.write_all(format!("HTTP/1.1 {status} Callback\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").as_bytes());
}

#[cfg(test)]
#[path = "authorization_tests.rs"]
mod tests;

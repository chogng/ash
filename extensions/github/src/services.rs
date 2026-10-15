use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_secrets::SecretValue;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::client::Client;
use external_ext_sdk::services::CoreHttpMethod;
use external_ext_sdk::services::CoreServiceRequest;
use external_ext_sdk::services::CoreServiceResponse;
use github::GitHubAuthenticationRequest;
use github::GitHubAuthenticationResponse;
use github::GitHubAuthorization;
use github::GitHubCredentialProvider;

/// Every service call carries this exact invocation's deadline and cancellation.
pub(crate) struct CoreServices {
    pub client: Client,
    pub token: CancellationToken,
    pub authorization: Option<GitHubAuthorization>,
}
impl GitHubCredentialProvider for CoreServices {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError> {
        self.authorization.clone().ok_or_else(unavailable)
    }
    fn token(&self, authorization: &GitHubAuthorization) -> Result<SecretValue, LoginError> {
        if self.authorization.as_ref() != Some(authorization) {
            return Err(unavailable());
        }
        let response = self
            .client
            .request_backend(
                "authentication.github",
                "receiveData",
                serde_json::to_value(GitHubAuthenticationRequest::Token(authorization.clone()))
                    .map_err(|_| unavailable())?,
                &self.token,
            )
            .map_err(|_| unavailable())?;
        let response: Result<GitHubAuthenticationResponse, LoginError> =
            serde_json::from_value(response).map_err(|_| unavailable())?;
        match response? {
            GitHubAuthenticationResponse::Token(value) => Ok(SecretValue::new(value)),
            _ => Err(unavailable()),
        }
    }
}
impl HttpClient for CoreServices {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        let method = match request.method() {
            HttpMethod::Get => CoreHttpMethod::Get,
            HttpMethod::Post => CoreHttpMethod::Post,
            HttpMethod::Patch => CoreHttpMethod::Patch,
            HttpMethod::Put => CoreHttpMethod::Put,
            HttpMethod::Delete => CoreHttpMethod::Delete,
        };
        let response = self
            .client
            .core_service(
                CoreServiceRequest::HttpExecute {
                    method,
                    url: request.url().into(),
                    headers: request
                        .headers()
                        .iter()
                        .map(|h| (h.name().into(), h.value().into()))
                        .collect(),
                    body: request.body().to_vec(),
                },
                &self.token,
            )
            .map_err(|error| {
                if error.code == external_ext_sdk::HostErrorCode::DeadlineExceeded {
                    HttpClientError::Connection(ash_http_client::HttpConnectionFailure::Timeout)
                } else {
                    HttpClientError::Transport("GitHub extension HTTP service unavailable".into())
                }
            })?;
        if let CoreServiceResponse::HttpExecuted {
            status,
            headers,
            body,
        } = response
        {
            Ok(HttpResponse::new(
                status,
                headers
                    .into_iter()
                    .map(|(name, value)| HttpHeader::new(name, value))
                    .collect(),
                body,
            ))
        } else {
            Err(HttpClientError::Transport(
                "Unexpected HTTP service response".into(),
            ))
        }
    }
}
fn unavailable() -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "GitHub credential service unavailable",
    )
}

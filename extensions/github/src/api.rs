use crate::Error;
use crate::GitHub;
use crate::Repository;
use crate::Result;
use ash_async_utils::CancellationReason;
use ash_http_client::HttpClientError;
use ash_http_client::HttpConnectionFailure;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum Operation {
    Read,
    Write,
}

pub(crate) struct ApiResponse<T> {
    pub data: T,
    pub headers: Vec<HttpHeader>,
}

impl GitHub {
    pub(crate) async fn api<T: DeserializeOwned>(
        &self,
        repository: &Repository,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<T> {
        Repository::new(
            repository.host.clone(),
            repository.owner.clone(),
            repository.name.clone(),
        )?;
        let operation = if method == HttpMethod::Get {
            Operation::Read
        } else {
            Operation::Write
        };
        self.request(&repository.host, method, endpoint, body, operation)
            .await
            .map(|response| response.data)
    }

    pub(crate) async fn account_api<T: DeserializeOwned>(
        &self,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<T> {
        self.account_api_response(method, endpoint, body)
            .await
            .map(|response| response.data)
    }

    pub(crate) async fn account_api_response<T: DeserializeOwned>(
        &self,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<ApiResponse<T>> {
        let operation = if method == HttpMethod::Get {
            Operation::Read
        } else {
            Operation::Write
        };
        self.request(&self.authorization.host, method, endpoint, body, operation)
            .await
    }

    pub(crate) async fn graphql(
        &self,
        repository: &Repository,
        query: &str,
        variables: Value,
        operation: Operation,
    ) -> Result<Value> {
        Repository::new(
            repository.host.clone(),
            repository.owner.clone(),
            repository.name.clone(),
        )?;
        self.request(
            &repository.host,
            HttpMethod::Post,
            "graphql",
            Some(serde_json::json!({"query":query,"variables":variables})),
            operation,
        )
        .await
        .map(|response| response.data)
    }

    async fn request<T: DeserializeOwned>(
        &self,
        host: &str,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
        operation: Operation,
    ) -> Result<ApiResponse<T>> {
        let response = self
            .request_raw(host, method, endpoint, body, operation)
            .await?;
        let headers = response.headers().to_vec();
        let data = decode_response(response, endpoint == "graphql", operation)?;
        Ok(ApiResponse { data, headers })
    }

    /// A log capability is returned only on explicit request; bearer credentials never follow it.
    pub(crate) async fn log_link(&self, repository: &Repository, endpoint: &str) -> Result<String> {
        let response = self
            .request_raw(
                &repository.host,
                HttpMethod::Get,
                endpoint,
                None,
                Operation::Read,
            )
            .await?;
        if response.status() != 302 {
            crate::error::validate_status(
                response.status(),
                response
                    .headers()
                    .iter()
                    .map(|header| (header.name(), header.value())),
            )?;
            return Err(Error::InvalidResponse("Missing GitHub log redirect".into()));
        }
        let location = response
            .headers()
            .iter()
            .find(|header| header.name().eq_ignore_ascii_case("location"))
            .map(|header| header.value())
            .ok_or_else(|| Error::InvalidResponse("Missing GitHub log location".into()))?;
        let url = url::Url::parse(location)
            .map_err(|_| Error::InvalidResponse("Invalid GitHub log location".into()))?;
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let allowed = host.ends_with(".blob.core.windows.net")
            || host.ends_with(".actions.githubusercontent.com")
            || host == "logs.githubusercontent.com"
            || (!repository.host.eq_ignore_ascii_case("github.com")
                && host.eq_ignore_ascii_case(&repository.host));
        if !allowed
            || location.len() > 16384
            || url.port_or_known_default() != Some(443)
            || url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::InvalidResponse("Invalid GitHub log location".into()));
        }
        Ok(url.to_string())
    }

    pub(crate) async fn request_raw(
        &self,
        host: &str,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
        operation: Operation,
    ) -> Result<HttpResponse> {
        if !host.eq_ignore_ascii_case(&self.authorization.host) {
            return Err(Error::AuthenticationRequired);
        }
        self.cancellation.check().map_err(|_| Error::Cancelled)?;
        let token = self
            .credentials
            .token(&self.authorization)
            .map_err(Error::from)?;
        let token =
            std::str::from_utf8(token.expose()).map_err(|_| Error::AuthenticationRequired)?;
        let base = if host.eq_ignore_ascii_case("github.com") {
            "https://api.github.com".to_owned()
        } else {
            format!("https://{host}/api")
        };
        let url = if endpoint == "graphql" || host.eq_ignore_ascii_case("github.com") {
            format!("{base}/{endpoint}")
        } else {
            format!("{base}/v3/{endpoint}")
        };
        let body = body
            .map(|body| serde_json::to_vec(&body))
            .transpose()
            .map_err(|_| Error::InvalidInput("Invalid GitHub request body".into()))?
            .unwrap_or_default();
        let request = HttpRequest::new(
            method,
            url,
            vec![
                HttpHeader::new("Accept", "application/vnd.github+json"),
                HttpHeader::new("Content-Type", "application/json"),
                HttpHeader::new("User-Agent", "Ash"),
                HttpHeader::new("X-GitHub-Api-Version", "2022-11-28"),
                HttpHeader::new("Authorization", format!("Bearer {token}")),
            ],
            body,
        )
        .map_err(|_| Error::InvalidInput("Invalid GitHub request".into()))?
        .without_redirects();

        // A request future owns its cancellation domain. Dropping it also stops the
        // shared HTTP attempt; the blocking facade must never detach live network I/O.
        let source = self.cancellation.child_source();
        let _cancel_on_drop = source.cancel_on_drop();
        let cancellation = source.token();
        let http = Arc::clone(&self.http);
        let mut attempt = tokio::task::spawn_blocking(move || {
            http.execute_with_cancellation(&request, &cancellation)
        });
        let response = match tokio::time::timeout(Duration::from_secs(30), &mut attempt).await {
            Ok(result) => result.map_err(|_| {
                failure(
                    operation,
                    Error::Unavailable("GitHub HTTP worker failed".into()),
                )
            })?,
            Err(_) => {
                source.cancel_with(CancellationReason::DeadlineExceeded);
                // Cancellation completes the original attempt before the request ends.
                let _ = attempt.await;
                return Err(failure(operation, Error::TimedOut));
            }
        };
        let response = response.map_err(|error| {
            let error = if self.cancellation.is_cancelled() {
                Error::Cancelled
            } else {
                match error {
                    HttpClientError::Connection(HttpConnectionFailure::Timeout) => Error::TimedOut,
                    HttpClientError::InvalidRequest(_) => {
                        Error::InvalidInput("Invalid GitHub HTTP request".into())
                    }
                    HttpClientError::InvalidConfiguration(_) => {
                        Error::Unavailable("GitHub HTTP configuration is unavailable".into())
                    }
                    HttpClientError::Connection(_)
                    | HttpClientError::Transport(_)
                    | HttpClientError::ResponseTooLarge
                    | HttpClientError::RedirectLimitExceeded => {
                        Error::Unavailable("GitHub HTTP request failed".into())
                    }
                }
            };
            failure(operation, error)
        })?;
        // A write response still describes the completed change after logout. Reads
        // must discard private data obtained under a grant that is no longer current.
        if operation == Operation::Read {
            self.validate_authorization().map_err(Error::from)?;
            self.cancellation.check().map_err(|_| Error::Cancelled)?;
        }
        // This refusal is specific to managed settings. Do not forward the error
        // body or interpret another client's version as an Ash update requirement.
        if endpoint == "copilot_internal/managed_settings" && response.status() == 466 {
            return Err(Error::ManagedSettingsUpdateRequired);
        }
        Ok(response)
    }
}

fn failure(operation: Operation, error: Error) -> Error {
    if operation == Operation::Write {
        Error::SubmissionUncertain
    } else {
        error
    }
}

fn decode_response<T: DeserializeOwned>(
    response: HttpResponse,
    graphql: bool,
    operation: Operation,
) -> Result<T> {
    if operation == Operation::Write && response.status() >= 500 {
        return Err(Error::SubmissionUncertain);
    }
    crate::error::validate_status(
        response.status(),
        response
            .headers()
            .iter()
            .map(|header| (header.name(), header.value())),
    )?;
    if response.body().len() > 8 * 1024 * 1024 {
        return Err(failure(
            operation,
            Error::InvalidResponse("GitHub response exceeds 8 MiB".into()),
        ));
    }
    let value = if matches!(response.status(), 204 | 205) && response.body().is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(response.body()).map_err(|_| {
            failure(
                operation,
                Error::InvalidResponse("Invalid GitHub JSON response".into()),
            )
        })?
    };
    if graphql && let Some(errors) = value.get("errors") {
        let errors = errors.as_array().ok_or_else(|| {
            failure(
                operation,
                Error::InvalidResponse("Invalid GitHub GraphQL errors".into()),
            )
        })?;
        if let Some(error) = errors.first() {
            // Classification uses GitHub's machine-readable type, never private server text.
            return Err(match error.get("type").and_then(Value::as_str) {
                Some("UNAUTHENTICATED") => Error::AuthenticationRequired,
                Some("FORBIDDEN") => Error::PermissionDenied,
                Some("RATE_LIMITED") => Error::RateLimited,
                Some("NOT_FOUND") => Error::NotFound,
                Some("STALE_DATA") => Error::Conflict("GitHub resource changed".into()),
                Some("UNPROCESSABLE" | "GRAPHQL_VALIDATION_FAILED") => {
                    Error::InvalidInput("GitHub rejected the GraphQL request".into())
                }
                _ => failure(
                    operation,
                    Error::OperationFailed("GitHub rejected the GraphQL request".into()),
                ),
            });
        }
    }
    serde_json::from_value(value).map_err(|_| {
        failure(
            operation,
            Error::InvalidResponse("Invalid GitHub response fields".into()),
        )
    })
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;

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

impl GitHub {
    pub(crate) async fn api<T: DeserializeOwned>(
        &self,
        repository: &Repository,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let operation = if method == HttpMethod::Get {
            Operation::Read
        } else {
            Operation::Write
        };
        self.request(repository, method, endpoint, body, operation)
            .await
    }

    pub(crate) async fn graphql(
        &self,
        repository: &Repository,
        query: &str,
        variables: Value,
        operation: Operation,
    ) -> Result<Value> {
        self.request(
            repository,
            HttpMethod::Post,
            "graphql",
            Some(serde_json::json!({"query":query,"variables":variables})),
            operation,
        )
        .await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        repository: &Repository,
        method: HttpMethod,
        endpoint: &str,
        body: Option<Value>,
        operation: Operation,
    ) -> Result<T> {
        Repository::new(
            repository.host.clone(),
            repository.owner.clone(),
            repository.name.clone(),
        )?;
        if !repository
            .host
            .eq_ignore_ascii_case(&self.authorization.host)
        {
            return Err(Error::AuthenticationRequired);
        }
        self.cancellation.check().map_err(|_| Error::Cancelled)?;
        let token = self
            .credentials
            .token(&self.authorization)
            .map_err(Error::from)?;
        let token =
            std::str::from_utf8(token.expose()).map_err(|_| Error::AuthenticationRequired)?;
        let base = if repository.host.eq_ignore_ascii_case("github.com") {
            "https://api.github.com".to_owned()
        } else {
            format!("https://{}/api", repository.host)
        };
        let url = if endpoint == "graphql" || repository.host.eq_ignore_ascii_case("github.com") {
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
                    HttpClientError::Connection(_) | HttpClientError::Transport(_) => {
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
        decode_response(response, endpoint == "graphql", operation)
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
    let value = if response.status() == 204 && response.body().is_empty() {
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

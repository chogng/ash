use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretStoreErrorKind;
use ash_secrets::SecretValue;
use external_ext_sdk::services::CoreHttpMethod;
use external_ext_sdk::services::CoreServiceRequest;
use external_ext_sdk::services::CoreServiceResponse;
use external_ext_sdk::services::Services;

pub(crate) struct CoreServices(pub Services, pub external_ext_sdk::client::Client);
thread_local! {
    static INVOCATION: std::cell::RefCell<Option<external_ext_sdk::CancellationToken>> = const { std::cell::RefCell::new(None) };
}
struct InvocationGuard(Option<external_ext_sdk::CancellationToken>);
impl Drop for InvocationGuard {
    fn drop(&mut self) {
        INVOCATION.with(|context| context.replace(self.0.take()));
    }
}
impl CoreServices {
    pub(crate) fn with_invocation<T>(
        token: external_ext_sdk::CancellationToken,
        operation: impl FnOnce() -> T,
    ) -> T {
        // Provider traits are synchronous. Bind only the current callback thread; detached
        // OAuth work continues under the profile activation rather than borrowing a window.
        let previous = INVOCATION.with(|context| context.replace(Some(token)));
        let _guard = InvocationGuard(previous);
        operation()
    }
    fn call(
        &self,
        request: CoreServiceRequest,
    ) -> Result<CoreServiceResponse, external_ext_sdk::ExtensionError> {
        let token = INVOCATION.with(|context| context.borrow().clone());
        match token {
            Some(token) => self.1.core_service(request, &token),
            None => self.0.call(request),
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
            .call(CoreServiceRequest::HttpExecute {
                method,
                url: request.url().into(),
                headers: request
                    .headers()
                    .iter()
                    .map(|h| (h.name().into(), h.value().into()))
                    .collect(),
                body: request.body().to_vec(),
            })
            .map_err(|_| http_error())?;
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
            Err(http_error())
        }
    }
}
impl SecretStore for CoreServices {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        let response = self
            .call(CoreServiceRequest::SecretLoad {
                key: key.as_str().into(),
            })
            .map_err(|_| secret_error())?;
        if let CoreServiceResponse::SecretLoaded { value } = response {
            Ok(value.map(SecretValue::new))
        } else {
            Err(secret_error())
        }
    }
    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        let response = self
            .call(CoreServiceRequest::SecretStore {
                key: key.as_str().into(),
                value: value.expose().to_vec(),
            })
            .map_err(|_| secret_error())?;
        if let CoreServiceResponse::SecretStored = response {
            Ok(())
        } else {
            Err(secret_error())
        }
    }
    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        let response = self
            .call(CoreServiceRequest::SecretDelete {
                key: key.as_str().into(),
            })
            .map_err(|_| secret_error())?;
        if let CoreServiceResponse::SecretDeleted { deleted } = response {
            Ok(if deleted {
                DeleteSecretOutcome::Deleted
            } else {
                DeleteSecretOutcome::NotFound
            })
        } else {
            Err(secret_error())
        }
    }
}
fn http_error() -> HttpClientError {
    HttpClientError::Transport("extension HTTP service unavailable".into())
}
fn secret_error() -> SecretStoreError {
    SecretStoreError::new(
        SecretStoreErrorKind::BackendUnavailable,
        "extension secret service unavailable",
    )
}

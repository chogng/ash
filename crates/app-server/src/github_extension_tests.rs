use super::*;
use ash_http_client::HttpClientError;
use ash_http_client::HttpResponse;

struct Credentials;
impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> Result<GitHubAuthorization, ash_login::LoginError> {
        Ok(GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "grant".into(),
        })
    }
    fn token(
        &self,
        grant: &GitHubAuthorization,
    ) -> Result<ash_secrets::SecretValue, ash_login::LoginError> {
        assert_eq!(grant, &self.authorization()?);
        Ok(ash_secrets::SecretValue::new(b"token".to_vec()))
    }
}
struct NoHttp;
impl HttpClient for NoHttp {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        panic!("denied requests must not reach HTTP")
    }
}
#[test]
fn invocation_services_deny_other_grants_secrets_and_foreign_endpoints() {
    let profile = tempfile::tempdir().unwrap();
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap(),
    );
    // These checks do not start a process; admission only needs a real executable file.
    let runtime = GitHubExtensionRuntime::open(std::env::current_exe().unwrap(), policy).unwrap();
    let credentials = Arc::new(Credentials);
    let grant = credentials.authorization().unwrap();
    let provider = Provider {
        runtime,
        credentials: Some(credentials),
        http: Arc::new(NoHttp),
    };
    let source = CancellationSource::new();
    for url in [
        "http://api.github.com/repos/a/b",
        "https://evil.example/repos/a/b",
        "https://api.github.com:444/repos/a/b",
        "https://user@api.github.com/repos/a/b",
        "https://api.github.com/repos/a/b#fragment",
    ] {
        assert!(
            provider
                .service(
                    ExtensionClientOperation::CoreService {
                        request: CoreServiceRequest::HttpExecute {
                            method: CoreHttpMethod::Get,
                            url: url.into(),
                            headers: vec![],
                            body: vec![]
                        }
                    },
                    Some(&grant),
                    &source.token()
                )
                .is_err()
        );
    }
    assert!(
        provider
            .service(
                ExtensionClientOperation::CoreService {
                    request: CoreServiceRequest::SecretLoad {
                        key: "provider/github/accounts".into()
                    }
                },
                Some(&grant),
                &source.token()
            )
            .is_err()
    );
    let mut other = grant.clone();
    other.grant_id = "different".into();
    assert!(
        provider
            .service(
                ExtensionClientOperation::BackendRequest {
                    capability: "authentication.github".into(),
                    method: "receiveData".into(),
                    params: serde_json::to_value(GitHubAuthenticationRequest::Token(other))
                        .unwrap(),
                    progress: None
                },
                Some(&grant),
                &source.token()
            )
            .is_err()
    );
    assert!(
        provider
            .service(
                ExtensionClientOperation::CoreService {
                    request: CoreServiceRequest::HttpExecute {
                        method: CoreHttpMethod::Post,
                        url: "https://api.github.com/repos/a/b/issues".into(),
                        headers: vec![],
                        body: vec![]
                    }
                },
                None,
                &source.token()
            )
            .is_err()
    );
}

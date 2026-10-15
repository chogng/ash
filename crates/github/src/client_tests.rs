use super::*;
use ash_async_utils::CancellationSource;
use ash_login::LoginError;
use ash_secrets::SecretValue;
struct Credentials;
impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> std::result::Result<GitHubAuthorization, LoginError> {
        Ok(GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "grant".into(),
        })
    }
    fn token(&self, _: &GitHubAuthorization) -> std::result::Result<SecretValue, LoginError> {
        Ok(SecretValue::new(b"token".to_vec()))
    }
}
struct WrongReply;
impl GitHubProvider for WrongReply {
    fn call(
        &self,
        _: Option<GitHubAuthorization>,
        _: GitHubRequest,
        _: &CancellationToken,
    ) -> Result<GitHubResponse> {
        Ok(GitHubResponse::ManagedSettings(None))
    }
}
#[test]
fn wrong_operation_replies_preserve_uncertainty_for_writes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let client = GitHub::for_account(
        Arc::new(Credentials),
        Arc::new(WrongReply),
        CancellationSource::new().token(),
    )
    .unwrap();
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    runtime.block_on(async {
        assert!(matches!(
            client.comments(&repository, 7, 1).await,
            Err(Error::InvalidResponse(_))
        ));
        assert_eq!(
            client.create_comment(&repository, 7, "body").await,
            Err(Error::SubmissionUncertain)
        );
    });
}

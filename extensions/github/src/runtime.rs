use crate::ApiProvider;
use crate::services::CoreServices;
use ash_async_utils::CancellationSource;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use github::GitHubInvocation;
use github::GitHubProvider;
use std::sync::Arc;
use std::time::Duration;

/// Stateless GitHub API provider; authentication sessions remain in their own extension.
#[derive(Default)]
pub struct GitHubExtension;
impl Extension for GitHubExtension {
    fn id(&self) -> &str {
        "ash.github"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let client = context.client.clone();
        context.data_channels.register(
            "github.api.v1",
            move |invocation: GitHubInvocation, token| {
                token.check_cancelled()?;
                let services = Arc::new(CoreServices {
                    client: client.clone(),
                    token: token.clone(),
                    authorization: invocation.authorization.clone(),
                });
                let provider = ApiProvider::new(services.clone(), services);
                let source = CancellationSource::new();
                // The HTTP worker and the SDK callback share cancellation. Join the monitor
                // before returning, including when the API finishes without network IO.
                let result = std::thread::scope(|scope| {
                    let (done, receiver) = std::sync::mpsc::channel();
                    let source_ref = &source;
                    scope.spawn(move || {
                        while receiver.recv_timeout(Duration::from_millis(10))
                            == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                        {
                            if token.is_cancellation_requested() {
                                source_ref.cancel();
                                break;
                            }
                        }
                    });
                    let result = provider.call(
                        invocation.authorization,
                        invocation.request,
                        &source.token(),
                    );
                    let _ = done.send(());
                    result
                });
                Ok(result)
            },
        )
    }
}

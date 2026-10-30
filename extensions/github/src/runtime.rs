use crate::ApiProvider;
use crate::managed_settings::ManagedSettingsStore;
use crate::services::CoreServices;
use ash_async_utils::CancellationSource;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use github::GitHubInvocation;
use github::GitHubProvider;
use std::sync::Arc;
use std::time::Duration;

/// GitHub API provider; grant-scoped refresh results live for this activation.
#[derive(Default)]
pub struct GitHubExtension;
impl Extension for GitHubExtension {
    fn id(&self) -> &str {
        "ash.github"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let client = context.client.clone();
        let managed_settings = Arc::new(ManagedSettingsStore::default());
        context.data_channels.register(
            "github.api.v2",
            move |invocation: GitHubInvocation, token| {
                token.check_cancelled()?;
                let services = Arc::new(CoreServices {
                    client: client.clone(),
                    token: token.clone(),
                    authorization: invocation.authorization.clone(),
                });
                let provider = ApiProvider::with_managed_settings(
                    services.clone(),
                    services,
                    managed_settings.clone(),
                );
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

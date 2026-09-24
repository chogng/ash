use crate::app::protocol;
use crate::internal::ActiveEventLoop;

use super::App;
use super::ApplicationHost;
use super::DiagnosticEventKind;
use super::ProtocolScheme;
use super::ProtocolUrl;
use super::SecondInstance;

impl<T, A> ApplicationHost<T, A>
where
    T: Send + 'static,
    A: App<T>,
{
    pub(super) fn deliver_second_instance(
        &mut self,
        event_loop: &ActiveEventLoop,
        event: SecondInstance,
    ) {
        let urls = second_instance_urls(&self.protocol_schemes, &event);
        self.diagnostics.record(DiagnosticEventKind::SecondInstance);
        self.with_app_context(event_loop, |app, context| {
            app.second_instance(context, event)
        });
        for url in urls {
            self.diagnostics.record(DiagnosticEventKind::OpenUrl);
            self.with_app_context(event_loop, |app, context| app.open_url(context, url));
        }
    }
}

fn second_instance_urls(accepted: &[ProtocolScheme], event: &SecondInstance) -> Vec<ProtocolUrl> {
    protocol::urls_from_arguments(accepted, event.arguments().iter().skip(1).cloned())
}

#[cfg(test)]
#[path = "host_lifecycle_tests.rs"]
mod tests;

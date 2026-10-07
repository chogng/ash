use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

use app_tools::AppToolContext;
use app_tools::AppToolHost;
use app_tools::AppToolOperation;
use ash_async_utils::CancellationToken;
use core_api::CoreError;
use serde_json::Value;

/// Keeps tool executors from extending the product backend's lifetime through a reference cycle.
#[derive(Default)]
pub(crate) struct AppToolsHost {
    server: OnceLock<Weak<crate::AppServer>>,
}

impl AppToolsHost {
    pub(crate) fn bind(&self, server: &Arc<crate::AppServer>) {
        self.server
            .set(Arc::downgrade(server))
            .expect("application tool host is bound once by product composition");
    }
}

impl AppToolHost for AppToolsHost {
    fn execute(
        &self,
        operation: AppToolOperation,
        context: &AppToolContext,
        cancellation: &CancellationToken,
    ) -> Result<Value, CoreError> {
        let server =
            self.server.get().and_then(Weak::upgrade).ok_or_else(|| {
                CoreError::Execution("application tool host is unavailable".into())
            })?;
        AppToolHost::execute(server.as_ref(), operation, context, cancellation)
    }
}

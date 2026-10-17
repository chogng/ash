use super::AppServer;

impl app_tools::AppToolHost for AppServer {
    fn execute(
        &self,
        operation: app_tools::AppToolOperation,
        context: &app_tools::AppToolContext,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<serde_json::Value, core_api::CoreError> {
        self.app_tools_processor()
            .execute_app_tool(operation, context, cancellation)
    }
}

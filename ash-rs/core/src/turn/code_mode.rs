#[cfg(feature = "code-mode")]
mod broker;
#[cfg(feature = "code-mode")]
mod catalog;
#[cfg(feature = "code-mode")]
mod invoker;
#[cfg(feature = "code-mode")]
mod nested;
#[cfg(feature = "code-mode")]
mod response;

#[cfg(feature = "code-mode")]
pub(super) use broker::CodeModeBroker;
#[cfg(all(test, feature = "code-mode"))]
pub(super) use broker::EXEC_TOOL_NAME;
#[cfg(all(test, feature = "code-mode"))]
pub(super) use broker::WAIT_TOOL_NAME;

#[cfg(all(test, feature = "code-mode"))]
#[path = "code_mode_tests.rs"]
mod tests;

#[cfg(not(feature = "code-mode"))]
mod unavailable {
    use crate::ActionPolicyService;
    use crate::CoreError;
    use crate::HookService;
    use crate::ModelToolCatalogSnapshot;
    use crate::ThreadController;
    use crate::ThreadUpdateSink;
    use crate::ToolExecutionOutput;
    use crate::ToolService;
    use ash_protocol::ThreadId;
    use ash_protocol::ToolCall;
    use ash_protocol::ToolCallBinding;
    use ash_protocol::ToolCallCaller;
    use ash_protocol::ToolMode;
    use ash_protocol::TurnId;
    use std::sync::Arc;

    #[derive(Clone)]
    pub(crate) struct CodeModeBroker;

    impl CodeModeBroker {
        pub(crate) fn new(
            _: Arc<ThreadController>,
            _: Arc<dyn ToolService>,
            _: Arc<dyn ActionPolicyService>,
        ) -> Self {
            Self
        }

        pub(crate) fn with_tool_service(
            &self,
            _: Arc<dyn ToolService>,
            _: Arc<dyn ActionPolicyService>,
        ) -> Self {
            self.clone()
        }

        pub(crate) fn close_turn(&self, _: &ThreadId, _: &TurnId) -> Result<(), CoreError> {
            Ok(())
        }

        pub(crate) fn augment_catalog(
            &self,
            catalog: ModelToolCatalogSnapshot,
            mode: ToolMode,
        ) -> Result<ModelToolCatalogSnapshot, CoreError> {
            if mode.requires_code_mode() {
                return Err(CoreError::Execution(
                    "Code Mode was requested, but this Ash build does not include the V8 runtime"
                        .into(),
                ));
            }
            Ok(catalog)
        }

        pub(crate) fn bind_control_call(
            &self,
            _: &ToolCall,
            _: ToolCallCaller,
        ) -> Result<Option<ToolCallBinding>, CoreError> {
            Ok(None)
        }

        pub(crate) fn owns_control_binding(
            &self,
            _: &ToolCall,
            _: Option<&ToolCallBinding>,
        ) -> bool {
            false
        }

        pub(crate) fn validate_control_binding(
            &self,
            _: &ToolCall,
            _: Option<&ToolCallBinding>,
        ) -> Result<(), CoreError> {
            Err(unavailable())
        }

        pub(crate) fn prepare_control(
            &self,
            _: &ToolCall,
        ) -> Result<ash_action_policy::ActionReviewRequest, CoreError> {
            Err(unavailable())
        }

        pub(crate) fn execute(
            &self,
            _: &super::super::tool_execution::ToolExecutionContext<'_>,
            _: &ToolCall,
            _: Arc<dyn ThreadUpdateSink>,
            _: Arc<dyn HookService>,
        ) -> Result<ToolExecutionOutput, CoreError> {
            Err(unavailable())
        }
    }

    fn unavailable() -> CoreError {
        CoreError::Execution(
            "Code Mode is unavailable because this Ash build does not include the V8 runtime"
                .into(),
        )
    }
}

#[cfg(not(feature = "code-mode"))]
pub(super) use unavailable::CodeModeBroker;

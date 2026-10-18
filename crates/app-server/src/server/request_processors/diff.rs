use super::RpcError;
use serde_json::Value;

/// Dispatches the stateless diff adapter without retaining connection or domain state.
pub(super) struct DiffRequestProcessor {
    handler: crate::DiffRequestHandler,
}

impl DiffRequestProcessor {
    pub(super) fn new(handler: crate::DiffRequestHandler) -> Self {
        Self { handler }
    }

    pub(super) fn diff_compute(&self, params: &Value) -> Result<Value, RpcError> {
        (self.handler)(params).map_err(|error| RpcError::new(error.code, error.data.kind))
    }
}

#[cfg(test)]
#[path = "../diff_operations_tests.rs"]
mod tests;

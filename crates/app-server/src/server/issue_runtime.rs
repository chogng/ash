use super::AppServer;
use super::RpcError;
use super::issue_operations::issue_error;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Current repository root and async executor used by GitHub Issue operations.
pub(super) struct IssueRuntime {
    root: PathBuf,
    runtime: tokio::runtime::Runtime,
}

impl IssueRuntime {
    pub(super) fn open(root: &Path) -> Result<Arc<Self>, String> {
        let root = dunce::canonicalize(root)
            .map_err(|error| format!("cannot resolve Issue repository root: {error}"))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(1)
            .thread_name("github-issues")
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(Self { root, runtime }))
    }

    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }
}

impl AppServer {
    pub(super) fn issue_runtime(&self) -> Result<Arc<IssueRuntime>, RpcError> {
        self.issue_runtime
            .as_ref()
            .cloned()
            .ok_or_else(|| issue_error("Issue runtime unavailable".into()))
    }
}

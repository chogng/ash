use super::home_context::HomeContext;
use super::thread_dirs::ThreadDirs;
use crate::dir_grants::DirGrants;
use ash_async_utils::CancellationToken;
use ash_core::ContextEvidence;
use ash_core::ContextSource;
use ash_core::ContextSourceRequest;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::ThreadController;
use ash_home::AshHome;
use ash_protocol::ApprovalMode;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionId;
use ash_protocol::SessionKind;
use ash_skills_extension::DynamicSkillSourceSnapshot;
use ash_skills_extension::SessionSkillSourceProvider;
use core_api::CoreError;
use std::sync::Arc;
use std::sync::Weak;

/// Resolves the Session policy at the execution host selected by the profile gateway.
#[derive(Clone)]
pub(super) struct SessionExecutionRouter {
    // The Thread controller's extension registry can own providers using this router.
    threads: Weak<ThreadController>,
}

/// Durable routing facts shared by admission and model context. Live grants remain with their
/// owners and are checked again whenever a source or tool uses them.
pub(super) struct SessionExecutionRoute {
    kind: SessionKind,
    target: Option<SessionExecutionTarget>,
    directory_configured: bool,
}

impl SessionExecutionRoute {
    pub(super) fn new(kind: SessionKind, target: Option<SessionExecutionTarget>) -> Self {
        Self {
            kind,
            target,
            directory_configured: false,
        }
    }

    pub(super) fn admit_creation(
        target: Option<SessionExecutionTarget>,
        dirs: Option<&ThreadDirs>,
    ) -> Result<Option<SessionExecutionTarget>, CoreError> {
        match target {
            None => Ok(None),
            Some(SessionExecutionTarget::Local { root }) => {
                let selected = dirs.ok_or_else(|| {
                    CoreError::InvalidInput("Session execution directory is unavailable".into())
                })?;
                let requested = ash_file_access::Dir::open_local(&root)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                if requested.id() != selected.id {
                    return Err(CoreError::InvalidInput(
                        "Session execution directory belongs to a different directory runtime"
                            .into(),
                    ));
                }
                Ok(Some(SessionExecutionTarget::Local {
                    root: selected.root.clone(),
                }))
            }
            Some(SessionExecutionTarget::Ssh { .. } | SessionExecutionTarget::Provider { .. }) => {
                Err(CoreError::InvalidInput(
                    "Remote Session execution target must be routed through the profile host"
                        .into(),
                ))
            }
        }
    }

    pub(super) fn approval_mode(
        &self,
        requested: Option<ApprovalMode>,
        configured: impl FnOnce() -> Result<ApprovalMode, super::RpcError>,
    ) -> Result<ApprovalMode, super::RpcError> {
        match (requested, self.kind) {
            (Some(mode), _) => Ok(mode),
            (None, SessionKind::Chat) => Ok(ApprovalMode::Manual),
            (None, SessionKind::Code) => configured(),
        }
    }

    fn allows_workspace(&self) -> bool {
        if self.directory_configured {
            return self.target.is_some();
        }
        // Code can use a workspace supplied by its execution host. Chat requires an explicit binding.
        self.kind == SessionKind::Code
    }

    pub(super) fn uses_profile_host(&self, thread_target: Option<&SessionExecutionTarget>) -> bool {
        thread_target.or(self.target.as_ref()).is_none()
    }

    pub(super) fn validate_turn_host(
        &self,
        thread_target: Option<&SessionExecutionTarget>,
        dirs: Option<&ThreadDirs>,
    ) -> Result<bool, CoreError> {
        let Some(SessionExecutionTarget::Local { root }) = thread_target.or(self.target.as_ref())
        else {
            return Ok(false);
        };
        if dirs.is_none_or(|dirs| {
            &dirs.root != root
                && !ash_file_access::Dir::open_local(root).is_ok_and(|dir| dir.id() == dirs.id)
        }) {
            return Err(CoreError::InvalidInput(
                "The session execution directory has changed".into(),
            ));
        }
        Ok(true)
    }
}

impl SessionExecutionRouter {
    pub(super) fn new(threads: &Arc<ThreadController>) -> Self {
        Self {
            threads: Arc::downgrade(threads),
        }
    }

    pub(super) fn resolve(
        &self,
        session_id: &SessionId,
    ) -> Result<SessionExecutionRoute, CoreError> {
        let threads = self
            .threads
            .upgrade()
            .ok_or_else(|| CoreError::Context("Session execution router is unavailable".into()))?;
        // Read the owning Session, including for a branch whose original kind can differ.
        let session = threads
            .read_session_catalog(session_id)?
            .ok_or_else(|| CoreError::NotFound(session_id.to_string()))?;
        let mut route = SessionExecutionRoute::new(session.kind, session.execution_target);
        let needs_directory_binding = match route.kind {
            SessionKind::Chat => route.target.is_some(),
            SessionKind::Code => route.target.is_none(),
        };
        if needs_directory_binding {
            let root = threads
                .session_thread_catalog(session_id)?
                .into_iter()
                .find(|record| record.thread.thread_id.as_str() == session_id.as_str());
            if let Some(root) = root {
                route.target = root.execution_target;
                route.directory_configured = root.directory_configured;
            }
        }
        Ok(route)
    }

    pub(super) fn allows_workspace(&self, session_id: &SessionId) -> Result<bool, CoreError> {
        Ok(self.resolve(session_id)?.allows_workspace())
    }

    pub(super) fn harness(
        self,
        workspace: Arc<dyn HarnessContextProvider>,
        home: Option<Arc<AshHome>>,
    ) -> Arc<dyn HarnessContextProvider> {
        Arc::new(RoutedHarness {
            router: self,
            workspace,
            profile: home.map(HomeContext::new),
        })
    }

    pub(super) fn workspace_evidence(
        self,
        source: Arc<dyn ContextSource>,
    ) -> Arc<dyn ContextSource> {
        Arc::new(WorkspaceEvidence {
            router: self,
            source,
        })
    }

    pub(super) fn skills(self, grants: Arc<DirGrants>) -> Arc<dyn SessionSkillSourceProvider> {
        Arc::new(RoutedSkills {
            router: self,
            grants,
        })
    }
}

struct RoutedHarness {
    router: SessionExecutionRouter,
    workspace: Arc<dyn HarnessContextProvider>,
    profile: Option<HomeContext>,
}

impl HarnessContextProvider for RoutedHarness {
    fn snapshot(
        &self,
        request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        if let Some(session_id) = request.scope.session_id()
            && !self.router.allows_workspace(session_id)?
        {
            return match &self.profile {
                Some(profile) => profile.snapshot(request),
                None => Ok(Arc::new(HarnessContext::default())),
            };
        }
        self.workspace.snapshot(request)
    }

    fn validate_tool_context(
        &self,
        request: &HarnessContextRequest<'_>,
        call: &ash_protocol::ToolCall,
    ) -> Result<(), CoreError> {
        self.workspace.validate_tool_context(request, call)
    }
}

struct WorkspaceEvidence {
    router: SessionExecutionRouter,
    source: Arc<dyn ContextSource>,
}

impl ContextSource for WorkspaceEvidence {
    fn collect(
        &self,
        request: &ContextSourceRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ContextEvidence>, CoreError> {
        if self.router.allows_workspace(request.session_id)? {
            self.source.collect(request, cancellation)
        } else {
            Ok(Vec::new())
        }
    }
}

struct RoutedSkills {
    router: SessionExecutionRouter,
    grants: Arc<DirGrants>,
}

impl SessionSkillSourceProvider for RoutedSkills {
    fn snapshot(&self, session_id: &SessionId) -> Result<DynamicSkillSourceSnapshot, String> {
        self.grants.snapshot(session_id)
    }

    fn automatic_snapshot(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<DynamicSkillSourceSnapshot>, String> {
        if self
            .router
            .allows_workspace(session_id)
            .map_err(|error| error.to_string())?
        {
            self.snapshot(session_id).map(Some)
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
#[path = "session_execution_router_tests.rs"]
mod tests;

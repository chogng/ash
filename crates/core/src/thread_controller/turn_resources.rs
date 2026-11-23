use super::ThreadController;
use super::is_interruptible_turn;
use crate::ActionPolicyService;
use crate::CoreError;
use crate::ModelService;
use crate::ThreadExecutionContext;
use crate::ToolService;
use crate::TurnExecutionKind;
use crate::TurnSnapshot;
use ash_action_policy::ToolCallScope;
use ash_protocol::ModelRef;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::collections::btree_map::Entry;
use std::sync::Arc;
use std::sync::Weak;

pub(crate) struct TurnModelServices {
    pub(crate) model: Arc<dyn ModelService>,
    pub(crate) policy: Arc<dyn ActionPolicyService>,
    pub(crate) advisor: Option<(ModelRef, Arc<dyn ModelService>)>,
}

pub(crate) enum TurnExecutionPlan {
    Model(TurnModelServices),
    ModelFree(TurnExecutionKind),
}

/// Process-local resources retained while an admitted Turn is waiting or running.
pub(super) struct TurnResources {
    session_id: SessionId,
    plan: Arc<TurnExecutionPlan>,
    // Host tool services can hold the controller. Their host owns the strong reference.
    tools: Option<Weak<dyn ToolService>>,
    close_cells: Box<dyn FnOnce() + Send>,
}

impl TurnResources {
    fn finish(self, thread_id: &ThreadId, turn_id: &TurnId) {
        (self.close_cells)();
        if let Some(tools) = self.tools.and_then(|tools| tools.upgrade()) {
            tools.finish_turn(thread_id, turn_id);
        }
    }
}

impl ThreadController {
    pub(crate) fn enqueue_runtime_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        prepare: impl FnOnce(&TurnSnapshot) -> Result<TurnExecutionPlan, CoreError>,
        close_cells: impl FnOnce(&SessionId) -> Box<dyn FnOnce() + Send>,
        run: impl FnOnce(ThreadExecutionContext) + Send + 'static,
    ) -> Result<(), CoreError> {
        // Serialize admission with release. A failed enqueue rolls back only the resources it
        // created, since an earlier wakeup can still be waiting to run with the same snapshot.
        let mut resources = self
            .turn_resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (thread_id.clone(), turn_id.clone());
        let created = match resources.entry(key.clone()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(entry) => {
                let (session_id, turn) = self.with_loaded_thread(thread_id, |loaded| {
                    let turn = loaded
                        .snapshot
                        .turns
                        .iter()
                        .find(|turn| &turn.turn_id == turn_id)
                        .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
                    Ok((loaded.snapshot.session_id.clone(), turn.clone()))
                })?;
                if !is_interruptible_turn(turn.status) {
                    return Ok(());
                }
                entry.insert(TurnResources {
                    close_cells: close_cells(&session_id),
                    session_id,
                    plan: Arc::new(prepare(&turn)?),
                    tools: None,
                });
                true
            }
        };
        let result = self.enqueue_turn_execution(thread_id, turn_id, run);
        if let Err(error) = result {
            if created {
                resources.remove(&key);
            }
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn scope_turn_execution(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        tools: &Arc<dyn ToolService>,
        execution: &ThreadExecutionContext,
    ) -> Option<(Arc<TurnExecutionPlan>, Arc<dyn ToolService>)> {
        let mut resources = self
            .turn_resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A superseded mailbox entry must not acquire resources or recreate a released scope.
        execution.check_current().ok()?;
        let resources = resources.get_mut(&(thread_id.clone(), turn_id.clone()))?;
        let owner = resources
            .tools
            .as_ref()
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                resources.tools = Some(Arc::downgrade(tools));
                Arc::clone(tools)
            });
        let tools = owner.scoped_to_turn(thread_id, turn_id).unwrap_or(owner);
        Some((Arc::clone(&resources.plan), tools))
    }

    pub(crate) fn turn_advisor_model(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        model: &ModelRef,
    ) -> Option<Arc<dyn ModelService>> {
        let resources = self.turn_resources.lock().ok()?;
        let plan = &resources.get(&(thread_id.clone(), turn_id.clone()))?.plan;
        let TurnExecutionPlan::Model(services) = plan.as_ref() else {
            return None;
        };
        let (selected, service) = services.advisor.as_ref()?;
        (selected == model).then(|| Arc::clone(service))
    }

    pub(super) fn finish_tool_call(&self, scope: &ToolCallScope) {
        let tools = self
            .turn_resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(scope.thread_id.clone(), scope.turn_id.clone()))
            .and_then(|resources| resources.tools.as_ref())
            .and_then(Weak::upgrade);
        if let Some(tools) = tools {
            tools.finish_call(scope);
        }
    }

    pub(crate) fn finish_turn_execution(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        let resources = {
            let mut resources = self
                .turn_resources
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.execution_mailboxes.cancel(thread_id, turn_id);
            resources.remove(&(thread_id.clone(), turn_id.clone()))
        };
        if let Some(resources) = resources {
            resources.finish(thread_id, turn_id);
        }
    }

    pub(super) fn release_turn_resources(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        let resources = self
            .turn_resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&(thread_id.clone(), turn_id.clone()));
        if let Some(resources) = resources {
            resources.finish(thread_id, turn_id);
        }
    }

    pub(crate) fn release_failed_execution(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        execution: &ThreadExecutionContext,
    ) {
        let resources = {
            let mut resources = self
                .turn_resources
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // A wakeup admitted before this operation failed still owns the frozen services.
            if !execution.is_latest() {
                return;
            }
            resources.remove(&(thread_id.clone(), turn_id.clone()))
        };
        if let Some(resources) = resources {
            resources.finish(thread_id, turn_id);
        }
    }

    pub(crate) fn finish_session_turns(&self, session_id: &SessionId) {
        let finished = {
            let mut resources = self
                .turn_resources
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            resources
                .extract_if(.., |(thread_id, turn_id), resources| {
                    if &resources.session_id != session_id {
                        return false;
                    }
                    self.execution_mailboxes.cancel(thread_id, turn_id);
                    true
                })
                .collect::<Vec<_>>()
        };
        for ((thread_id, turn_id), resources) in finished {
            resources.finish(&thread_id, &turn_id);
        }
    }
}

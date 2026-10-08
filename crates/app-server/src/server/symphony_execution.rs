use super::AppServer;
use super::operations::ThreadMutation;
use super::operations::TurnModelSelection;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_async_utils::CancellationToken;
use ash_protocol::CommandId;
use ash_protocol::SymphonyControl;
use ash_protocol::SymphonyTaskStatus;
use ash_protocol::TurnStatus;
use ash_symphony::Job;
use ash_symphony::Observation;
use core_api::AgentRuntime;
use core_api::StartThreadRequest;
use core_api::ThreadWorktreeBinder;
use core_api::ThreadWorktreeBindingRequest;
use std::time::Duration;

impl AppServer {
    pub(crate) fn cleanup_terminal_symphony(
        &self,
        workflow: &ash_symphony::Workflow,
        issues: &[ash_symphony::Issue],
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        let Some(runtime) = &self.git_turn_changes else {
            return Ok(());
        };
        let jobs = self
            .symphony
            .as_ref()
            .ok_or("Symphony store is unavailable")?
            .jobs()
            .map_err(|error| error.to_string())?;
        let root = workflow
            .workspace_root
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("symphony_workspaces"));
        for issue in issues.iter().filter(|issue| workflow.terminal(issue)) {
            // Known jobs first stop their accepted Turn and then clean up through the durable job.
            // This path covers terminal directories left behind before this host's first snapshot.
            if jobs
                .iter()
                .any(|job| job.issue.identifier == issue.identifier)
            {
                continue;
            }
            let directory = root.join(workspace_key(&issue.identifier));
            if !directory.is_dir() {
                continue;
            }
            cancellation.check().map_err(|error| error.to_string())?;
            if let Err(error) = self.symphony_hook_at(
                &directory,
                workflow,
                "before_remove",
                workflow.hooks.before_remove.as_deref(),
                cancellation,
            ) {
                eprintln!(
                    "Symphony startup before_remove issue={} error={error}",
                    issue.identifier
                );
            }
            if let Err(error) = runtime
                .dirs
                .worktrees
                .remove_prepared_directory(&root, &directory)
            {
                eprintln!(
                    "Symphony terminal cleanup issue={} error={error}",
                    issue.identifier
                );
            }
        }
        Ok(())
    }

    pub(crate) fn cleanup_symphony(
        &self,
        job: &Job,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        let store = self
            .symphony
            .as_ref()
            .ok_or("Symphony store is unavailable")?;
        let workflow = store
            .workflow(&job.workflow_id)
            .map_err(|error| error.to_string())?;
        if let Some(thread) = &job.thread_id
            && let Some(runtime) = &self.git_turn_changes
            && runtime.binding(thread).is_some()
        {
            if let Err(error) = self.symphony_hook(thread, job, "before_remove", cancellation) {
                eprintln!(
                    "Symphony before_remove issue={} error={error}",
                    job.issue.identifier
                );
            }
            runtime.cleanup_workflow_thread(thread)?;
        } else if let Some(root) = &job.workspace_root
            && let Some(runtime) = &self.git_turn_changes
        {
            let directory = std::path::Path::new(root).join(workspace_key(&job.issue.identifier));
            if directory.is_dir() {
                if let Err(error) = self.symphony_hook_at(
                    &directory,
                    &workflow,
                    "before_remove",
                    workflow.hooks.before_remove.as_deref(),
                    cancellation,
                ) {
                    eprintln!(
                        "Symphony before_remove issue={} error={error}",
                        job.issue.identifier
                    );
                }
            }
            runtime
                .dirs
                .worktrees
                .remove_prepared_directory(std::path::Path::new(root), &directory)
                .map_err(|error| error.to_string())?;
        }
        store.cleaned(&job.id).map_err(|error| error.to_string())
    }

    pub(crate) fn advance_symphony(
        &self,
        original: &Job,
        cancellation: &CancellationToken,
    ) -> Result<Observation, String> {
        let store = self
            .symphony
            .as_ref()
            .ok_or("Symphony store is unavailable")?;
        let mut job = store.job(&original.id).map_err(|error| error.to_string())?;
        if job.desired == SymphonyControl::Run
            && !job.issue.local
            && job.invocation.as_ref().is_some_and(|input| !input.prepared)
        {
            let workflow = store
                .workflow(&job.workflow_id)
                .map_err(|error| error.to_string())?;
            match self.refresh_symphony(&workflow, &job.issue.id, cancellation) {
                Ok(issue) => {
                    job = store
                        .revalidate(&job, issue)
                        .map_err(|error| error.to_string())?;
                }
                Err(error) => {
                    return Ok(Observation {
                        status: SymphonyTaskStatus::Retrying,
                        session_id: job.session_id,
                        thread_id: job.thread_id,
                        turn_id: job.turn_id,
                        error: Some(error),
                    });
                }
            }
        }
        let invocation = job
            .invocation
            .as_ref()
            .ok_or("Symphony invocation is missing")?;
        let mut observed = Observation {
            status: SymphonyTaskStatus::Starting,
            session_id: job.session_id.clone(),
            thread_id: job.thread_id.clone(),
            turn_id: job.turn_id.clone(),
            error: None,
        };
        let turn_command = command(&format!("turn-{}", job.turn_number), &job.id, job.attempt)?;
        let session_command = command("session", &job.id, 0)?;
        cancellation.check().map_err(|error| error.to_string())?;
        let snapshot = match &job.thread_id {
            Some(id) => self
                .agent_runtime()
                .read_thread(id)
                .map_err(|error| error.to_string())?,
            None => match self
                .agent_runtime()
                .read_started_thread(&session_command)
                .map_err(|error| error.to_string())?
            {
                Some(snapshot) => snapshot,
                None if job.desired != SymphonyControl::Run => {
                    observed.status = SymphonyTaskStatus::Paused;
                    return Ok(observed);
                }
                None => match self
                    .threads
                    .start_thread(
                        &SymphonyBinder {
                            server: self,
                            job: &job,
                            cancellation,
                        },
                        StartThreadRequest {
                            command_id: session_command.clone(),
                            title: job.issue.title.clone(),
                            branch_name: None,
                            agent_id: None,
                            agent: None,
                            execution_target: Some(ash_protocol::SessionExecutionTarget::Local {
                                root: invocation.workflow.directory.clone().into(),
                            }),
                        },
                    )
                    .map(Into::<core_api::ThreadView>::into)
                {
                    Ok(snapshot) => snapshot,
                    Err(error) => match self
                        .agent_runtime()
                        .read_started_thread(&session_command)
                        .map_err(|error| error.to_string())?
                    {
                        Some(snapshot) => snapshot,
                        None => {
                            observed.status = SymphonyTaskStatus::Retrying;
                            observed.error = Some(error.to_string());
                            return Ok(observed);
                        }
                    },
                },
            },
        };
        observed.session_id = Some(snapshot.session_id.clone());
        observed.thread_id = Some(snapshot.thread_id.clone());
        if symphony_workspace(&invocation.workflow) {
            SymphonyBinder {
                server: self,
                job: &job,
                cancellation,
            }
            .provision(&ThreadWorktreeBindingRequest {
                session_id: snapshot.session_id.clone(),
                thread_id: snapshot.thread_id.clone(),
                origin: ash_protocol::ThreadOrigin::Root,
                branch_name: None,
            })
            .map_err(|error| error.to_string())?;
        }
        self.bind_session_runtime(&snapshot.session_id)
            .map_err(|error| error.to_string())?;
        let accepted = self
            .agent_runtime()
            .accepted_turn(&snapshot.thread_id, &turn_command)
            .map_err(|error| error.to_string())?;
        if accepted.is_none() {
            if job.desired != SymphonyControl::Run {
                observed.status = SymphonyTaskStatus::Paused;
                return Ok(observed);
            }
            if !invocation.prepared {
                let prepared = (|| {
                    if !job.setup_done && !symphony_workspace(&invocation.workflow) {
                        self.symphony_hook(
                            &snapshot.thread_id,
                            &job,
                            "after_create",
                            cancellation,
                        )?;
                    }
                    if !job.worker_prepared {
                        self.symphony_hook(&snapshot.thread_id, &job, "before_run", cancellation)?;
                    }
                    store
                        .prepared(
                            &job,
                            snapshot.session_id.clone(),
                            snapshot.thread_id.clone(),
                        )
                        .map_err(|error| error.to_string())
                })();
                if let Err(error) = prepared {
                    let _ =
                        self.symphony_hook(&snapshot.thread_id, &job, "after_run", cancellation);
                    observed.status = SymphonyTaskStatus::Retrying;
                    observed.error = Some(error);
                    return Ok(observed);
                }
            }
            // A pause racing preparation wins before submission; an accepted Turn is stopped below.
            if store
                .job(&job.id)
                .map_err(|error| error.to_string())?
                .desired
                != SymphonyControl::Run
            {
                observed.status = SymphonyTaskStatus::Paused;
                return Ok(observed);
            }
            cancellation.check().map_err(|error| error.to_string())?;
            let (model, reasoning_effort) = invocation
                .workflow
                .codex
                .model_selection()
                .map_err(|error| error.to_string())?;
            let model_selection = if let Some(model) = model {
                let current = self
                    .model_catalog
                    .configured_default()
                    .map_err(|error| error.to_string())?;
                let matching: Vec<_> = self
                    .model_catalog
                    .list()
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .filter(|entry| entry.model.model.as_str() == model)
                    .map(|entry| entry.model)
                    .collect();
                let selected = current
                    .filter(|current| matching.contains(current))
                    .or_else(|| (matching.len() == 1).then(|| matching[0].clone()))
                    .ok_or("Select an unambiguous Ash connection for the workflow model")?;
                TurnModelSelection::Explicit(selected)
            } else {
                TurnModelSelection::Current
            };
            let approval_mode = match invocation.workflow.codex.approval_policy.as_str() {
                Some("never") => ash_protocol::ApprovalMode::Auto,
                Some("on-request" | "untrusted" | "on-failure") => {
                    ash_protocol::ApprovalMode::Manual
                }
                _ => match invocation.workflow.approval_mode {
                    Some(mode) => mode,
                    None => self
                        .default_approval_mode()
                        .map_err(|error| error.to_string())?,
                },
            };
            let started = self.start_turn_request(
                ThreadMutation {
                    connection_id: None,
                    command_id: turn_command.clone(),
                    session_id: snapshot.session_id.clone(),
                    expected_sequence: snapshot.sequence,
                },
                snapshot.thread_id.clone(),
                approval_mode,
                ash_protocol::CollaborationMode::Agent,
                model_selection,
                reasoning_effort,
                None,
                vec![InputItem::Text {
                    text: invocation.prompt.clone(),
                }],
            );
            if self
                .agent_runtime()
                .accepted_turn(&snapshot.thread_id, &turn_command)
                .map_err(|error| error.to_string())?
                .is_none()
            {
                match started {
                    Ok(_) => return Err("Accepted Symphony Turn is not yet observable".into()),
                    Err(error) => {
                        observed.status = SymphonyTaskStatus::Retrying;
                        observed.error = Some(error.to_string());
                        return Ok(observed);
                    }
                }
            }
        }
        let snapshot = self
            .agent_runtime()
            .read_thread(&snapshot.thread_id)
            .map_err(|error| error.to_string())?;
        let turn_id = self
            .agent_runtime()
            .accepted_turn(&snapshot.thread_id, &turn_command)
            .map_err(|error| error.to_string())?
            .ok_or("Symphony Turn receipt is missing")?;
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.turn_id == turn_id)
            .ok_or("Symphony Turn is missing")?;
        observed.turn_id = Some(turn_id.clone());
        observed.status = match turn.status {
            TurnStatus::Created | TurnStatus::Running => SymphonyTaskStatus::Running,
            TurnStatus::WaitingForApproval
            | TurnStatus::WaitingForUserInput
            | TurnStatus::WaitingForCapability => SymphonyTaskStatus::Blocked,
            TurnStatus::Cancelling => SymphonyTaskStatus::Stopping,
            TurnStatus::Completed => SymphonyTaskStatus::Completed,
            TurnStatus::Failed => SymphonyTaskStatus::Retrying,
            TurnStatus::Interrupted => SymphonyTaskStatus::Paused,
        };
        if turn.started_at_unix_ms.is_some_and(|started| {
            ash_symphony::now().saturating_sub(started) > invocation.workflow.codex.turn_timeout_ms
        }) && !matches!(
            turn.status,
            TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
        ) {
            store.timed_out(&job).map_err(|error| error.to_string())?;
        }
        let stalled = if matches!(
            turn.status,
            TurnStatus::Created
                | TurnStatus::Running
                | TurnStatus::WaitingForApproval
                | TurnStatus::WaitingForUserInput
                | TurnStatus::WaitingForCapability
        ) {
            store
                .stalled(
                    &job,
                    snapshot.sequence,
                    observed.status == SymphonyTaskStatus::Blocked,
                    ash_symphony::now(),
                )
                .map_err(|error| error.to_string())?
        } else {
            job.timing_out
        };
        if matches!(
            turn.status,
            TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
        ) {
            let current_workflow = store
                .workflow(&job.workflow_id)
                .map_err(|error| error.to_string())?;
            let mut completed_job = store.job(&job.id).map_err(|error| error.to_string())?;
            if turn.status == TurnStatus::Completed
                && !job.issue.local
                && job.desired == SymphonyControl::Run
            {
                match self.refresh_symphony(&current_workflow, &job.issue.id, cancellation) {
                    Ok(issue) => {
                        completed_job = store
                            .revalidate(&job, issue)
                            .map_err(|error| error.to_string())?;
                    }
                    Err(error) => {
                        observed.status = SymphonyTaskStatus::Retrying;
                        observed.error = Some(error);
                    }
                }
            }
            observed.error = observed.error.or_else(|| {
                if stalled {
                    Some("Turn stopped after its workflow progress timeout".into())
                } else {
                    turn.failure.as_ref().map(|error| error.message.clone())
                }
            });
            if stalled {
                observed.status = SymphonyTaskStatus::Retrying;
            }
            if (turn.status != TurnStatus::Completed
                || observed.status == SymphonyTaskStatus::Retrying
                || completed_job.desired != SymphonyControl::Run
                || job.issue.local
                || job.turn_number >= current_workflow.max_turns)
                && let Err(error) =
                    self.symphony_hook(&snapshot.thread_id, &job, "after_run", cancellation)
            {
                // Upstream cleanup hooks log failures without changing the worker outcome.
                eprintln!(
                    "Symphony after_run issue={} error={error}",
                    job.issue.identifier
                );
            }
        } else if (job.desired != SymphonyControl::Run || stalled)
            && turn.status != TurnStatus::Cancelling
        {
            self.interrupt_turn_request(
                ThreadMutation {
                    connection_id: None,
                    command_id: command(
                        &format!("stop-{}", job.turn_number),
                        &job.id,
                        job.attempt,
                    )?,
                    session_id: snapshot.session_id,
                    expected_sequence: snapshot.sequence,
                },
                snapshot.thread_id,
                turn_id,
            )
            .map_err(|error| error.to_string())?;
            observed.status = SymphonyTaskStatus::Stopping;
        }
        Ok(observed)
    }

    fn symphony_hook(
        &self,
        thread: &ash_protocol::ThreadId,
        job: &Job,
        name: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        // Reloads affect future hook executions, including the cleanup of an accepted batch.
        let workflow = self
            .symphony
            .as_ref()
            .ok_or("Symphony store is unavailable")?
            .workflow(&job.workflow_id)
            .map_err(|error| error.to_string())?;
        let script = match name {
            "after_create" => workflow.hooks.after_create.as_deref(),
            "before_run" => workflow.hooks.before_run.as_deref(),
            "after_run" => workflow.hooks.after_run.as_deref(),
            "before_remove" => workflow.hooks.before_remove.as_deref(),
            _ => return Err("Unknown Symphony hook".into()),
        };
        if script.is_none_or(|script| script.trim().is_empty()) {
            return Ok(());
        }
        let binding = self
            .git_turn_changes
            .as_ref()
            .and_then(|runtime| runtime.binding(thread))
            .ok_or("Symphony requires an isolated Thread directory for hooks")?;
        self.symphony_hook_at(binding.dir(), &workflow, name, script, cancellation)
    }

    fn symphony_hook_at(
        &self,
        directory: &std::path::Path,
        workflow: &ash_symphony::Workflow,
        name: &str,
        script: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        let Some(script) = script.filter(|script| !script.trim().is_empty()) else {
            return Ok(());
        };
        let source = std::path::Path::new(&workflow.directory);
        if directory == source {
            return Err("Symphony hooks cannot run in the source directory".into());
        }
        let dir = ash_file_access::Dir::open_local(directory).map_err(|error| error.to_string())?;
        let hook = ash_config::HookConfig {
            id: ash_config::HookId::new(format!("user:hook:symphony-{}", name.replace('_', "-")))
                .map_err(|error| error.to_string())?,
            event: ash_protocol::HookEvent::Setup,
            matcher: Default::default(),
            enablement: ash_config::HookEnablement::Enabled,
            action: ash_config::HookAction::Process {
                program: "bash".into(),
                args: vec!["-lc".into(), script.into()],
            },
        };
        let hooks = self
            .local_hook_runtime()
            .ok_or("Hook runtime is unavailable")?;
        let output = hooks
            .execute_process(
                &hook,
                dir,
                Duration::from_millis(workflow.hooks.timeout_ms.unwrap_or(60_000)),
                cancellation,
            )
            .map_err(|error| error.to_string())?;
        if output.exit_code != Some(0) {
            return Err(format!("Symphony {name} hook exited unsuccessfully"));
        }
        Ok(())
    }
}

fn command(action: &str, id: &str, attempt: u32) -> Result<CommandId, String> {
    CommandId::new(format!("symphony-{action}-{id}-{attempt}")).map_err(|error| error.to_string())
}

fn symphony_workspace(workflow: &ash_symphony::Workflow) -> bool {
    workflow.workspace_root.is_some() || !matches!(workflow.tracker, ash_symphony::Tracker::Local)
}

fn workspace_key(identifier: &str) -> String {
    let safe: String = identifier
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "._-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect();
    if safe == identifier && safe != "." && safe != ".." {
        safe
    } else {
        let hash = ash_protocol::ContentDigest::sha256(identifier.as_bytes()).to_string();
        format!(
            "{safe}--{}",
            &hash.strip_prefix("sha256:").unwrap_or(&hash)[..16]
        )
    }
}

struct SymphonyBinder<'a> {
    server: &'a AppServer,
    job: &'a Job,
    cancellation: &'a CancellationToken,
}

impl ThreadWorktreeBinder for SymphonyBinder<'_> {
    fn provision(&self, request: &ThreadWorktreeBindingRequest) -> Result<(), core_api::CoreError> {
        let workflow = &self
            .job
            .invocation
            .as_ref()
            .ok_or_else(|| {
                core_api::CoreError::InvalidInput("Symphony invocation is missing".into())
            })?
            .workflow;
        if !symphony_workspace(workflow) {
            return self.server.thread_worktree_binder.provision(request);
        }
        let runtime = self.server.git_turn_changes.as_ref().ok_or_else(|| {
            core_api::CoreError::InvalidInput("Symphony requires directory services".into())
        })?;
        if runtime.binding(&request.thread_id).is_some() {
            return Ok(());
        }
        let root = self
            .job
            .workspace_root
            .as_deref()
            .or(workflow.workspace_root.as_deref())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("symphony_workspaces"));
        let (directory, created) = runtime
            .dirs
            .worktrees
            .prepare_directory(&root, &workspace_key(&self.job.issue.identifier))
            .map_err(|error| core_api::CoreError::InvalidInput(error.to_string()))?;
        if created
            && let Err(error) = self.server.symphony_hook_at(
                &directory,
                workflow,
                "after_create",
                workflow.hooks.after_create.as_deref(),
                self.cancellation,
            )
        {
            let _ = runtime
                .dirs
                .worktrees
                .remove_prepared_directory(&root, &directory);
            return Err(core_api::CoreError::InvalidInput(error));
        }
        let binding = runtime
            .dirs
            .runtime
            .block_on(runtime.dirs.worktrees.adopt_directory(
                &root,
                &directory,
                &runtime.dirs.root,
                runtime.dirs.id.as_str(),
                &worktree::ManagedDirOwner::Thread {
                    thread_id: request.thread_id.to_string(),
                },
            ))
            .map_err(|error| core_api::CoreError::InvalidInput(error.to_string()))?;
        self.server
            .symphony
            .as_ref()
            .ok_or_else(|| {
                core_api::CoreError::InvalidInput("Symphony store is unavailable".into())
            })?
            .bound_workspace(&self.job.id, root.to_string_lossy().into_owned())
            .map_err(|error| core_api::CoreError::InvalidInput(error.to_string()))?;
        runtime.bind_prepared_directory(&request.thread_id, binding)
    }
}

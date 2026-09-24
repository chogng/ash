use super::ActiveConversation;
use super::App;
use super::AppEvent;
use super::dispatch::ProductCommandOutput;
use crate::config;
use crate::config::Event as ConfigEvent;
use crate::host::Event as HostEvent;
use crate::keymap_setup;
use crate::keymap_setup::Event as KeymapEvent;
use crate::models;
use crate::models::Event as ModelEvent;
use crate::sessions::Conversation;
use crate::sessions::ConversationChange;
use crate::sessions::ConversationCompletion;
use crate::sessions::ConversationTranscript;
use crate::sessions::Event as SessionEvent;
use crate::sessions::ManagerSessionCompletion;
use crate::sessions::SessionCompletion;
use crate::skills::Event as SkillEvent;
use crate::skills::SkillRefreshCompletion;
use crate::status::Event as StatusEvent;
use crate::status::StatusLineSettings;
use crate::thread::ActiveTurnUpdate;
use crate::thread::Event as ThreadEvent;
use crate::thread::ThreadCompletion;
use crate::thread::ThreadRequestScope;
use crate::thread::ThreadSubscription;
use crate::thread::ThreadSwitch;
use crate::thread::TurnStartCompletion;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_protocol::Thread;
#[cfg(test)]
use ash_protocol::Turn;
use ash_protocol::TurnId;
use std::time::Instant;

pub(super) enum Completion {
    Memory(crate::memory::Completion),
    IssueCreated {
        generation: u64,
        result: Result<ConversationCompletion, String>,
    },
    ConfigRefreshed(Result<(ConfigReadResult, ModelListResult), String>),
    Sessions(SessionCompletion),
    ProductCommand {
        command: String,
        result: Result<ProductCommandCompletion, String>,
    },
    Presentation(Result<AppEvent, String>),
    ModelUpdated {
        command: String,
        result: Result<models::ModelUpdate, String>,
    },
    Skills(Result<SkillRefreshCompletion, String>),
    Theme(Result<crate::theme::CommandCompletion, String>),
    Thread(ThreadCompletion),
}

impl Completion {
    fn thread_scope(&self) -> Option<&ThreadRequestScope> {
        match self {
            Self::Thread(completion) => Some(completion.scope()),
            _ => None,
        }
    }
}

pub(super) struct ProductCommandCompletion {
    output: ProductCommandOutput,
    switched: Option<(ThreadSubscription, ThreadSwitch)>,
}

pub(super) fn finish_product_command_request(
    client: &mut AppServerRequestHandle,
    subscription: Option<ThreadSubscription>,
    output: ProductCommandOutput,
) -> Result<ProductCommandCompletion, String> {
    let switched = if output.conversation_change.is_some() {
        let conversation = output
            .conversation
            .as_ref()
            .ok_or("conversation change omitted its session")?;
        Some(match subscription {
            Some(mut subscription) => {
                let switch = subscription
                    .switch(client, conversation.session_id(), conversation.thread_id())
                    .map_err(subscription_error)?;
                (subscription, switch)
            }
            None => {
                let (subscription, snapshot, transcript) = ThreadSubscription::start(
                    client,
                    conversation.session_id(),
                    conversation.thread_id(),
                )
                .map_err(subscription_error)?;
                (
                    subscription,
                    ThreadSwitch::Complete {
                        snapshot,
                        transcript,
                    },
                )
            }
        })
    } else {
        None
    };
    Ok(ProductCommandCompletion { output, switched })
}

fn subscription_error(error: ClientError) -> String {
    format!("the command changed the conversation, but the TUI could not subscribe to it: {error}")
}

pub(super) fn apply_request_completion(
    completion: Completion,
    origin: super::requests::RequestOrigin,
    active: &mut Option<Conversation>,
    app: &mut App,
) {
    let panel_generation = origin.panel_generation;
    if completion.thread_scope().is_some_and(|scope| {
        active.as_ref().is_none_or(|current| {
            !scope.targets(
                current.conversation.session_id(),
                current.conversation.thread_id(),
            )
        })
    }) {
        return;
    }
    match completion {
        Completion::IssueCreated { generation, result } => match result {
            Ok(ConversationCompletion {
                conversation: next,
                change,
                subscription,
                switch,
            }) => {
                *active = Some(Conversation {
                    conversation: next,
                    subscription,
                });
                let conversation = &mut active.as_mut().unwrap().conversation;
                finish_conversation_change(
                    conversation,
                    app,
                    change,
                    switch,
                    ConversationCompletionPresentation::Silent,
                    origin,
                );
                app.finish_issue_start(origin.mode, generation, Ok(()));
            }
            Err(error) => app.finish_issue_start(origin.mode, generation, Err(error)),
        },
        Completion::Memory(_) => unreachable!("memory completions are owned by AppDriver"),
        Completion::ConfigRefreshed(Ok((config, models))) => {
            apply_tui_config(config, Some(&models), app);
        }
        Completion::ConfigRefreshed(Err(error)) => {
            app.update_for_panel(panel_generation, ThreadEvent::FailureReported(error));
        }
        Completion::Sessions(SessionCompletion::Forked {
            command,
            result: Ok(result),
        }) => {
            app.update_for_panel(panel_generation, result.into_event(command));
        }
        Completion::Sessions(SessionCompletion::Preview { generation, result }) => {
            app.finish_session_preview(origin.mode, generation, result);
        }
        Completion::Sessions(SessionCompletion::Catalog(Ok(sessions))) => {
            app.update_for_panel(panel_generation, SessionEvent::CatalogReceived(sessions));
        }
        Completion::Sessions(SessionCompletion::Catalog(Err(error))) => {
            app.show_overlay_in(
                origin.mode,
                crate::widgets::detail_list::DetailList::new(
                    "Session operation failed",
                    vec![crate::widgets::detail_list::DetailListRow::new(
                        "Error", error,
                    )],
                ),
            );
        }
        Completion::Sessions(SessionCompletion::ManagerCreated(Ok(ManagerSessionCompletion {
            conversation:
                ConversationCompletion {
                    conversation: next_conversation,
                    change,
                    subscription,
                    switch,
                },
            turn,
        }))) => {
            let draft = app.sessions.pending_submission.take();
            let rejected = matches!(&turn, TurnStartCompletion::Rejected(_));
            *active = Some(Conversation {
                conversation: next_conversation,
                subscription,
            });
            let Conversation {
                conversation,
                subscription: thread_subscription,
            } = active.as_mut().unwrap();
            finish_conversation_change(
                conversation,
                app,
                change,
                switch,
                ConversationCompletionPresentation::Silent,
                origin,
            );
            app.show_policy_tip(Instant::now());
            apply_turn_start_completion(turn, conversation, thread_subscription, app);
            if rejected && let Some(draft) = draft {
                app.thread_presentations
                    .active_mut()
                    .input
                    .restore_queued(draft)
                    .expect("a newly created conversation starts with an empty draft");
            }
        }
        Completion::Sessions(SessionCompletion::ManagerCreated(Err(error))) => {
            app.fail_session_creation(error);
        }
        Completion::Sessions(SessionCompletion::ThreadChanged(Ok(ConversationCompletion {
            conversation: next_conversation,
            change,
            subscription,
            switch,
        }))) => {
            *active = Some(Conversation {
                conversation: next_conversation,
                subscription,
            });
            let conversation = &mut active.as_mut().unwrap().conversation;
            finish_conversation_change(
                conversation,
                app,
                change,
                switch,
                ConversationCompletionPresentation::Notice,
                origin,
            );
        }
        Completion::Sessions(SessionCompletion::ThreadChanged(Err(error))) => {
            app.update_for_panel(panel_generation, ThreadEvent::FailureReported(error));
        }
        Completion::Sessions(SessionCompletion::Changed {
            command,
            result:
                Ok(ConversationCompletion {
                    conversation: next_conversation,
                    change,
                    subscription,
                    switch,
                }),
        }) => {
            *active = Some(Conversation {
                conversation: next_conversation,
                subscription,
            });
            let conversation = &mut active.as_mut().unwrap().conversation;
            finish_conversation_change(
                conversation,
                app,
                change,
                switch,
                ConversationCompletionPresentation::Command(command),
                origin,
            );
        }
        Completion::Sessions(SessionCompletion::Changed {
            command,
            result: Err(error),
        })
        | Completion::Sessions(SessionCompletion::Forked {
            command,
            result: Err(error),
        })
        | Completion::ProductCommand {
            command,
            result: Err(error),
        } => {
            app.update_for_panel(
                panel_generation,
                ThreadEvent::CommandFailed { command, error },
            );
        }
        Completion::Presentation(Err(error)) => {
            app.update_for_panel(panel_generation, ThreadEvent::FailureReported(error))
        }
        Completion::ProductCommand {
            result:
                Ok(ProductCommandCompletion {
                    mut output,
                    switched,
                }),
            ..
        } => {
            for event in output.events.drain(..) {
                app.update_for_panel(panel_generation, event);
            }
            if let Some(change) = output.conversation_change.take() {
                let Some((subscription, switch)) = switched else {
                    app.update_for_panel(
                        panel_generation,
                        ThreadEvent::FailureReported(
                            "conversation command completed without a subscription result".into(),
                        ),
                    );
                    return;
                };
                let Some(conversation) = output.conversation else {
                    return;
                };
                *active = Some(Conversation {
                    conversation,
                    subscription,
                });
                let conversation = &mut active.as_mut().unwrap().conversation;
                let command = output.command;
                finish_conversation_change(
                    conversation,
                    app,
                    change,
                    switch,
                    ConversationCompletionPresentation::Command(command),
                    origin,
                );
            }
        }
        Completion::Presentation(Ok(event)) => app.update_from_origin(origin, event),
        Completion::ModelUpdated {
            command,
            result: Ok(update),
        } => {
            let picker = update.picker;
            if picker.is_none() {
                app.update_for_panel(
                    panel_generation,
                    ModelEvent::SummaryReceived(update.summary),
                );
            }
            app.update_for_panel(
                panel_generation,
                ThreadEvent::CommandCompleted {
                    command,
                    result: update.notice,
                },
            );
            if let Some(picker) = picker {
                app.update_for_panel(panel_generation, ModelEvent::PickerUpdated(picker));
            } else {
                app.update_for_panel(panel_generation, AppEvent::CommandPanelClosed);
            }
        }
        Completion::ModelUpdated {
            command,
            result: Err(error),
        } => app.update_for_panel(
            panel_generation,
            ThreadEvent::CommandFailed { command, error },
        ),
        Completion::Theme(Ok(crate::theme::CommandCompletion::Presentation(event))) => {
            app.update_for_panel(panel_generation, event);
        }
        Completion::Theme(Ok(crate::theme::CommandCompletion::Updated {
            command,
            label,
            theme,
            result: Ok(()),
        })) => {
            app.update_for_panel(panel_generation, crate::theme::Event::RenderChanged(theme));
            app.update_for_panel(
                panel_generation,
                ThreadEvent::CommandCompleted {
                    command,
                    result: format!("Theme set to {label}"),
                },
            );
        }
        Completion::Theme(Ok(crate::theme::CommandCompletion::Updated {
            command,
            result: Err(error),
            ..
        })) => app.update_for_panel(
            panel_generation,
            ThreadEvent::CommandFailed { command, error },
        ),
        Completion::Theme(Err(error)) => {
            app.update_for_panel(panel_generation, ThreadEvent::FailureReported(error))
        }
        Completion::Skills(Ok(refresh)) => {
            app.replace_chat_input_catalog(refresh.input_catalog);
            if app.skills_view_is_active() {
                app.update_for_panel(
                    panel_generation,
                    SkillEvent::SettingsUpdated(refresh.choices),
                );
            } else {
                app.update_for_panel(
                    panel_generation,
                    SkillEvent::DiagnosticsReceived(refresh.choices.diagnostics),
                );
            }
        }
        Completion::Skills(Err(error)) => {
            if app.skills_view_is_active() {
                app.update_for_panel(panel_generation, ThreadEvent::FailureReported(error));
            }
        }
        Completion::Thread(completion) => {
            if let Some(current) = active.as_mut() {
                apply_thread_completion(
                    completion,
                    &mut current.conversation,
                    &mut current.subscription,
                    app,
                    origin,
                );
            }
        }
    }
}

fn apply_thread_completion(
    completion: ThreadCompletion,
    conversation: &mut ActiveConversation,
    thread_subscription: &mut ThreadSubscription,
    app: &mut App,
    origin: super::requests::RequestOrigin,
) {
    let panel_generation = origin.panel_generation;
    match completion {
        ThreadCompletion::RewindPickerLoaded {
            result: Ok(choices),
            ..
        } => app.update_for_panel(panel_generation, ThreadEvent::RewindPickerOpened(choices)),
        ThreadCompletion::RewindPickerLoaded {
            result: Err(error), ..
        } => app.update(ThreadEvent::FailureReported(error)),
        ThreadCompletion::Started { result, .. } => {
            apply_turn_start_completion(result, conversation, thread_subscription, app)
        }
        ThreadCompletion::QueueUpdated {
            queue_id,
            restore,
            result,
            ..
        } => match result {
            Ok(snapshot) => {
                app.update(ThreadEvent::QueueReceived {
                    messages: snapshot.messages,
                    restore,
                });
                if restore.is_some() && app.thread_presentations.active().queue.is_editing() {
                    match origin.mode {
                        crate::terminal::ScreenMode::Fullscreen => {
                            app.fullscreen.viewports.active_mut().queue.blur()
                        }
                        crate::terminal::ScreenMode::Inline => {
                            app.inline.viewports.active_mut().queue.blur()
                        }
                    }
                }
            }
            Err(error) => app.update(ThreadEvent::QueueFailed {
                queue_id,
                error: error.to_string(),
            }),
        },
        ThreadCompletion::Steered {
            steer_id,
            result: Ok((steer, snapshot)),
            ..
        } => {
            app.update(ThreadEvent::SteerCompleted { steer_id });
            if snapshot.thread.sequence < conversation.thread_sequence().max(steer.sequence) {
                return;
            }
            conversation.set_thread_sequence(snapshot.thread.sequence.max(steer.sequence));
            let install_transcript = thread_subscription.apply_latest_snapshot(
                &snapshot.thread,
                snapshot.transcript.revision,
                snapshot.boundary,
            );
            apply_thread_snapshot_parts(
                app,
                snapshot.thread,
                install_transcript.then_some(snapshot.transcript),
            );
        }
        ThreadCompletion::Steered {
            steer_id,
            result: Err(error),
            ..
        } => {
            app.update(ThreadEvent::SteerSubmissionFailed {
                steer_id,
                error: error.to_string(),
            });
        }
        ThreadCompletion::RequestResolved {
            request,
            result: Ok(snapshot),
            ..
        } => {
            app.update(ThreadEvent::RequestResolved(request));
            if snapshot.thread.sequence < conversation.thread_sequence() {
                return;
            }
            conversation.set_thread_sequence(snapshot.thread.sequence);
            let install_transcript = thread_subscription.apply_latest_snapshot(
                &snapshot.thread,
                snapshot.transcript.revision,
                snapshot.boundary,
            );
            apply_thread_snapshot_parts(
                app,
                snapshot.thread,
                install_transcript.then_some(snapshot.transcript),
            );
        }
        ThreadCompletion::RequestResolved {
            request,
            result: Err(error),
            ..
        } => {
            app.update(ThreadEvent::RequestSubmissionFailed {
                request,
                error: error.to_string(),
            });
        }
        ThreadCompletion::Refreshed {
            result: Ok(snapshot),
            ..
        } => {
            if snapshot.thread.sequence < conversation.thread_sequence() {
                return;
            }
            conversation.set_thread_sequence(snapshot.thread.sequence);
            let install_transcript = thread_subscription.apply_latest_snapshot(
                &snapshot.thread,
                snapshot.transcript.revision,
                snapshot.boundary,
            );
            apply_thread_snapshot_parts(
                app,
                snapshot.thread,
                install_transcript.then_some(snapshot.transcript),
            );
        }
        ThreadCompletion::HistoryPage {
            result: Ok(page), ..
        } => {
            thread_subscription.apply_history_page(&page.thread, page.boundary);
            app.update(ThreadEvent::TranscriptHistoryPageReceived(page.transcript));
        }
        ThreadCompletion::HistoryPage {
            result: Err(error), ..
        } => {
            app.update(ThreadEvent::FailureReported(error.to_string()));
        }
        ThreadCompletion::Refreshed {
            result: Err(error), ..
        } => {
            app.update(ThreadEvent::FailureReported(error.to_string()));
        }
        ThreadCompletion::Interrupted {
            result: Ok(snapshot),
            ..
        } => {
            if snapshot.thread.sequence < conversation.thread_sequence() {
                return;
            }
            conversation.set_thread_sequence(snapshot.thread.sequence);
            let install_transcript = thread_subscription.apply_latest_snapshot(
                &snapshot.thread,
                snapshot.transcript.revision,
                snapshot.boundary,
            );
            apply_thread_snapshot_parts(
                app,
                snapshot.thread,
                install_transcript.then_some(snapshot.transcript),
            );
        }
        ThreadCompletion::Interrupted {
            result: Err(error), ..
        } => {
            app.update(ThreadEvent::InterruptFailed(error.to_string()));
        }
    }
}

pub(super) fn apply_tui_config(
    config: ConfigReadResult,
    model_catalog: Option<&ash_app_server_protocol::protocol::model::ModelListResult>,
    app: &mut App,
) {
    if let Some(super::command_panel::CommandPanel::Memories(panel)) =
        app.panels_mut().command_mut()
    {
        panel.set_enabled(
            config
                .features
                .iter()
                .find(|state| state.feature == features::Feature::Memories)
                .expect("config includes memories")
                .enabled,
        );
    }
    match config::TerminalSettings::from_tui(&config.tui) {
        Ok(settings) => app.update(ConfigEvent::SettingsReceived(settings)),
        Err(error) => app.update(ThreadEvent::FailureReported(error)),
    }
    match keymap_setup::settings_from_tui(&config.tui) {
        Ok(settings) => app.update(KeymapEvent::SettingsReceived(settings)),
        Err(error) => app.update(ThreadEvent::FailureReported(error)),
    }
    match StatusLineSettings::from_tui(&config.tui) {
        Ok(settings) => app.update(StatusEvent::LineSettingsReceived(settings)),
        Err(error) => app.update(ThreadEvent::FailureReported(error)),
    }
    app.update(ModelEvent::SummaryReceived(
        crate::models::ModelSummary::from_catalog(
            config.model,
            config.model_reasoning_effort,
            model_catalog,
        ),
    ));
}

fn report_turn_start_failure(app: &mut App, error: String) {
    if app.active_turn().is_some() {
        app.update(HostEvent::OperationCompleted(Err(format!(
            "could not start the Turn: {error}"
        ))));
    } else {
        app.update(ThreadEvent::FailureReported(error));
    }
}

fn apply_turn_start_completion(
    result: TurnStartCompletion,
    conversation: &mut ActiveConversation,
    thread_subscription: &mut ThreadSubscription,
    app: &mut App,
) {
    match result {
        TurnStartCompletion::Rejected(error) => report_turn_start_failure(app, error.to_string()),
        TurnStartCompletion::Accepted { start, snapshot } => {
            conversation.set_thread_sequence(start.sequence);
            app.set_active_turn_if_idle(start.turn_id);
            match *snapshot {
                Ok(snapshot) => {
                    if snapshot.thread.sequence < conversation.thread_sequence() {
                        return;
                    }
                    conversation.set_thread_sequence(snapshot.thread.sequence.max(start.sequence));
                    let install_transcript = thread_subscription.apply_latest_snapshot(
                        &snapshot.thread,
                        snapshot.transcript.revision,
                        snapshot.boundary,
                    );
                    apply_thread_snapshot_parts(
                        app,
                        snapshot.thread,
                        install_transcript.then_some(snapshot.transcript),
                    );
                }
                Err(error) => {
                    app.update(HostEvent::OperationCompleted(Err(format!(
                        "Turn was accepted, but its updated snapshot could not be read: {error}"
                    ))));
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn apply_active_turn_snapshot(app: &mut App, turns: &[Turn]) {
    for update in app.sync_active_turn(turns) {
        apply_active_turn_update(app, update);
    }
}

fn apply_active_turn_update(app: &mut App, update: ActiveTurnUpdate) {
    match update {
        ActiveTurnUpdate::ActivityChanged(activity) => {
            app.update(ThreadEvent::TurnActivityChanged(activity));
        }
        ActiveTurnUpdate::Failed => app.update(ThreadEvent::TurnFailed),
        ActiveTurnUpdate::Completed => app.update(ThreadEvent::TurnCompleted),
        ActiveTurnUpdate::FailureReported(error) => app.update(ThreadEvent::FailureReported(error)),
        ActiveTurnUpdate::Interrupted => app.update(ThreadEvent::TurnInterrupted),
        ActiveTurnUpdate::Unchanged => {}
    }
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod tests;

pub(super) fn apply_thread_snapshot(
    app: &mut App,
    snapshot: Thread,
    transcript: ThreadTranscriptSnapshot,
) {
    apply_thread_snapshot_parts(app, snapshot, Some(transcript));
}

fn apply_thread_snapshot_parts(
    app: &mut App,
    snapshot: Thread,
    transcript: Option<ThreadTranscriptSnapshot>,
) {
    app.update(ThreadEvent::ContextChanged {
        session_id: snapshot.session_id.clone(),
        thread_id: snapshot.thread_id.clone(),
    });
    app.update(ThreadEvent::AccountingChanged {
        usage: snapshot.usage.clone(),
        reference_cost: snapshot.reference_cost.clone(),
    });
    app.update(ThreadEvent::ContextUsageChanged(
        snapshot
            .turns
            .last()
            .and_then(|turn| Some((turn.model.clone()?, turn.context_usage.clone()?))),
    ));
    app.update(ThreadEvent::GoalChanged(snapshot.goal.clone()));
    let active_turn_updates = app.sync_active_turn(&snapshot.turns);
    let active_turn = app.active_turn().cloned();
    let plan = turn_plan(active_turn.as_ref(), &snapshot.turns);
    let pending_interaction = active_turn.as_ref().and_then(|turn_id| {
        snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .and_then(|turn| {
                turn.pending_interaction
                    .as_ref()
                    .map(|pending| (turn.turn_id.clone(), pending.request_id.clone()))
            })
    });
    if let Some(transcript) = transcript {
        app.update(ThreadEvent::TranscriptSnapshotReceived(transcript));
    }
    app.update(ThreadEvent::TurnPlanChanged(plan));
    app.update(ThreadEvent::PendingInteractionChanged(pending_interaction));
    for update in active_turn_updates {
        apply_active_turn_update(app, update);
    }
    let current_approval_mode = active_turn.as_ref().and_then(|turn_id| {
        snapshot
            .turns
            .iter()
            .find(|turn| turn.turn_id == *turn_id)
            .map(|turn| turn.approval_mode)
    });
    app.set_current_approval_mode(current_approval_mode);
}

fn turn_plan(
    active_turn: Option<&TurnId>,
    turns: &[ash_protocol::Turn],
) -> Option<ash_protocol::PlanUpdate> {
    active_turn.and_then(|turn_id| {
        turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .and_then(|turn| turn.plan.clone())
    })
}

enum ConversationCompletionPresentation {
    Command(String),
    Notice,
    Silent,
}

fn finish_conversation_change(
    conversation: &mut ActiveConversation,
    app: &mut App,
    change: ConversationChange,
    switch: ThreadSwitch,
    presentation: ConversationCompletionPresentation,
    origin: super::requests::RequestOrigin,
) {
    let mode = app.presentation_mode(origin);
    if matches!(presentation, ConversationCompletionPresentation::Command(_)) {
        app.update_for_panel(origin.panel_generation, AppEvent::CommandPanelClosed);
    }
    if matches!(change.transcript, ConversationTranscript::Clear) {
        app.update(ThreadEvent::TranscriptCleared);
    }
    app.clear_active_turn();
    match switch {
        ThreadSwitch::Complete {
            snapshot,
            transcript,
        } => {
            conversation.set_thread_sequence(snapshot.sequence);
            apply_thread_snapshot(app, snapshot, transcript);
        }
        ThreadSwitch::StaleSubscription {
            snapshot,
            transcript,
            error,
        } => {
            conversation.set_thread_sequence(snapshot.sequence);
            apply_thread_snapshot(app, snapshot, transcript);
            app.update(ThreadEvent::FailureReported(format!(
                "changed Thread, but could not unsubscribe the previous Thread: {error}"
            )));
        }
    }
    app.show_conversation_in(mode);
    match presentation {
        ConversationCompletionPresentation::Command(command) => {
            app.update(ThreadEvent::CommandCompleted {
                command,
                result: change.notice,
            });
        }
        ConversationCompletionPresentation::Notice => {
            app.update(ThreadEvent::ProductNotice(change.notice));
        }
        ConversationCompletionPresentation::Silent => {}
    }
}

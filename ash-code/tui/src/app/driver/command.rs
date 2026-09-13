use super::AppDriver;
use super::CommandEffect;
use super::ScheduledCommand;
use crate::app::AppCommand;
use crate::app::completion::Completion;
use crate::app::completion::finish_product_command_request;
use crate::app::dispatch::execute_product_command;
use crate::app::requests::RequestKey;
use crate::app::requests::RequestOrigin;
use crate::app::requests::request_key;
use crate::config;
use crate::connectors;
use crate::dirs;
use crate::host::Command as HostCommand;
use crate::host::Operation as HostOperation;
use crate::keymap_setup;
use crate::mcp;
use crate::sessions;
use crate::sessions::CommandRequest as SessionCommandRequest;
use crate::sessions::SessionCompletion;
use crate::sessions::finish_conversation_request;
use crate::skills;
use crate::status as status_line;
use crate::theme as theme_feature;
use crate::thread;
use crate::thread::Command as ThreadCommand;
use crate::thread::CommandPreparation as ThreadCommandPreparation;
use crate::thread::Event as ThreadEvent;
use std::time::Instant;

impl AppDriver {
    pub(in crate::app) fn execute(&mut self, scheduled: ScheduledCommand) -> CommandEffect {
        let ScheduledCommand { command, origin } = scheduled;
        let request_key = request_key(&command);
        match command {
            AppCommand::Issues(command) => {
                let mut client = self.client.clone();
                if let crate::issues::Command::Start { generation, .. } = &command {
                    let generation = *generation;
                    let conversation = self.conversation.clone();
                    self.requests.spawn(
                        request_key,
                        "ash-tui-issue-start",
                        move || Completion::IssueCreated {
                            generation,
                            result: crate::issues::start(client, conversation, command),
                        },
                        &mut self.app,
                        origin,
                    );
                } else {
                    self.requests.spawn_presentation(
                        request_key,
                        "ash-tui-issues",
                        move || crate::issues::execute(&mut client, command),
                        &mut self.app,
                        origin,
                    );
                }
            }
            AppCommand::Config(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || config::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Connectors(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || connectors::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Dirs(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                let Some(current) = self.conversation.as_ref() else {
                    self.app.update(ThreadEvent::FailureReported(
                        "Start or resume a session to manage directories".into(),
                    ));
                    return CommandEffect::None;
                };
                let session_id = current.conversation.session_id().clone();
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || dirs::execute(&mut client, &session_id, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Git(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || crate::git::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Host(command) => self.execute_host_command(request_key, command, origin),
            AppCommand::Keymap(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || keymap_setup::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Mcp(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || mcp::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Models(command) => {
                let command_line = command.command_line();
                self.app
                    .update(ThreadEvent::CommandStarted(command_line.clone()));
                let name = command.request_name();
                let mut client = self.client.clone();
                self.requests.spawn(
                    request_key,
                    name,
                    move || Completion::ModelUpdated {
                        command: command_line,
                        result: crate::models::execute(&mut client, command),
                    },
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Projects(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                let workspace = self.app.startup_context().workspace.clone();
                let session_id = self
                    .conversation
                    .as_ref()
                    .map(|current| current.conversation.session_id().clone());
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || {
                        crate::projects::execute(
                            &mut client,
                            &workspace,
                            session_id.as_ref(),
                            command,
                        )
                    },
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Sessions(command) => {
                self.execute_session_command(request_key, command, origin)
            }
            AppCommand::Memories(command) => {
                let mut client = self.client.clone();
                let thread_id = self
                    .conversation
                    .as_ref()
                    .map(|current| current.conversation.thread_id().clone());
                self.requests.spawn_presentation(
                    request_key,
                    "ash-tui-memories",
                    move || crate::memories::execute(&mut client, thread_id.as_ref(), command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Skills(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                let session_id = self
                    .conversation
                    .as_ref()
                    .map(|current| current.conversation.session_id().clone());
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || skills::execute(&mut client, session_id.as_ref(), command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Status(command) => {
                let name = command.request_name();
                let mut client = self.client.clone();
                if matches!(command, status_line::Command::OpenPanel) {
                    let scope = self.conversation.as_ref().map(|current| {
                        (
                            current.conversation.session_id().clone(),
                            current.conversation.thread_id().clone(),
                        )
                    });
                    self.requests.spawn_presentation(
                        request_key,
                        name,
                        move || {
                            let scope = scope.as_ref().map(|(session_id, thread_id)| {
                                status_line::StatusRequestScope {
                                    session_id,
                                    thread_id,
                                }
                            });
                            status_line::load_status_panel(&mut client, scope)
                                .map(status_line::Event::PanelOpened)
                                .map_err(|error| error.to_string())
                        },
                        &mut self.app,
                        origin,
                    );
                    return CommandEffect::None;
                }
                self.requests.spawn_presentation(
                    request_key,
                    name,
                    move || status_line::execute(&mut client, command),
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Theme(command) => {
                if let Some(command_line) = command.command_line() {
                    self.app.update(ThreadEvent::CommandStarted(command_line));
                }
                let name = command.request_name();
                let mut client = self.client.clone();
                let theme_resource = self.theme_resource.clone();
                self.requests.spawn(
                    request_key,
                    name,
                    move || {
                        let command_line = command.command_line();
                        match (
                            command_line,
                            theme_feature::execute(&mut client, &theme_resource, command),
                        ) {
                            (Some(command), Err(error)) => {
                                Completion::Presentation(Ok(ThreadEvent::CommandFailed {
                                    command,
                                    error,
                                }
                                .into()))
                            }
                            (_, result) => Completion::Theme(result),
                        }
                    },
                    &mut self.app,
                    origin,
                );
            }
            AppCommand::Thread(command) => {
                self.execute_thread_command(request_key, command, origin)
            }
            AppCommand::Quit => return CommandEffect::Quit,
            AppCommand::Suspend => return CommandEffect::Suspend,
        }
        CommandEffect::None
    }

    fn execute_host_command(
        &mut self,
        request_key: Option<RequestKey>,
        command: HostCommand,
        origin: RequestOrigin,
    ) {
        let operation = match command {
            HostCommand::CopyLastResponse => HostOperation::CopyLastResponse(
                self.app
                    .latest_agent_response()
                    .map(str::to_owned)
                    .ok_or_else(|| "there is no Ash response to copy".to_owned()),
            ),
            HostCommand::ExportTranscript { requested_path } => HostOperation::ExportTranscript {
                root: self.host_dir_root.clone(),
                requested_path,
                markdown: self.app.transcript_markdown(),
            },
            HostCommand::ReadClipboardImage { target } => {
                HostOperation::ReadClipboardImage { target }
            }
            HostCommand::RefreshClipboardImageAvailability => {
                HostOperation::RefreshClipboardImageAvailability
            }
        };
        let name = operation.name();
        self.requests.spawn_presentation(
            request_key,
            name,
            move || Ok(operation.execute()),
            &mut self.app,
            origin,
        );
    }

    fn execute_session_command(
        &mut self,
        request_key: Option<RequestKey>,
        command: sessions::Command,
        origin: RequestOrigin,
    ) {
        if let Some(command_line) = command.command_line() {
            self.app.update(ThreadEvent::CommandStarted(command_line));
        }
        let request: SessionCommandRequest =
            sessions::prepare_command(self.app.approval_mode(), command);
        let name = request.name();
        let client = self.client.clone();
        let conversation = self.conversation.clone();
        self.requests.spawn(
            request_key,
            name,
            move || Completion::Sessions(request.execute(client, conversation)),
            &mut self.app,
            origin,
        );
    }

    fn execute_thread_command(
        &mut self,
        request_key: Option<RequestKey>,
        command: ThreadCommand,
        origin: RequestOrigin,
    ) {
        let preparation = thread::prepare_command(
            self.conversation
                .as_ref()
                .and_then(|current| current.subscription.older_history()),
            self.app.thread_command_state(),
            command,
        );
        match preparation {
            ThreadCommandPreparation::RestoreMessage {
                item_id,
                boundary,
                checkpoint_label,
            } => self.execute_message_restore(
                request_key,
                item_id,
                boundary,
                checkpoint_label,
                origin,
            ),
            ThreadCommandPreparation::ExecuteProductCommand(invocation) => {
                self.execute_product_command(request_key, invocation, origin);
            }
            ThreadCommandPreparation::RewindToCheckpoint {
                before_turn_id,
                checkpoint_label,
            } => self.execute_rewind(request_key, before_turn_id, checkpoint_label, origin),
            ThreadCommandPreparation::CycleNextApprovalMode => {
                self.app.cycle_next_approval_mode(Instant::now());
            }
            ThreadCommandPreparation::Request(request) => {
                let name = request.name();
                let client = self.client.clone();
                let Some(scope) = self.thread_request_scope() else {
                    self.app.update(ThreadEvent::FailureReported(
                        "Start or resume a session before using this command".into(),
                    ));
                    return;
                };
                let history = self.conversation.as_ref().unwrap().subscription.history();
                self.requests.spawn(
                    request_key,
                    name,
                    move || Completion::Thread(request.execute(client, scope, history)),
                    &mut self.app,
                    origin,
                );
            }
            ThreadCommandPreparation::Present(event) => self.app.update(event),
            ThreadCommandPreparation::Requeue(command) => {
                self.queued_commands.push_front(ScheduledCommand {
                    command: command.into(),
                    origin,
                });
            }
            ThreadCommandPreparation::None => {}
        }
    }

    fn execute_product_command(
        &mut self,
        request_key: Option<RequestKey>,
        invocation: crate::thread::composer::SlashCommandInvocation,
        origin: RequestOrigin,
    ) {
        let mut client = self.client.clone();
        let conversation = self
            .conversation
            .as_ref()
            .map(|current| current.conversation.clone());
        let subscription = self
            .conversation
            .as_ref()
            .map(|current| current.subscription.clone());
        let workspace = self.app.startup_context().workspace.clone();
        self.requests.spawn(
            request_key,
            "ash-tui-product-command",
            move || Completion::ProductCommand {
                command: invocation.display_text(),
                result: execute_product_command(conversation, &mut client, &workspace, invocation)
                    .and_then(|output| {
                        finish_product_command_request(&mut client, subscription, output)
                    }),
            },
            &mut self.app,
            origin,
        );
    }

    fn execute_rewind(
        &mut self,
        request_key: Option<RequestKey>,
        before_turn_id: ash_protocol::TurnId,
        checkpoint_label: String,
        origin: RequestOrigin,
    ) {
        let command = format!("/rewind {before_turn_id}");
        self.app
            .update(ThreadEvent::CommandStarted(command.clone()));
        let mut client = self.client.clone();
        let Some(current) = self.conversation.as_ref() else {
            return;
        };
        let mut conversation = current.conversation.clone();
        let subscription = current.subscription.clone();
        self.requests.spawn(
            request_key,
            "ash-tui-rewind-thread",
            move || {
                Completion::Sessions(SessionCompletion::Changed {
                    command,
                    result: conversation
                        .rewind_active_thread(&mut client, before_turn_id, &checkpoint_label)
                        .map_err(|error| error.to_string())
                        .and_then(|change| {
                            finish_conversation_request(
                                &mut client,
                                conversation,
                                Some(subscription),
                                change,
                            )
                        }),
                })
            },
            &mut self.app,
            origin,
        );
    }
    fn execute_message_restore(
        &mut self,
        request_key: Option<RequestKey>,
        item_id: ash_protocol::ItemId,
        boundary: ash_protocol::MessageBoundary,
        checkpoint_label: String,
        origin: RequestOrigin,
    ) {
        let command = format!("/rewind {boundary:?} {checkpoint_label}");
        self.app
            .update(ThreadEvent::CommandStarted(command.clone()));
        let mut client = self.client.clone();
        let Some(current) = self.conversation.as_ref() else {
            return;
        };
        let mut conversation = current.conversation.clone();
        let subscription = current.subscription.clone();
        self.requests.spawn(
            request_key,
            "ash-tui-rewind-thread",
            move || {
                Completion::Sessions(SessionCompletion::Changed {
                    command,
                    result: conversation
                        .restore_message(&mut client, item_id, boundary, &checkpoint_label)
                        .map_err(|error| error.to_string())
                        .and_then(|change| {
                            finish_conversation_request(
                                &mut client,
                                conversation,
                                Some(subscription),
                                change,
                            )
                        }),
                })
            },
            &mut self.app,
            origin,
        );
    }
}

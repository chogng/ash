//! Built-in product command dispatch for the active Session and Thread.

use crate::app::AppEvent;
use crate::dirs;
use crate::mcp;
use crate::models;
use crate::sessions;
use crate::sessions::ActiveConversation;
use crate::sessions::ConversationChange;
use crate::skills::load_selection;
use crate::status;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::SlashCommandInvocation;
use crate::thread::composer::TuiSlashCommandAction;
use crate::thread::rewind;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::skills::SkillCatalogReloadDto;
use ash_protocol::TurnId;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;

pub(crate) struct ProductCommandOutput {
    pub(crate) conversation: Option<ActiveConversation>,
    pub(crate) command: String,
    pub(crate) events: Vec<AppEvent>,
    pub(crate) conversation_change: Option<ConversationChange>,
}

pub(crate) fn execute_product_command<T>(
    mut conversation: Option<ActiveConversation>,
    client: &mut AppServerClient<T>,
    workspace: &Path,
    invocation: SlashCommandInvocation,
) -> Result<ProductCommandOutput, String>
where
    T: JsonRpcTransport,
{
    let command = invocation.display_text();
    dispatch(&mut conversation, client, workspace, invocation)
        .map(|output| ProductCommandOutput {
            conversation,
            command,
            events: output.events,
            conversation_change: output.conversation_change,
        })
        .map_err(|error| error.to_string())
}

fn dispatch<T>(
    conversation: &mut Option<ActiveConversation>,
    client: &mut AppServerClient<T>,
    workspace: &Path,
    invocation: SlashCommandInvocation,
) -> Result<CommandOutput, CommandExecutionError>
where
    T: JsonRpcTransport,
{
    let command = invocation
        .command
        .name
        .parse::<TuiSlashCommandAction>()
        .map_err(|_| {
            CommandExecutionError("server command reached the TUI-local dispatcher".into())
        })?;
    let arguments = text_arguments(&invocation.arguments)?;
    let mut output = CommandOutput::default();

    match command {
        TuiSlashCommandAction::Pr
        | TuiSlashCommandAction::Issue
        | TuiSlashCommandAction::Dashboard
        | TuiSlashCommandAction::Subagents => {
            return Err(CommandExecutionError(format!(
                "/{} must be handled by the TUI navigation layer",
                command.command()
            )));
        }
        TuiSlashCommandAction::Status => {
            output.events.push(
                status::Event::PanelOpened(status::load_status_panel(
                    client,
                    conversation
                        .as_ref()
                        .map(|conversation| status::StatusRequestScope {
                            session_id: conversation.session_id(),
                            thread_id: conversation.thread_id(),
                        }),
                )?)
                .into(),
            );
        }
        TuiSlashCommandAction::Memories => {
            let command = if arguments.is_empty() {
                crate::memories::Command::Scopes
            } else {
                crate::memories::Command::Citation(arguments)
            };
            output.events.push(
                crate::memories::execute(
                    client,
                    conversation.as_ref().map(ActiveConversation::thread_id),
                    command,
                )
                .map_err(CommandExecutionError)?
                .into(),
            );
        }
        TuiSlashCommandAction::Skills => {
            output.events.push(
                crate::skills::Event::SettingsOpened(load_selection(
                    client,
                    conversation.as_ref().map(ActiveConversation::session_id),
                    SkillCatalogReloadDto::Refresh,
                )?)
                .into(),
            );
        }
        TuiSlashCommandAction::Mcp => {
            output
                .events
                .push(mcp::Event::SettingsOpened(mcp::load_selection(client)?).into());
        }
        TuiSlashCommandAction::Connectors => {
            output.events.push(
                crate::connectors::Event::PickerOpened(crate::connectors::load_selection(client)?)
                    .into(),
            );
        }
        TuiSlashCommandAction::Resume => {
            if arguments.is_empty() {
                output.events.push(
                    sessions::Event::PickerOpened(sessions::load_selection(
                        client,
                        conversation.as_ref().map(|c| c.session_id().as_str()),
                    )?)
                    .into(),
                );
            } else {
                let next =
                    ActiveConversation::open(client, &arguments, None).map_err(session_error)?;
                output.conversation_change = Some(ConversationChange {
                    notice: format!(
                        "Resumed session {} on thread {}.",
                        next.session_id(),
                        next.thread_id()
                    ),
                    transcript: crate::sessions::ConversationTranscript::Replace,
                });
                *conversation = Some(next);
            }
        }
        TuiSlashCommandAction::Archive => {
            output.conversation_change = Some(
                require_conversation_mut(conversation)?
                    .archive_and_replace(client)
                    .map_err(session_error)?,
            );
        }
        TuiSlashCommandAction::Rewind => {
            if arguments.is_empty() {
                output.events.push(
                    crate::thread::Event::RewindPickerOpened(rewind::load_selection(
                        client,
                        require_conversation(conversation)?.session_id(),
                        require_conversation(conversation)?.thread_id(),
                    )?)
                    .into(),
                );
            } else {
                let before_turn_id = TurnId::new(&arguments).map_err(|error| {
                    CommandExecutionError(format!(
                        "invalid rewind checkpoint '{arguments}': {error}"
                    ))
                })?;
                output.conversation_change = Some(
                    require_conversation_mut(conversation)?
                        .rewind_active_thread(client, before_turn_id, &arguments)
                        .map_err(session_error)?,
                );
            }
        }
        TuiSlashCommandAction::New => {
            let title = if arguments.is_empty() {
                "TUI conversation".to_owned()
            } else {
                arguments
            };
            *conversation = Some(ActiveConversation::start(client, title)?);
            output.conversation_change = Some(ConversationChange {
                notice: "Started a new session.".into(),
                transcript: crate::sessions::ConversationTranscript::Clear,
            });
        }
        TuiSlashCommandAction::AddDir => {
            if arguments.is_empty() {
                output.events.push(
                    dirs::Event::PickerOpened(dirs::load_selection(
                        client,
                        require_conversation(conversation)?.session_id(),
                    )?)
                    .into(),
                );
            } else {
                let command = format!("/add-dir {arguments}");
                let update = dirs::add(
                    client,
                    require_conversation(conversation)?.session_id(),
                    std::path::PathBuf::from(&arguments),
                )
                .map_err(CommandExecutionError)?;
                let result = if update.already_present {
                    format!("Directory already added: {arguments}")
                } else {
                    format!(
                        "Added directory {arguments} with no permissions; use /config to grant access"
                    )
                };
                output
                    .events
                    .push(crate::thread::Event::CommandStarted(command.clone()).into());
                output
                    .events
                    .push(crate::thread::Event::CommandCompleted { command, result }.into());
            }
        }
        TuiSlashCommandAction::Cd => {
            let session_id = require_conversation(conversation)?.session_id();
            let target = arguments.trim();
            if target.is_empty() {
                return Err(CommandExecutionError(
                    "/cd requires a target directory path".into(),
                ));
            }
            let expanded = if let Some(stripped) = target.strip_prefix("~/") {
                ::dirs::home_dir()
                    .map(|h| h.join(stripped))
                    .unwrap_or_else(|| PathBuf::from(target))
            } else if target == "~" {
                ::dirs::home_dir().unwrap_or_else(|| PathBuf::from(target))
            } else {
                PathBuf::from(target)
            };
            let target_path = if expanded.is_relative() {
                workspace.join(expanded)
            } else {
                expanded
            };
            let canonical = target_path.canonicalize().map_err(|error| {
                CommandExecutionError(format!(
                    "Cannot access directory {}: {error}",
                    target_path.display()
                ))
            })?;
            if !canonical.is_dir() {
                return Err(CommandExecutionError(format!(
                    "Path is not a directory: {}",
                    canonical.display()
                )));
            }
            dirs::move_session(client, session_id, canonical.clone())
                .map_err(|error| CommandExecutionError(error.to_string()))?;
            let command = format!("/cd {target}");
            let result = format!("Moved session to {}", canonical.display());
            output
                .events
                .push(crate::dirs::Event::Moved { path: canonical }.into());
            output
                .events
                .push(crate::thread::Event::CommandStarted(command.clone()).into());
            output
                .events
                .push(crate::thread::Event::CommandCompleted { command, result }.into());
        }
        TuiSlashCommandAction::Fork => {
            output.conversation_change = Some(
                require_conversation_mut(conversation)?
                    .fork_active_thread(client, &arguments)
                    .map_err(session_error)?,
            );
        }
        TuiSlashCommandAction::Config
        | TuiSlashCommandAction::Export
        | TuiSlashCommandAction::Help
        | TuiSlashCommandAction::Shortcuts
        | TuiSlashCommandAction::Startup
        | TuiSlashCommandAction::Home
        | TuiSlashCommandAction::StatusLine => {
            return Err(CommandExecutionError(
                "host command reached the App Server dispatcher".into(),
            ));
        }
        TuiSlashCommandAction::Model => {
            if arguments.is_empty() {
                output.events.push(
                    models::Event::PickerOpened(
                        models::load_selection(client)
                            .map_err(|error| CommandExecutionError(error.to_string()))?,
                    )
                    .into(),
                );
            } else {
                let update = models::set_model(client, &arguments)
                    .map_err(|error| CommandExecutionError(error.to_string()))?;
                output
                    .events
                    .push(models::Event::SummaryReceived(update.summary).into());
                output
                    .events
                    .push(crate::thread::Event::ProductNotice(update.notice).into());
            }
        }
        TuiSlashCommandAction::Theme => unreachable!("theme commands are handled locally"),
        TuiSlashCommandAction::Quit => {
            return Err(CommandExecutionError(
                "quit command reached the product dispatcher".into(),
            ));
        }
    }
    Ok(output)
}

#[derive(Default)]
struct CommandOutput {
    events: Vec<AppEvent>,
    conversation_change: Option<ConversationChange>,
}

fn text_arguments(arguments: &[ChatInputItem]) -> Result<String, CommandExecutionError> {
    if arguments.iter().any(|argument| {
        matches!(
            argument,
            ChatInputItem::Image { .. }
                | ChatInputItem::Attachment(_)
                | ChatInputItem::Context { .. }
                | ChatInputItem::Skill { .. }
                | ChatInputItem::Instruction { .. }
        )
    }) {
        return Err(CommandExecutionError(
            "product commands do not accept image arguments or Skill/Instruction selections".into(),
        ));
    }
    Ok(arguments
        .iter()
        .filter_map(|argument| match argument {
            ChatInputItem::Text(text) => Some(text.as_str()),
            ChatInputItem::Image { .. }
            | ChatInputItem::Attachment(_)
            | ChatInputItem::Context { .. }
            | ChatInputItem::Skill { .. } => None,
            ChatInputItem::Instruction { .. } => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned())
}

fn require_conversation(
    conversation: &Option<ActiveConversation>,
) -> Result<&ActiveConversation, CommandExecutionError> {
    conversation.as_ref().ok_or_else(|| {
        CommandExecutionError("Start or resume a session before using this command".into())
    })
}

fn require_conversation_mut(
    conversation: &mut Option<ActiveConversation>,
) -> Result<&mut ActiveConversation, CommandExecutionError> {
    conversation.as_mut().ok_or_else(|| {
        CommandExecutionError("Start or resume a session before using this command".into())
    })
}

fn session_error(error: impl fmt::Display) -> CommandExecutionError {
    CommandExecutionError(error.to_string())
}

#[derive(Debug)]
struct CommandExecutionError(String);

impl fmt::Display for CommandExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<ClientError> for CommandExecutionError {
    fn from(error: ClientError) -> Self {
        Self(error.to_string())
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;

use serde::Deserialize;
use serde::Serialize;

/// Whether a server-advertised slash command accepts inline composer arguments.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(
    feature = "json-schema",
    schemars(rename = "SlashCommandArgumentModeDto")
)]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[cfg_attr(feature = "export", ts(rename = "SlashCommandArgumentModeDto"))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "export", ts(rename_all = "camelCase"))]
pub enum SlashCommandArgumentMode {
    None,
    Optional,
}

/// A command definition shared by local product bindings and the server catalog.
///
/// Clients may merge these commands with local presentation commands. A submitted dynamic command
/// remains ordinary ordered Turn input; the definition only makes its slash syntax discoverable
/// and declares whether inline arguments are accepted.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "export", ts(rename_all = "camelCase"))]
pub struct SlashCommandDefinition {
    pub name: String,
    pub description: String,
    pub argument_mode: SlashCommandArgumentMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub argument_hint: Option<String>,
}

/// A command that runs the user's request with task-specific instructions and tools.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskSlashCommand {
    Ask,
    Plan,
    Debug,
    Swarm,
}

impl TaskSlashCommand {
    pub const ALL: [Self; 4] = [Self::Ask, Self::Plan, Self::Debug, Self::Swarm];

    pub fn parse(text: &str) -> Option<Self> {
        let token = text
            .trim_start()
            .strip_prefix('/')?
            .split_whitespace()
            .next()?;
        Self::from_name(token)
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|command| command.name() == name)
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Plan => "plan",
            Self::Debug => "debug",
            Self::Swarm => "swarm",
        }
    }

    pub fn definition(self) -> SlashCommandDefinition {
        let description = match self {
            Self::Ask => "Answer a question without making changes",
            Self::Plan => "Investigate and propose a plan without making changes",
            Self::Debug => "Reproduce, diagnose, and fix a problem",
            Self::Swarm => "Delegate independent work and verify the combined result",
        };
        SlashCommandDefinition {
            name: self.name().into(),
            description: description.into(),
            argument_mode: SlashCommandArgumentMode::Optional,
            argument_hint: None,
        }
    }
}

/// Shared commands that clients bind to product actions outside ordinary Turn input.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductSlashCommand {
    Extensions,
    Plugins,
    Skills,
    Lsp,
    Permission,
    Guardian,
    Btw,
}

impl ProductSlashCommand {
    pub const ALL: [Self; 7] = [
        Self::Extensions,
        Self::Plugins,
        Self::Skills,
        Self::Lsp,
        Self::Permission,
        Self::Guardian,
        Self::Btw,
    ];

    pub fn definition(self) -> SlashCommandDefinition {
        let (name, description, argument_hint) = match self {
            Self::Extensions => (
                "extensions",
                "find and install Extensions packages",
                Some("<query>"),
            ),
            Self::Plugins => (
                "plugins",
                "manage installed packages and exact versions",
                None,
            ),
            Self::Skills => ("skills", "browse and manage skills", None),
            Self::Lsp => (
                "lsp",
                "manage language servers and find packages",
                Some("<language-id>"),
            ),
            Self::Permission => (
                "permission",
                "choose permissions for the next Turn",
                Some("<manual|auto|bypassPermissions>"),
            ),
            Self::Guardian => (
                "guardian",
                "prepare and review project background for Guardian",
                Some("[setup]"),
            ),
            Self::Btw => (
                "btw",
                "Ask a side question without adding it to this conversation",
                Some("<question>"),
            ),
        };
        SlashCommandDefinition {
            name: name.into(),
            description: description.into(),
            argument_mode: match self {
                Self::Extensions | Self::Lsp | Self::Permission | Self::Guardian | Self::Btw => {
                    SlashCommandArgumentMode::Optional
                }
                Self::Plugins | Self::Skills => SlashCommandArgumentMode::None,
            },
            argument_hint: argument_hint.map(Into::into),
        }
    }
}

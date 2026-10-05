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

/// Shared management commands. Clients bind these to their own panels, outside Turn input.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductSlashCommand {
    Marketplace,
    Plugins,
    Skills,
    Lsp,
    Permission,
    Guardian,
}

impl ProductSlashCommand {
    pub const ALL: [Self; 6] = [
        Self::Marketplace,
        Self::Plugins,
        Self::Skills,
        Self::Lsp,
        Self::Permission,
        Self::Guardian,
    ];

    pub fn definition(self) -> SlashCommandDefinition {
        let (name, description, argument_hint) = match self {
            Self::Marketplace => (
                "marketplace",
                "find and install Marketplace packages",
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
        };
        SlashCommandDefinition {
            name: name.into(),
            description: description.into(),
            argument_mode: match self {
                Self::Marketplace | Self::Lsp | Self::Permission | Self::Guardian => {
                    SlashCommandArgumentMode::Optional
                }
                Self::Plugins | Self::Skills => SlashCommandArgumentMode::None,
            },
            argument_hint: argument_hint.map(Into::into),
        }
    }
}

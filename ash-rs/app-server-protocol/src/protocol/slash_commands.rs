use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Whether a server-advertised slash command accepts inline composer arguments.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum SlashCommandArgumentModeDto {
    None,
    Optional,
}

/// A command definition shared by local product bindings and the server catalog.
///
/// Clients may merge these commands with local presentation commands. A submitted dynamic command
/// remains ordinary ordered Turn input; the definition only makes its slash syntax discoverable
/// and declares whether inline arguments are accepted.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SlashCommandDefinition {
    pub name: String,
    pub description: String,
    pub argument_mode: SlashCommandArgumentModeDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
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
}

impl ProductSlashCommand {
    pub const ALL: [Self; 4] = [Self::Marketplace, Self::Plugins, Self::Skills, Self::Lsp];

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
        };
        SlashCommandDefinition {
            name: name.into(),
            description: description.into(),
            argument_mode: match self {
                Self::Marketplace | Self::Lsp => SlashCommandArgumentModeDto::Optional,
                Self::Plugins | Self::Skills => SlashCommandArgumentModeDto::None,
            },
            argument_hint: argument_hint.map(Into::into),
        }
    }
}

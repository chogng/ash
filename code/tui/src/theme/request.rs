use super::Command;
use super::Event;
use super::ThemeResource;
use super::custom_theme_choices;
use super::preference;
use super::set_preference;
use super::theme_choices;
use crate::render::RenderTheme;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;

pub(crate) enum CommandCompletion {
    Presentation(Event),
    Updated {
        command: String,
        label: String,
        theme: RenderTheme,
        result: Result<(), String>,
    },
}

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::OpenPicker => "ash-tui-open-theme",
            Self::OpenCustomPicker => "ash-tui-open-custom-theme",
            Self::SetCustom { .. } | Self::Set { .. } => "ash-tui-set-theme",
        }
    }

    pub(crate) fn command_line(&self) -> Option<String> {
        match self {
            Self::OpenPicker | Self::OpenCustomPicker => None,
            Self::SetCustom { preference } | Self::Set { preference } => {
                Some(format!("/theme {preference}"))
            }
        }
    }
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    resource: &ThemeResource,
    command: Command,
) -> Result<CommandCompletion, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::OpenPicker => open_picker(client, resource, false),
        Command::OpenCustomPicker => open_picker(client, resource, true),
        Command::SetCustom { preference } | Command::Set { preference } => {
            let command = format!("/theme {preference}");
            let selection = resource.resolve(&preference)?;
            Ok(CommandCompletion::Updated {
                command,
                label: selection.label,
                theme: selection.theme,
                result: set_preference(client, preference).map_err(|error| error.to_string()),
            })
        }
    }
}

fn open_picker<T>(
    client: &mut AppServerClient<T>,
    resource: &ThemeResource,
    custom: bool,
) -> Result<CommandCompletion, String>
where
    T: JsonRpcTransport,
{
    let config = client.read_config().map_err(|error| error.to_string())?;
    let catalog = resource.catalog(preference(&config))?;
    let choices = if custom {
        custom_theme_choices(&catalog)
    } else {
        theme_choices(&catalog)
    };
    Ok(CommandCompletion::Presentation(Event::PickerOpened(
        choices,
    )))
}

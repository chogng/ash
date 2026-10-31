//! Activation-scoped UI for the broker's policy. Configuration remains in the host;
//! the broker alone owns the effective mode and temporary suspension.
use crate::auto_attach::Environment;
use crate::auto_attach::Mode;
use crate::auto_attach::Suspension;
use crate::invalid;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::Command;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::client::Client;
use external_ext_sdk::client::ConfigurationTarget;
use external_ext_sdk::client::QuickPickItem;
use external_ext_sdk::window::StatusBar;
use external_ext_sdk::window::StatusBarAlignment;
use external_ext_sdk::window::StatusBarCommand;
use external_ext_sdk::window::StatusBarEntry;
use external_ext_sdk::workspace::WorkspaceEvent;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Mutex;

const TOGGLE_COMMAND: &str = "ash.debug-javascript.toggleAutoAttach";
const SETTING: &str = "debug.javascript.autoAttachFilter";
const MODES: [Mode; 4] = [
    Mode::Always,
    Mode::Smart,
    Mode::OnlyWithFlag,
    Mode::Disabled,
];

#[derive(Deserialize)]
struct Messages {
    #[serde(rename = "command.toggleAutoAttach")]
    command: String,
    #[serde(rename = "autoAttach.always")]
    always: String,
    #[serde(rename = "autoAttach.smart")]
    smart: String,
    #[serde(rename = "autoAttach.onlyWithFlag")]
    only_with_flag: String,
    #[serde(rename = "autoAttach.disabled")]
    disabled: String,
    #[serde(rename = "autoAttach.alwaysDetail")]
    always_detail: String,
    #[serde(rename = "autoAttach.smartDetail")]
    smart_detail: String,
    #[serde(rename = "autoAttach.onlyWithFlagDetail")]
    only_with_flag_detail: String,
    #[serde(rename = "autoAttach.disabledDetail")]
    disabled_detail: String,
    #[serde(rename = "autoAttach.current")]
    current: String,
    #[serde(rename = "autoAttach.picker")]
    picker: String,
    #[serde(rename = "autoAttach.user")]
    user: String,
    #[serde(rename = "autoAttach.workspace")]
    workspace: String,
    #[serde(rename = "autoAttach.useUser")]
    use_user: String,
    #[serde(rename = "autoAttach.useWorkspace")]
    use_workspace: String,
    #[serde(rename = "autoAttach.pause")]
    pause: String,
    #[serde(rename = "autoAttach.resume")]
    resume: String,
    #[serde(rename = "autoAttach.temporaryDetail")]
    temporary_detail: String,
    #[serde(rename = "autoAttach.status")]
    status: String,
    #[serde(rename = "autoAttach.paused")]
    paused: String,
    #[serde(rename = "autoAttach.tooltip")]
    tooltip: String,
    #[serde(rename = "autoAttach.pausedTooltip")]
    paused_tooltip: String,
    #[serde(rename = "error.configuration")]
    error: String,
}

pub(super) fn register(
    context: &mut ExtensionContext,
    environment: Environment,
    messages: &Value,
) -> Result<(), ExtensionError> {
    let messages: Messages = serde_json::from_value(messages.clone())
        .map_err(|_| invalid("Invalid product messages"))?;
    let controls = Arc::new(Controls {
        environment,
        client: context.client.clone(),
        status: context
            .window
            .create_status_bar("javascript.auto-attach.status")?,
        messages,
        updates: Mutex::new(()),
    });
    let command = Arc::clone(&controls);
    context.commands.register_command(
        Command::new(TOGGLE_COMMAND, controls.messages.command.clone()),
        move |_, token| {
            command.select(&token)?;
            Ok(Value::Null)
        },
    )?;
    let observer = Arc::clone(&controls);
    context
        .workspace
        .observe("javascript.workspace".into(), move |event, token| {
            match event {
                WorkspaceEvent::Workspace { workspace_folders } => {
                    observer.environment.workspace(
                        workspace_folders
                            .into_iter()
                            .map(|folder| folder.uri)
                            .collect(),
                    )?;
                }
                WorkspaceEvent::Configuration {} => {
                    observer.refresh(&token)?;
                }
            }
            Ok(())
        })?;
    context
        .terminal
        .register_environment("javascript.auto-attach", move |token| {
            controls.refresh(&token)
        })?;
    Ok(())
}

struct Controls {
    environment: Environment,
    client: Client,
    status: StatusBar,
    messages: Messages,
    // Keep state changes and their status projection ordered across concurrent SDK callbacks.
    updates: Mutex<()>,
}

impl Controls {
    fn refresh(&self, token: &CancellationToken) -> Result<Value, ExtensionError> {
        let _update = self
            .updates
            .lock()
            .map_err(|_| invalid(&self.messages.error))?;
        let settings = self
            .client
            .get_configuration("debug.javascript", None, token)?;
        let collection = self.environment.collection(&settings);
        // Invalid settings fail closed in the broker and must also retire the old status.
        self.publish_status()?;
        collection
    }

    fn select(&self, token: &CancellationToken) -> Result<(), ExtensionError> {
        self.refresh(token)?;
        let inspected = self.client.inspect_configuration(SETTING, None, token)?;
        let mut target = if inspected
            .get("workspaceValue")
            .is_some_and(|value| !value.is_null())
        {
            ConfigurationTarget::Workspace
        } else {
            ConfigurationTarget::User
        };
        loop {
            let (mode, suspension) = self.environment.state()?;
            let mut items: Vec<QuickPickItem> = MODES
                .iter()
                .map(|&choice| QuickPickItem {
                    label: self.label(choice).into(),
                    description: (choice == mode).then(|| self.messages.current.clone()),
                    detail: Some(self.detail(choice).into()),
                    ..Default::default()
                })
                .collect();
            let temporary = (mode != Mode::Disabled).then_some(items.len());
            if temporary.is_some() {
                items.push(QuickPickItem {
                    label: match suspension {
                        Suspension::Active => self.messages.pause.clone(),
                        Suspension::Paused => self.messages.resume.clone(),
                    },
                    description: None,
                    detail: Some(self.messages.temporary_detail.clone()),
                    ..Default::default()
                });
            }
            let scope = items.len();
            items.push(QuickPickItem {
                label: match target {
                    ConfigurationTarget::User => self.messages.use_workspace.clone(),
                    ConfigurationTarget::Workspace => self.messages.use_user.clone(),
                },
                description: None,
                detail: None,
                ..Default::default()
            });
            let placeholder = self.messages.picker.replace(
                "{0}",
                match target {
                    ConfigurationTarget::User => &self.messages.user,
                    ConfigurationTarget::Workspace => &self.messages.workspace,
                },
            );
            let Some(index) = self
                .client
                .show_quick_pick_items(items, placeholder, token)?
            else {
                return Ok(());
            };
            if index == scope {
                target = match target {
                    ConfigurationTarget::User => ConfigurationTarget::Workspace,
                    ConfigurationTarget::Workspace => ConfigurationTarget::User,
                };
                continue;
            }
            if Some(index) == temporary {
                let _update = self
                    .updates
                    .lock()
                    .map_err(|_| invalid(&self.messages.error))?;
                self.environment.suspend(match suspension {
                    Suspension::Active => Suspension::Paused,
                    Suspension::Paused => Suspension::Active,
                })?;
                return self.publish_status();
            }
            self.client.update_configuration(
                SETTING,
                Value::from(MODES[index].setting()),
                target,
                token,
            )?;
            self.refresh(token)?;
            let _update = self
                .updates
                .lock()
                .map_err(|_| invalid(&self.messages.error))?;
            // Choosing the current mode is also an explicit request to leave a temporary pause.
            self.environment.suspend(Suspension::Active)?;
            return self.publish_status();
        }
    }

    fn publish_status(&self) -> Result<(), ExtensionError> {
        let (mode, suspension) = self.environment.state()?;
        if mode == Mode::Disabled {
            return self.status.set_entries(Vec::new());
        }
        let (label, tooltip) = match suspension {
            Suspension::Active => (self.label(mode), self.messages.tooltip.clone()),
            Suspension::Paused => (
                self.messages.paused.as_str(),
                self.messages
                    .paused_tooltip
                    .replace("{0}", self.label(mode)),
            ),
        };
        let text = self.messages.status.replace("{0}", label);
        self.status.set_entries(vec![StatusBarEntry {
            id: "javascript.auto-attach".into(),
            aria_label: Some(format!("{text}. {tooltip}")),
            text,
            tooltip: Some(tooltip),
            alignment: StatusBarAlignment::Left,
            priority: 90.into(),
            command: Some(StatusBarCommand {
                command: TOGGLE_COMMAND.into(),
                arguments: Vec::new(),
            }),
        }])
    }

    fn label(&self, mode: Mode) -> &str {
        match mode {
            Mode::Always => &self.messages.always,
            Mode::Smart => &self.messages.smart,
            Mode::OnlyWithFlag => &self.messages.only_with_flag,
            Mode::Disabled => &self.messages.disabled,
        }
    }

    fn detail(&self, mode: Mode) -> &str {
        match mode {
            Mode::Always => &self.messages.always_detail,
            Mode::Smart => &self.messages.smart_detail,
            Mode::OnlyWithFlag => &self.messages.only_with_flag_detail,
            Mode::Disabled => &self.messages.disabled_detail,
        }
    }
}

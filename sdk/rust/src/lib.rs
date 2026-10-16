//! Author-facing Rust API for standalone Ash editor extensions.
//!
//! The SDK speaks the same versioned protocol as the host, but does not link the host or App Server.
//! Commands and providers register during activation; the host publishes their complete set atomically.
//! Editor documents are immutable snapshots, not a second owner of the editor's working copy.

use std::collections::BTreeMap;
use std::sync::Arc;

use external_ext_protocol::ActivateParams;
use external_ext_protocol::ActivateResult;
use external_ext_protocol::HostFailure;
use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde::Deserialize;
use serde_json::Value;

mod cancellation;
pub mod client;
pub mod data_channels;
pub mod debug;
pub mod editors;
pub mod languages;
mod runtime;
pub mod scm;
pub mod services;
pub mod terminal;
pub mod window;
pub mod workspace;

pub use cancellation::CancellationToken;
pub use external_ext_protocol::CancelReason;
pub use external_ext_protocol::ExtensionCommandMenu as CommandMenu;
pub use external_ext_protocol::HostErrorCode;
pub use external_ext_protocol::ProtocolLimits;
pub use runtime::RuntimeError;
pub use runtime::RuntimeOptions;
pub use runtime::run_stdio;
pub use runtime::run_stdio_with_options;
pub use serde_json::Value as JsonValue;

/// A callback failure sent to the host as a typed outcome, without terminating the extension.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct ExtensionError {
    pub code: HostErrorCode,
    pub message: String,
}

impl ExtensionError {
    pub fn new(code: HostErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn invalid_request(message: &str) -> Self {
        Self::new(HostErrorCode::InvalidRequest, message)
    }
}

impl From<ExtensionError> for HostFailure {
    fn from(error: ExtensionError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

/// One extension entry point. Activation installs callbacks; deactivation releases extension-owned work.
///
/// Invocation callbacks run concurrently. Capture shared state through thread-safe Rust values.
/// The SDK cancels and joins outstanding callbacks before calling `deactivate`.
pub trait Extension {
    fn id(&self) -> &str;
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError>;
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        Ok(())
    }
}

/// Command declaration. Its title is mandatory because the host publishes it to the command palette.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Command {
    pub id: String,
    pub title: String,
    pub category: Option<String>,
    pub enablement: Option<String>,
    pub icon: Option<String>,
    pub menus: Vec<external_ext_protocol::ExtensionCommandMenu>,
}

impl Command {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            category: None,
            enablement: None,
            icon: None,
            menus: Vec::new(),
        }
    }
}

/// Invocation arguments and the originating editor context, when the frontend supplied one.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandInvocation {
    pub arguments: Vec<Value>,
    pub active_editor: Option<Value>,
}

type Handler = Arc<dyn Fn(Value, CancellationToken) -> Result<Value, ExtensionError> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Registration {
    pub descriptor: RegistrationDescriptor,
    pub handlers: BTreeMap<String, Handler>,
}

impl Registration {
    fn new(descriptor: RegistrationDescriptor, operation: &str, handler: Handler) -> Self {
        Self {
            descriptor,
            handlers: BTreeMap::from([(operation.into(), handler)]),
        }
    }
}

/// Commands registered for the current activation. Registration IDs equal command IDs.
#[derive(Default)]
pub struct Commands {
    registrations: BTreeMap<String, Registration>,
}

impl Commands {
    pub fn register_command(
        &mut self,
        command: Command,
        callback: impl Fn(CommandInvocation, CancellationToken) -> Result<Value, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let id = command.id.clone();
        let descriptor = RegistrationDescriptor {
            registration_id: id.clone(),
            kind: RegistrationKind::Command {
                command: command.id,
                title: command.title,
                category: command.category,
                enablement: command.enablement,
                icon: command.icon,
                menus: command.menus,
            },
        };
        let handler: Handler = Arc::new(move |payload, token| {
            let invocation = serde_json::from_value(payload)
                .map_err(|_| ExtensionError::invalid_request("invalid command invocation"))?;
            callback(invocation, token)
        });
        match self.registrations.entry(id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Registration::new(descriptor, "execute", handler));
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "command is already registered",
            )),
        }
    }
}

/// SDK-owned activation scope, corresponding to VS Code's extension context and API namespaces.
///
/// Registrations and Output channels are owned by this scope and released together on deactivation.
/// v1 does not permit changing the registration set after activation has been published.
pub struct ExtensionContext {
    pub client: client::Client,
    pub services: services::Services,
    pub data_channels: data_channels::DataChannels,
    pub commands: Commands,
    pub debug: debug::Debug,
    pub scm: scm::SourceControl,
    pub terminal: terminal::Terminal,
    pub languages: languages::Languages,
    pub editors: editors::Editors,
    pub window: window::Window,
    pub workspace: workspace::Workspace,
    activation: ActivateParams,
    environment: BTreeMap<String, Option<String>>,
}

impl ExtensionContext {
    /// Immutable activation facts supplied by the bound client. Live editor state is read
    /// through Client; extensions must not treat this snapshot as a document owner.
    pub fn initialization(&self) -> Option<&external_ext_protocol::ExtensionHostInitialization> {
        self.activation.initialization.as_ref()
    }

    /// Product configuration delivered after the runtime process has started.
    pub fn environment(&self) -> &BTreeMap<String, Option<String>> {
        &self.environment
    }

    pub fn extension_id(&self) -> &str {
        &self.activation.extension_id
    }

    pub fn package_id(&self) -> &str {
        &self.activation.package.package_id
    }

    pub(crate) fn registrations(&self) -> Result<BTreeMap<String, Registration>, ExtensionError> {
        let mut registrations = self.commands.registrations.clone();
        for (id, registration) in self
            .languages
            .registrations
            .iter()
            .chain(self.data_channels.registrations.iter())
            .chain(self.debug.registrations.iter())
            .chain(self.workspace.registrations.iter())
            .chain(self.scm.registrations.iter())
            .chain(self.terminal.registrations.iter())
            .chain(self.editors.registrations.iter())
            .chain(self.window.registrations.iter())
        {
            if registrations
                .insert(id.clone(), registration.clone())
                .is_some()
            {
                return Err(ExtensionError::new(
                    HostErrorCode::ActivationFailed,
                    "registration IDs must be unique",
                ));
            }
        }
        Ok(registrations)
    }

    pub(crate) fn result(registrations: &BTreeMap<String, Registration>) -> ActivateResult {
        ActivateResult {
            registrations: registrations
                .values()
                .map(|registration| registration.descriptor.clone())
                .collect(),
        }
    }
}

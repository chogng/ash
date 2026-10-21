//! Debugger providers supply configuration and adapter descriptors. The client
//! retains DAP sessions, breakpoints, execution control and console output.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::Handler;
use crate::HostErrorCode;
use crate::Registration;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Request {
    Launch,
    Attach,
}

/// Launch data is an invocation snapshot, never a second owner of a DAP session.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Configuration {
    pub name: String,
    #[serde(rename = "type")]
    pub debugger_type: String,
    pub request: Request,
    #[serde(flatten)]
    pub properties: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceFolder {
    pub uri: String,
    pub name: String,
    pub index: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationRequest {
    pub folder: Option<WorkspaceFolder>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveConfigurationRequest {
    pub folder: Option<WorkspaceFolder>,
    pub configuration: Configuration,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub workspace_folder: Option<WorkspaceFolder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterRequest {
    pub configuration: Configuration,
    pub session: Session,
    pub executable: Option<Executable>,
    pub dir_id: Option<String>,
}

/// The host authorizes and starts this executable; the extension never starts it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Executable {
    pub program: String,
    pub arguments: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, Option<String>>>,
}

/// An adapter listener owned by the provider. The Debug domain owns each connection.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Connection {
    Server { host: String, port: u16 },
    NamedPipe { path: String },
}

/// Complete immutable snapshot passed to a tracker factory.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackerSession {
    pub id: String,
    #[serde(rename = "type")]
    pub debugger_type: String,
    pub name: String,
    pub parent_session_id: Option<String>,
    pub configuration: Configuration,
    pub workspace_folder: Option<WorkspaceFolder>,
}

/// Tracker callbacks observe traffic; they do not own DAP sequencing or execution.
#[derive(Debug, Deserialize)]
#[serde(tag = "event", deny_unknown_fields)]
pub enum TrackerEvent {
    #[serde(rename = "onWillStartSession")]
    Start,
    #[serde(rename = "onWillReceiveMessage")]
    Receive { message: Value },
    #[serde(rename = "onDidSendMessage")]
    Send { message: Value },
    #[serde(rename = "onWillStopSession")]
    Stop,
    #[serde(rename = "onError")]
    Error { message: String, name: String },
    #[serde(rename = "onExit")]
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
    #[serde(rename = "dispose")]
    Dispose,
}

/// One session-scoped observer. Dispose is delivered at most once per handle.
pub trait AdapterTracker: Send + Sync + 'static {
    fn event(&self, event: TrackerEvent, token: CancellationToken) -> Result<(), ExtensionError>;
}

#[derive(Clone, Copy)]
pub enum ConfigurationProviderTriggerKind {
    Initial = 1,
    Dynamic = 2,
}

/// Configuration hooks execute in the client's established resolution order.
/// Returning None aborts launch; cancellation uses the invocation's token.
pub trait ConfigurationProvider: Send + Sync + 'static {
    fn provide_configurations(
        &self,
        request: ConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Vec<Configuration>, ExtensionError>;

    fn resolve_configuration(
        &self,
        request: ResolveConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Option<Configuration>, ExtensionError> {
        token.check_cancelled()?;
        Ok(Some(request.configuration))
    }

    fn resolve_configuration_with_substituted_variables(
        &self,
        request: ResolveConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Option<Configuration>, ExtensionError> {
        token.check_cancelled()?;
        Ok(Some(request.configuration))
    }
}

#[derive(Default)]
pub struct Debug {
    pub(crate) registrations: BTreeMap<String, Registration>,
}

impl Debug {
    /// Observes existing Debug events in the activation's bound client.
    pub fn observe_events(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(Value, CancellationToken) -> Result<(), ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let handler: Handler = Arc::new(move |payload, token| {
            callback(payload, token)?;
            Ok(Value::Null)
        });
        self.insert(
            id.into(),
            RegistrationKind::DebugEvents {},
            BTreeMap::from([("debugEvent".into(), handler)]),
        )
    }
    pub fn register_connection_factory(
        &mut self,
        id: impl Into<String>,
        debugger_type: impl Into<String>,
        callback: impl Fn(AdapterRequest, CancellationToken) -> Result<Connection, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let handler: Handler = Arc::new(move |payload, token| {
            Ok(json!({ "connection": callback(decode(payload)?, token)? }))
        });
        self.insert(
            id.into(),
            RegistrationKind::DebugAdapter {
                debugger_type: debugger_type.into(),
            },
            BTreeMap::from([("createDebugAdapterDescriptor".into(), handler)]),
        )
    }

    pub fn register_tracker_factory(
        &mut self,
        id: impl Into<String>,
        debugger_type: impl Into<String>,
        callback: impl Fn(
            TrackerSession,
            CancellationToken,
        ) -> Result<Option<Arc<dyn AdapterTracker>>, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Create {
            session: TrackerSession,
        }
        #[derive(Deserialize)]
        struct Event {
            #[serde(rename = "trackerId")]
            id: String,
            #[serde(flatten)]
            event: TrackerEvent,
        }
        let trackers = Arc::new(Mutex::new((
            0u64,
            BTreeMap::<String, Arc<dyn AdapterTracker>>::new(),
        )));
        let create = Arc::clone(&trackers);
        let factory: Handler = Arc::new(move |payload, token| {
            let request: Create = decode(payload)?;
            token.check_cancelled()?;
            let Some(tracker) = callback(request.session, token.clone())? else {
                return Ok(Value::Null);
            };
            token.check_cancelled()?;
            let mut state = create
                .lock()
                .map_err(|_| ExtensionError::invalid_request("debug tracker lock failed"))?;
            if state.1.len() >= 256 {
                return Err(ExtensionError::new(
                    HostErrorCode::QuotaExceeded,
                    "too many debug trackers",
                ));
            }
            state.0 += 1;
            let id = state.0.to_string();
            state.1.insert(id.clone(), tracker);
            Ok(
                json!({"trackerId":id,"operations":["onWillStartSession","onWillReceiveMessage","onDidSendMessage","onWillStopSession","onError","onExit"]}),
            )
        });
        let events: Handler = Arc::new(move |payload, token| {
            let event: Event = decode(payload)?;
            let tracker = {
                let mut state = trackers
                    .lock()
                    .map_err(|_| ExtensionError::invalid_request("debug tracker lock failed"))?;
                if matches!(event.event, TrackerEvent::Dispose) {
                    state.1.remove(&event.id)
                } else {
                    state.1.get(&event.id).cloned()
                }
            };
            if let Some(tracker) = tracker {
                tracker.event(event.event, token)?;
            }
            Ok(Value::Null)
        });
        self.insert(
            id.into(),
            RegistrationKind::DebugAdapterTracker {
                debugger_type: debugger_type.into(),
            },
            BTreeMap::from([
                ("createDebugAdapterTracker".into(), factory),
                ("debugAdapterTrackerEvent".into(), events),
            ]),
        )
    }
    pub fn register_configuration_provider(
        &mut self,
        id: impl Into<String>,
        debugger_type: impl Into<String>,
        trigger: ConfigurationProviderTriggerKind,
        provider: impl ConfigurationProvider,
    ) -> Result<(), ExtensionError> {
        let provider = Arc::new(provider);
        let mut handlers: BTreeMap<String, Handler> = BTreeMap::new();
        let templates = Arc::clone(&provider);
        handlers.insert(
            "provideDebugConfigurations".into(),
            Arc::new(move |payload, token| {
                let request = decode(payload)?;
                Ok(json!({ "configurations": templates.provide_configurations(request, token)? }))
            }),
        );
        let resolve = Arc::clone(&provider);
        handlers.insert("resolveDebugConfiguration".into(), Arc::new(move |payload, token| {
            Ok(json!({ "configuration": resolve.resolve_configuration(decode(payload)?, token)? }))
        }));
        handlers.insert("resolveDebugConfigurationWithSubstitutedVariables".into(), Arc::new(move |payload, token| {
            Ok(json!({ "configuration": provider.resolve_configuration_with_substituted_variables(decode(payload)?, token)? }))
        }));
        self.insert(
            id.into(),
            RegistrationKind::DebugConfigurationProvider {
                debugger_type: debugger_type.into(),
                trigger_kind: trigger as u8,
            },
            handlers,
        )
    }

    pub fn register_adapter_factory(
        &mut self,
        id: impl Into<String>,
        debugger_type: impl Into<String>,
        callback: impl Fn(
            AdapterRequest,
            CancellationToken,
        ) -> Result<Option<Executable>, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let handler: Handler = Arc::new(move |payload, token| {
            serde_json::to_value(callback(decode(payload)?, token)?).map_err(|_| {
                ExtensionError::new(HostErrorCode::Internal, "invalid debug adapter descriptor")
            })
        });
        self.insert(
            id.into(),
            RegistrationKind::DebugAdapter {
                debugger_type: debugger_type.into(),
            },
            BTreeMap::from([("createDebugAdapterDescriptor".into(), handler)]),
        )
    }

    fn insert(
        &mut self,
        id: String,
        kind: RegistrationKind,
        handlers: BTreeMap<String, Handler>,
    ) -> Result<(), ExtensionError> {
        match self.registrations.entry(id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Registration {
                    descriptor: RegistrationDescriptor {
                        registration_id: id,
                        kind,
                    },
                    handlers,
                });
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "debug provider is already registered",
            )),
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T, ExtensionError> {
    serde_json::from_value(payload)
        .map_err(|_| ExtensionError::invalid_request("invalid debug provider request"))
}

#[cfg(test)]
#[path = "debug_tests.rs"]
mod tests;

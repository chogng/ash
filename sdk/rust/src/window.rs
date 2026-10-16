use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use external_ext_protocol::ExtensionHostOutputEvent;
use external_ext_protocol::HostEventContext;
use external_ext_protocol::HostOutputChannelKind;
use external_ext_protocol::HostOutputOperation;
use external_ext_protocol::HostOutputSeverity;
use external_ext_protocol::ProtocolLimits;

use crate::ExtensionError;
use crate::HostErrorCode;
use crate::Registration;
use crate::runtime::Writer;
use crate::services::Services;

pub use external_ext_protocol::ExtensionStatusBarAlignment as StatusBarAlignment;
pub use external_ext_protocol::ExtensionStatusBarCommand as StatusBarCommand;
pub use external_ext_protocol::ExtensionStatusBarEntry as StatusBarEntry;

/// Frontend Output and status access for one activation, without exposing Workbench objects.
pub struct Window {
    pub(crate) registrations: BTreeMap<String, Registration>,
    writer: Writer,
    context: HostEventContext,
    limits: ProtocolLimits,
    services: Services,
    channels: BTreeMap<String, OutputChannel>,
    status_bars: Vec<StatusBar>,
}

impl Window {
    pub(crate) fn new(
        writer: Writer,
        context: HostEventContext,
        limits: ProtocolLimits,
        services: Services,
    ) -> Self {
        Self {
            registrations: BTreeMap::new(),
            writer,
            context,
            limits,
            services,
            channels: BTreeMap::new(),
            status_bars: Vec::new(),
        }
    }

    /// Registers one activation-owned set of entries; the bound client owns its UI.
    /// Updates may outlive a foreground callback, but never this activation.
    pub fn create_status_bar(
        &mut self,
        id: impl Into<String>,
    ) -> Result<StatusBar, ExtensionError> {
        let id = id.into();
        if self.registrations.contains_key(&id) {
            return Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "status bar is already registered",
            ));
        }
        self.registrations.insert(
            id.clone(),
            Registration {
                descriptor: external_ext_protocol::RegistrationDescriptor {
                    registration_id: id.clone(),
                    kind: external_ext_protocol::RegistrationKind::StatusBar {
                        revision: 1,
                        entries: Vec::new(),
                    },
                },
                handlers: BTreeMap::new(),
            },
        );
        let status_bar = StatusBar {
            id,
            services: self.services.clone(),
            context: self.context,
            limits: self.limits,
            state: Arc::new(Mutex::new(StatusBarState {
                revision: 1,
                disposed: false,
            })),
        };
        self.status_bars.push(status_bar.clone());
        Ok(status_bar)
    }

    pub fn create_output_channel(
        &mut self,
        id: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<OutputChannel, ExtensionError> {
        let id = id.into();
        if self.channels.contains_key(&id)
            || self.channels.len() >= self.limits.maximum_registrations
        {
            return Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "Output channel identity is duplicated or its limit is exceeded",
            ));
        }
        let channel = OutputChannel {
            id: id.clone(),
            writer: self.writer.clone(),
            context: self.context,
            limits: self.limits,
            disposed: Arc::new(Mutex::new(false)),
        };
        channel.send(HostOutputOperation::Create {
            channel_id: id.clone(),
            label: name.into(),
            kind: HostOutputChannelKind::Output,
        })?;
        self.channels.insert(id, channel.clone());
        Ok(channel)
    }

    pub(crate) fn dispose(&mut self) -> Result<(), ExtensionError> {
        for status_bar in &self.status_bars {
            status_bar
                .state
                .lock()
                .expect("status bar state is not poisoned")
                .disposed = true;
        }
        self.status_bars.clear();
        let mut outcome = Ok(());
        for channel in self.channels.values() {
            outcome = outcome.and(channel.dispose());
        }
        self.channels.clear();
        outcome
    }
}

struct StatusBarState {
    revision: u64,
    disposed: bool,
}

/// Cloneable, activation-fenced status values. Host retirement removes the entries.
#[derive(Clone)]
pub struct StatusBar {
    id: String,
    services: Services,
    context: HostEventContext,
    limits: ProtocolLimits,
    state: Arc<Mutex<StatusBarState>>,
}

impl StatusBar {
    pub fn set_entries(&self, entries: Vec<StatusBarEntry>) -> Result<(), ExtensionError> {
        // Serialize revisions and delivery so a slow older update cannot replace a newer one.
        let mut state = self.state.lock().expect("status bar state is not poisoned");
        if state.disposed {
            return Err(ExtensionError::invalid_request(
                "status bar has been disposed",
            ));
        }
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| ExtensionError::invalid_request("status bar revision exhausted"))?;
        let request = external_ext_protocol::ExtensionBackgroundClientRequest {
            context: self.context,
            call_id: 1,
            operation: external_ext_protocol::ExtensionClientOperation::SetStatusBarEntries {
                registration_id: self.id.clone(),
                revision: state.revision,
                entries,
            },
        };
        request
            .validate(&self.limits)
            .map_err(|_| ExtensionError::invalid_request("invalid status bar entries"))?;
        match self.services.call_operation(request.operation)? {
            external_ext_protocol::ExtensionClientResult::Done => Ok(()),
            _ => Err(ExtensionError::new(
                HostErrorCode::Internal,
                "invalid status bar response",
            )),
        }
    }
}

/// Cloneable handle to an extension-owned Output channel; the activation scope owns its lifetime.
#[derive(Clone)]
pub struct OutputChannel {
    id: String,
    writer: Writer,
    context: HostEventContext,
    limits: ProtocolLimits,
    disposed: Arc<Mutex<bool>>,
}

impl OutputChannel {
    pub fn append(&self, text: impl Into<String>) -> Result<(), ExtensionError> {
        self.send(HostOutputOperation::Append {
            channel_id: self.id.clone(),
            text: text.into(),
            severity: HostOutputSeverity::Information,
            category: None,
        })
    }

    pub fn append_line(&self, text: impl Into<String>) -> Result<(), ExtensionError> {
        self.append(format!("{}\n", text.into()))
    }

    pub fn clear(&self) -> Result<(), ExtensionError> {
        self.send(HostOutputOperation::Clear {
            channel_id: self.id.clone(),
        })
    }

    pub fn show(&self) -> Result<(), ExtensionError> {
        self.send(HostOutputOperation::Show {
            channel_id: self.id.clone(),
            preserve_focus: false,
        })
    }

    pub fn show_preserving_focus(&self) -> Result<(), ExtensionError> {
        self.send(HostOutputOperation::Show {
            channel_id: self.id.clone(),
            preserve_focus: true,
        })
    }

    pub fn dispose(&self) -> Result<(), ExtensionError> {
        let mut disposed = self
            .disposed
            .lock()
            .expect("Output channel state is not poisoned");
        if !*disposed {
            *disposed = true;
            self.emit(HostOutputOperation::Dispose {
                channel_id: self.id.clone(),
            })?;
        }
        Ok(())
    }

    fn send(&self, operation: HostOutputOperation) -> Result<(), ExtensionError> {
        // Keep this guard through the write: disposal must never overtake an accepted append.
        let disposed = self
            .disposed
            .lock()
            .expect("Output channel state is not poisoned");
        if *disposed {
            return Err(ExtensionError::new(
                HostErrorCode::InvalidRequest,
                "Output channel has been disposed",
            ));
        }
        self.emit(operation)
    }

    fn emit(&self, operation: HostOutputOperation) -> Result<(), ExtensionError> {
        let event = ExtensionHostOutputEvent {
            context: self.context,
            operation,
        };
        event
            .validate(&self.limits)
            .map_err(|_| ExtensionError::invalid_request("invalid Output event"))?;
        self.writer
            .write(&event)
            .map_err(|_| ExtensionError::new(HostErrorCode::Internal, "Output transport failed"))
    }
}

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
use crate::runtime::Writer;

/// Frontend Output access for one activation. This does not expose Workbench objects to the process.
pub struct Window {
    writer: Writer,
    context: HostEventContext,
    limits: ProtocolLimits,
    channels: BTreeMap<String, OutputChannel>,
}

impl Window {
    pub(crate) fn new(writer: Writer, context: HostEventContext, limits: ProtocolLimits) -> Self {
        Self {
            writer,
            context,
            limits,
            channels: BTreeMap::new(),
        }
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
        let mut outcome = Ok(());
        for channel in self.channels.values() {
            outcome = outcome.and(channel.dispose());
        }
        self.channels.clear();
        outcome
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

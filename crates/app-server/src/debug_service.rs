use std::collections::HashMap;
use std::sync::Mutex;

use ash_debug_adapter::DebugAdapterCommand;
use ash_debug_adapter::DebugAdapterError;
use ash_debug_adapter::DebugAdapterRead;
use ash_debug_adapter::DebugAdapterService as Runtime;
use ash_debug_adapter::DebugAdapterSessionId;
use ash_file_access::Authorization;
use serde_json::Value;

/// Adds App Server connection ownership to the backend-neutral DAP runtime.
pub(crate) struct DebugAdapterService {
    runtime: Runtime,
    owners: Mutex<HashMap<DebugAdapterSessionId, u64>>,
}

impl DebugAdapterService {
    pub(crate) fn new(
        executable_configuration: Authorization,
        process_execution: Authorization,
        environment: HashMap<String, String>,
    ) -> Result<Self, DebugAdapterError> {
        Ok(Self {
            runtime: Runtime::new(executable_configuration, process_execution, environment)?,
            owners: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn start(
        &self,
        owner_connection_id: u64,
        command: DebugAdapterCommand,
    ) -> Result<String, DebugAdapterError> {
        let session_id = self.runtime.start(command)?;
        let mut owners = match self.owners.lock() {
            Ok(owners) => owners,
            Err(_) => {
                let _ = self.runtime.close(&session_id);
                return Err(DebugAdapterError::Busy);
            }
        };
        owners.insert(session_id.clone(), owner_connection_id);
        Ok(session_id.as_str().to_owned())
    }

    pub(crate) fn send(
        &self,
        owner_connection_id: u64,
        session_id: &str,
        message: &Value,
    ) -> Result<(), DebugAdapterServiceError> {
        let session_id = self.owned_session(owner_connection_id, session_id)?;
        self.runtime
            .send(&session_id, message)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn read(
        &self,
        owner_connection_id: u64,
        session_id: &str,
        after_sequence: u64,
        max_messages: usize,
    ) -> Result<DebugAdapterRead, DebugAdapterServiceError> {
        let session_id = self.owned_session(owner_connection_id, session_id)?;
        self.runtime
            .read(&session_id, after_sequence, max_messages)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn close(
        &self,
        owner_connection_id: u64,
        session_id: &str,
    ) -> Result<(), DebugAdapterServiceError> {
        let session_id = self.owned_session(owner_connection_id, session_id)?;
        self.owners
            .lock()
            .map_err(|_| DebugAdapterServiceError::Runtime(DebugAdapterError::Busy))?
            .remove(&session_id);
        self.runtime
            .close(&session_id)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn close_owner(&self, owner_connection_id: u64) {
        let sessions = {
            let Ok(mut owners) = self.owners.lock() else {
                return;
            };
            let sessions = owners
                .iter()
                .filter_map(|(session_id, owner)| {
                    (*owner == owner_connection_id).then_some(session_id.clone())
                })
                .collect::<Vec<_>>();
            for session_id in &sessions {
                owners.remove(session_id);
            }
            sessions
        };
        for session_id in sessions {
            let _ = self.runtime.close(&session_id);
        }
    }

    pub(crate) fn terminate_all(&self) {
        if let Ok(mut owners) = self.owners.lock() {
            owners.clear();
        }
        self.runtime.terminate_all();
    }

    fn owned_session(
        &self,
        owner_connection_id: u64,
        session_id: &str,
    ) -> Result<DebugAdapterSessionId, DebugAdapterServiceError> {
        let owners = self
            .owners
            .lock()
            .map_err(|_| DebugAdapterServiceError::Runtime(DebugAdapterError::Busy))?;
        let Some((session_id, owner)) = owners
            .iter()
            .find(|(candidate, _)| candidate.as_str() == session_id)
        else {
            return Err(DebugAdapterServiceError::Runtime(
                DebugAdapterError::NotFound,
            ));
        };
        if *owner != owner_connection_id {
            return Err(DebugAdapterServiceError::NotOwner);
        }
        Ok(session_id.clone())
    }
}

pub(crate) enum DebugAdapterServiceError {
    NotOwner,
    Runtime(DebugAdapterError),
}

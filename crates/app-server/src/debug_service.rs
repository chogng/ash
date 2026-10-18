use std::collections::HashMap;
use std::sync::Mutex;

use ash_debug_adapter::DebugAdapterCommand;
use ash_debug_adapter::DebugAdapterConnection;
use ash_debug_adapter::DebugAdapterError;
use ash_debug_manager::DebugManager as Runtime;
use ash_debug_manager::DebugManagerError;
use ash_debug_manager::DebugRead;
use ash_debug_manager::DebugResponse;
use ash_debug_manager::DebugSessionId;
use ash_file_access::Authorization;
use serde_json::Value;

/// Adds App Server connection ownership to the backend-neutral DAP runtime.
pub(crate) struct DebugAdapterService {
    runtime: Runtime,
    owners: Mutex<HashMap<DebugSessionId, u64>>,
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
    ) -> Result<String, DebugManagerError> {
        let session_id = self.runtime.start(command)?;
        self.own(owner_connection_id, session_id)
    }

    pub(crate) fn connect(
        &self,
        owner_connection_id: u64,
        connection: DebugAdapterConnection,
    ) -> Result<String, DebugManagerError> {
        let session_id = self.runtime.connect(connection)?;
        self.own(owner_connection_id, session_id)
    }

    fn own(
        &self,
        owner_connection_id: u64,
        session_id: DebugSessionId,
    ) -> Result<String, DebugManagerError> {
        let mut owners = match self.owners.lock() {
            Ok(owners) => owners,
            Err(_) => {
                let _ = self.runtime.close(&session_id);
                return Err(DebugManagerError::Busy);
            }
        };
        owners.insert(session_id.clone(), owner_connection_id);
        Ok(session_id.as_str().to_owned())
    }

    pub(crate) fn open_client_transport(&self, owner: u64) -> Result<String, DebugManagerError> {
        self.own(owner, self.runtime.open_client_transport()?)
    }

    pub(crate) fn set_breakpoints(
        &self,
        owner: u64,
        id: &str,
        version: u64,
        intents: Vec<ash_debug_contract::DebugBreakpointIntent>,
    ) -> Result<(), DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .set_breakpoints(&id, version, intents)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn breakpoints(
        &self,
        owner: u64,
        id: &str,
    ) -> Result<ash_debug_contract::DebugBreakpointsSnapshot, DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .breakpoints(&id)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn inspect(
        &self,
        owner: u64,
        id: &str,
        query: ash_debug_contract::DebugInspection,
        expected_epoch: u64,
    ) -> Result<Option<u64>, DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .inspect(&id, query, expected_epoch)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn inspection(
        &self,
        owner: u64,
        id: &str,
        inspection: u64,
    ) -> Result<ash_debug_contract::DebugInspectionResult, DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .inspection(&id, inspection)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn initialize(
        &self,
        owner: u64,
        id: &str,
        options: ash_debug_manager::DebugInitialize,
        public_id: String,
    ) -> Result<(), DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .set_public_id(&id, public_id)
            .map_err(DebugAdapterServiceError::Runtime)?;
        self.runtime
            .initialize(&id, options)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn configure(
        &self,
        owner: u64,
        id: &str,
        filters: Vec<String>,
    ) -> Result<(), DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .configure(&id, filters)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn request(
        &self,
        owner: u64,
        id: &str,
        command: &str,
        arguments: Option<Value>,
    ) -> Result<u64, DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .request(&id, command, arguments)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn response(
        &self,
        owner: u64,
        id: &str,
        request: u64,
    ) -> Result<DebugResponse, DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .response(&id, request)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn input(
        &self,
        owner: u64,
        id: &str,
        input: ash_debug_adapter::DebugAdapterRead,
    ) -> Result<(), DebugAdapterServiceError> {
        let id = self.owned_session(owner, id)?;
        self.runtime
            .input(&id, input)
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn send(
        &self,
        owner_connection_id: u64,
        session_id: &str,
        message: &Value,
    ) -> Result<(), DebugAdapterServiceError> {
        let session_id = self.owned_session(owner_connection_id, session_id)?;
        self.runtime
            .reply(&session_id, message.clone())
            .map_err(DebugAdapterServiceError::Runtime)
    }

    pub(crate) fn read(
        &self,
        owner_connection_id: u64,
        session_id: &str,
        after_sequence: u64,
        max_messages: usize,
    ) -> Result<DebugRead, DebugAdapterServiceError> {
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
            .map_err(|_| DebugAdapterServiceError::Runtime(DebugManagerError::Busy))?
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
    ) -> Result<DebugSessionId, DebugAdapterServiceError> {
        let owners = self
            .owners
            .lock()
            .map_err(|_| DebugAdapterServiceError::Runtime(DebugManagerError::Busy))?;
        let Some((session_id, owner)) = owners
            .iter()
            .find(|(candidate, _)| candidate.as_str() == session_id)
        else {
            return Err(DebugAdapterServiceError::Runtime(
                DebugManagerError::NotFound,
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
    Runtime(DebugManagerError),
}

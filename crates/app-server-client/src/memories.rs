use crate::AppServerClient;
use crate::ClientError;
use crate::JsonRpcTransport;
use ash_app_server_protocol::protocol::memory::MemoryAddParams;
use ash_app_server_protocol::protocol::memory::MemoryDeleteParams;
use ash_app_server_protocol::protocol::memory::MemoryListParams;
use ash_app_server_protocol::protocol::memory::MemoryReadParams;
use ash_app_server_protocol::protocol::memory::MemorySearchParams;
use ash_app_server_protocol::protocol::registry::ClientMethod;

impl<T: JsonRpcTransport> AppServerClient<T> {
    pub fn read_memory_citation(
        &mut self,
        params: ash_app_server_protocol::protocol::memory::MemoryCitationReadParams,
    ) -> Result<memories::MemoryCitationResult, ClientError> {
        let expected = params.citation.clone();
        let result: memories::MemoryCitationResult =
            self.call(ClientMethod::MemoryCitationRead, params)?;
        if result.citation != expected {
            return Err(ClientError::Protocol(
                "Memory citation returned another reference".into(),
            ));
        }
        Ok(result)
    }

    pub fn read_memory_policy(
        &mut self,
        params: ash_app_server_protocol::protocol::memory::MemoryPolicyReadParams,
    ) -> Result<memories::MemoryPolicy, ClientError> {
        let scope = params.scope.clone();
        let result: memories::MemoryPolicy = self.call(ClientMethod::MemoryPolicyRead, params)?;
        if result.scope != scope {
            return Err(ClientError::Protocol(
                "Memory policy returned another scope".into(),
            ));
        }
        Ok(result)
    }

    pub fn update_memory_policy(
        &mut self,
        params: ash_app_server_protocol::protocol::memory::MemoryPolicyUpdateParams,
    ) -> Result<memories::MemoryPolicyMutationResult, ClientError> {
        let scope = params.scope.clone();
        let expected_revision = params.expected_revision.checked_add(1);
        let mode = params.automatic_read;
        let write = params.model_write;
        let result: memories::MemoryPolicyMutationResult =
            self.call(ClientMethod::MemoryPolicyUpdate, params)?;
        if result.policy.scope != scope
            || Some(result.policy.revision) != expected_revision
            || result.policy.automatic_read != mode
            || result.policy.model_write != write
        {
            return Err(ClientError::Protocol(
                "Memory policy mutation returned another scope".into(),
            ));
        }
        Ok(result)
    }

    pub fn add_memory(
        &mut self,
        params: MemoryAddParams,
    ) -> Result<memories::MemoryMutationResult, ClientError> {
        let expected = (params.memory_id.clone(), params.scope.clone());
        let result: memories::MemoryMutationResult = self.call(ClientMethod::MemoryAdd, params)?;
        if result.memory.memory_id != expected.0 || result.memory.scope != expected.1 {
            return Err(ClientError::Protocol(
                "Memory mutation returned another identity".into(),
            ));
        }
        Ok(result)
    }

    pub fn memory_scopes(
        &mut self,
        params: ash_app_server_protocol::protocol::memory::MemoryScopesParams,
    ) -> Result<ash_app_server_protocol::protocol::memory::MemoryScopesResult, ClientError> {
        self.call(ClientMethod::MemoryScopes, params)
    }

    pub fn update_memory(
        &mut self,
        params: ash_app_server_protocol::protocol::memory::MemoryUpdateParams,
    ) -> Result<memories::MemoryMutationResult, ClientError> {
        let expected = (
            params.memory_id.clone(),
            params.scope.clone(),
            params.expected_revision.checked_add(1),
        );
        let result: memories::MemoryMutationResult =
            self.call(ClientMethod::MemoryUpdate, params)?;
        if result.memory.memory_id != expected.0
            || result.memory.scope != expected.1
            || Some(result.memory.revision) != expected.2
        {
            return Err(ClientError::Protocol(
                "Memory update returned another identity or revision".into(),
            ));
        }
        Ok(result)
    }

    pub fn list_memories(
        &mut self,
        params: MemoryListParams,
    ) -> Result<memories::MemoryListPage, ClientError> {
        let scope = params.scope.clone();
        let result: memories::MemoryListPage = self.call(ClientMethod::MemoryList, params)?;
        if result.memories.iter().any(|memory| memory.scope != scope) {
            return Err(ClientError::Protocol(
                "Memory page contains another scope".into(),
            ));
        }
        Ok(result)
    }

    pub fn read_memory(
        &mut self,
        params: MemoryReadParams,
    ) -> Result<memories::Memory, ClientError> {
        let expected = (params.memory_id.clone(), params.scope.clone());
        let result: memories::Memory = self.call(ClientMethod::MemoryRead, params)?;
        if result.memory_id != expected.0 || result.scope != expected.1 {
            return Err(ClientError::Protocol(
                "Memory read returned another identity".into(),
            ));
        }
        Ok(result)
    }

    pub fn search_memories(
        &mut self,
        params: MemorySearchParams,
    ) -> Result<memories::MemorySearchPage, ClientError> {
        let scope = params.scope.clone();
        let result: memories::MemorySearchPage = self.call(ClientMethod::MemorySearch, params)?;
        if result.matches.iter().any(|memory| {
            memory.scope != scope
                || memory.citation.scope != scope
                || memory.citation.memory_id != memory.memory_id
                || memory.citation.revision != memory.revision
        }) {
            return Err(ClientError::Protocol(
                "Memory search contains another scope".into(),
            ));
        }
        Ok(result)
    }

    pub fn delete_memory(
        &mut self,
        params: MemoryDeleteParams,
    ) -> Result<memories::MemoryDeleteResult, ClientError> {
        let expected = (params.memory_id.clone(), params.scope.clone());
        let result: memories::MemoryDeleteResult = self.call(ClientMethod::MemoryDelete, params)?;
        if result.memory_id != expected.0 || result.scope != expected.1 {
            return Err(ClientError::Protocol(
                "Memory deletion returned another identity".into(),
            ));
        }
        Ok(result)
    }
}

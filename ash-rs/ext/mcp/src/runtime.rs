use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::thread::JoinHandle;

use ash_async_utils::CancellationToken;
use ash_core::ToolInteractionService;
use ash_mcp::McpCallError;
use ash_mcp::McpRuntime;
use ash_mcp::McpRuntimeOptions;
use ash_mcp::McpServerDefinition;
use ash_mcp::McpServerTransport;
use ash_mcp::McpSessionFactory;
use ash_mcp::McpToolBinding;
use ash_mcp::RmcpSessionFactory;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use ash_tools::ToolOutput;

use crate::status::McpRuntimeStatusSnapshot;
use crate::status::McpServerRuntimeState;
use crate::status::McpServerRuntimeStatus;

const MCP_COMMAND_QUEUE_CAPACITY: usize = 64;

enum RuntimeCommand {
    Call {
        prepared: Box<McpPreparedCall>,
        cancellation: CancellationToken,
        interactions: Option<Arc<dyn ToolInteractionService>>,
        response: mpsc::Sender<Result<ToolOutput, McpCallError>>,
    },
    Shutdown,
}

struct RuntimeStartup {
    definitions: Vec<ToolDefinition>,
    bindings: BTreeMap<ToolName, McpToolBinding>,
    status: McpRuntimeStatusSnapshot,
}

/// Exact MCP route and arguments admitted for one runtime dispatch.
///
/// The owner creates this value from its immutable startup catalog. App Server keeps the owner
/// inside its generation-bound per-call binding, so a later catalog replacement cannot change the
/// route or arguments used by an already prepared Tool Call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct McpPreparedCall {
    binding: McpToolBinding,
    arguments: serde_json::Value,
}

impl McpPreparedCall {
    pub(crate) fn binding(&self) -> &McpToolBinding {
        &self.binding
    }
}

/// Synchronous extension handle for one continuously driven async MCP runtime.
///
/// The worker thread owns the Tokio runtime and all live MCP sessions. Callers may block on the
/// response channel, while cancellation remains independently wakeable on the worker.
pub(crate) struct McpRuntimeOwner {
    commands: Option<tokio::sync::mpsc::Sender<RuntimeCommand>>,
    definitions: Vec<ToolDefinition>,
    bindings: BTreeMap<ToolName, McpToolBinding>,
    status: McpRuntimeStatusSnapshot,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl McpRuntimeOwner {
    pub(crate) fn start(
        definitions: Vec<McpServerDefinition>,
        options: McpRuntimeOptions,
    ) -> Result<Self, McpRuntimeOwnerError> {
        Self::start_with_factory(definitions, options, Arc::new(RmcpSessionFactory))
    }

    pub(crate) fn start_with_factory(
        definitions: Vec<McpServerDefinition>,
        options: McpRuntimeOptions,
        factory: Arc<dyn McpSessionFactory>,
    ) -> Result<Self, McpRuntimeOwnerError> {
        let (commands, receiver) = tokio::sync::mpsc::channel(MCP_COMMAND_QUEUE_CAPACITY);
        let (startup_sender, startup_receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("ash-mcp-runtime".into())
            .spawn(move || run_worker(definitions, options, factory, receiver, startup_sender))
            .map_err(|error| McpRuntimeOwnerError(error.to_string()))?;
        let startup = match startup_receiver.recv() {
            Ok(Ok(startup)) => startup,
            Ok(Err(error)) => {
                let _ = worker.join();
                return Err(McpRuntimeOwnerError(error));
            }
            Err(_) => {
                let _ = worker.join();
                return Err(McpRuntimeOwnerError(
                    "MCP runtime worker stopped during startup".into(),
                ));
            }
        };
        Ok(Self {
            commands: Some(commands),
            definitions: startup.definitions,
            bindings: startup.bindings,
            status: startup.status,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub(crate) fn definitions(&self) -> &[ToolDefinition] {
        &self.definitions
    }

    pub(crate) fn resolve(&self, name: &ToolName) -> Option<&McpToolBinding> {
        self.bindings.get(name)
    }

    pub(crate) fn status(&self) -> &McpRuntimeStatusSnapshot {
        &self.status
    }

    pub(crate) fn prepare_call(
        &self,
        name: &ToolName,
        arguments: serde_json::Value,
    ) -> Result<McpPreparedCall, McpCallError> {
        if !arguments.is_object() {
            return Err(McpCallError::NotStarted(
                "MCP tool arguments must be a JSON object".into(),
            ));
        }
        let binding = self.bindings.get(name).cloned().ok_or_else(|| {
            McpCallError::NotStarted(format!("MCP tool is not available: {name}"))
        })?;
        Ok(McpPreparedCall { binding, arguments })
    }

    pub(crate) fn call(
        &self,
        prepared: McpPreparedCall,
        cancellation: CancellationToken,
        interactions: Option<Arc<dyn ToolInteractionService>>,
    ) -> Result<ToolOutput, McpCallError> {
        let (response, receiver) = mpsc::channel();
        self.commands
            .as_ref()
            .ok_or_else(|| McpCallError::NotStarted("MCP runtime is shutting down".into()))?
            .try_send(RuntimeCommand::Call {
                prepared: Box::new(prepared),
                cancellation,
                interactions,
                response,
            })
            .map_err(|error| match error {
                tokio::sync::mpsc::error::TrySendError::Full(_) => {
                    McpCallError::NotStarted("MCP runtime command queue is full".into())
                }
                tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                    McpCallError::NotStarted("MCP runtime worker is unavailable".into())
                }
            })?;
        receiver.recv().map_err(|_| {
            McpCallError::OutcomeUncertain(
                "MCP runtime worker stopped before reporting an outcome".into(),
            )
        })?
    }
}

impl Drop for McpRuntimeOwner {
    fn drop(&mut self) {
        if let Some(commands) = self.commands.take() {
            let _ = commands.try_send(RuntimeCommand::Shutdown);
            drop(commands);
        }
        if let Ok(worker) = self.worker.get_mut()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }
}

fn run_worker(
    definitions: Vec<McpServerDefinition>,
    options: McpRuntimeOptions,
    factory: Arc<dyn McpSessionFactory>,
    mut commands: tokio::sync::mpsc::Receiver<RuntimeCommand>,
    startup: mpsc::Sender<Result<RuntimeStartup, String>>,
) {
    let server_metadata = definitions
        .iter()
        .map(|definition| {
            let http_origin = match definition.transport() {
                McpServerTransport::Stdio(_) => None,
                McpServerTransport::StreamableHttp(server) => url::Url::parse(server.uri())
                    .ok()
                    .filter(|url| matches!(url.scheme(), "http" | "https"))
                    .map(|url| url.origin().ascii_serialization()),
            };
            (
                definition.id().clone(),
                definition.display_name().to_owned(),
                http_origin,
            )
        })
        .collect::<Vec<_>>();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = startup.send(Err(error.to_string()));
            return;
        }
    };
    runtime.block_on(async move {
        let mcp = match McpRuntime::start_with_factory(definitions, factory, options).await {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = startup.send(Err(error.to_string()));
                return;
            }
        };
        let definitions = match mcp.catalog().model_definitions() {
            Ok(definitions) => definitions,
            Err(error) => {
                let _ = mcp.shutdown().await;
                let _ = startup.send(Err(error.to_string()));
                return;
            }
        };
        let bindings = mcp
            .catalog()
            .tools()
            .iter()
            .map(|tool| {
                (
                    tool.binding().exposed_name().clone(),
                    tool.binding().clone(),
                )
            })
            .collect();
        let status = runtime_status(&mcp, &server_metadata);
        if startup
            .send(Ok(RuntimeStartup {
                definitions,
                bindings,
                status,
            }))
            .is_err()
        {
            let _ = mcp.shutdown().await;
            return;
        }

        let mcp = Arc::new(mcp);
        let mut calls = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                command = commands.recv() => {
                    match command {
                        Some(RuntimeCommand::Call {
                            prepared,
                            cancellation,
                            interactions,
                            response,
                        }) => {
                            let mcp = Arc::clone(&mcp);
                            calls.spawn(async move {
                                let call = mcp.call_tool(
                                    prepared.binding(),
                                    prepared.arguments.clone(),
                                    &cancellation,
                                );
                                let result = match interactions {
                                    Some(interactions) => {
                                        crate::updates::with_active_tool_interactions(
                                            interactions,
                                            call,
                                        )
                                        .await
                                    }
                                    None => call.await,
                                };
                                let _ = response.send(result);
                            });
                        }
                        Some(RuntimeCommand::Shutdown) | None => break,
                    }
                }
                Some(_) = calls.join_next(), if !calls.is_empty() => {}
            }
        }
        calls.abort_all();
        while calls.join_next().await.is_some() {}
        if let Ok(mcp) = Arc::try_unwrap(mcp) {
            let _ = mcp.shutdown().await;
        }
    });
}

fn runtime_status(
    runtime: &McpRuntime,
    server_metadata: &[(ash_config::McpServerId, String, Option<String>)],
) -> McpRuntimeStatusSnapshot {
    let catalog_generation = runtime.catalog().generation();
    let mut servers = Vec::with_capacity(server_metadata.len());
    for (server_id, display_name, http_origin) in server_metadata {
        let tools = runtime
            .catalog()
            .tools()
            .iter()
            .filter(|tool| tool.binding().remote().server() == server_id)
            .collect::<Vec<_>>();
        let connection_generation = tools
            .iter()
            .map(|tool| tool.binding().connection_generation())
            .min();
        let (state, diagnostic) = match runtime.catalog_freshness(server_id) {
            Some(ash_mcp::McpCatalogFreshness::Fresh) => (McpServerRuntimeState::Connected, None),
            Some(ash_mcp::McpCatalogFreshness::Stale) => (McpServerRuntimeState::Stale, None),
            None => (
                McpServerRuntimeState::Unavailable,
                runtime
                    .diagnostics()
                    .iter()
                    .find(|diagnostic| diagnostic.server == *server_id)
                    .map(|diagnostic| diagnostic.message.clone()),
            ),
        };
        servers.push(McpServerRuntimeStatus {
            server_id: server_id.to_string(),
            display_name: display_name.clone(),
            state,
            catalog_generation,
            connection_generation,
            tool_count: tools.len() as u64,
            diagnostic,
            http_origin: http_origin.clone(),
        });
    }
    McpRuntimeStatusSnapshot {
        catalog_generation,
        servers,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct McpRuntimeOwnerError(String);

impl std::fmt::Display for McpRuntimeOwnerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for McpRuntimeOwnerError {}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

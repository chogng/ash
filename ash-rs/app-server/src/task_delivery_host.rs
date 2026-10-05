//! SSH transport and model tool adapters for the task-delivery domain.
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_async_utils::CancellationToken;
use ash_async_utils::FutureCancellationExt;
use ash_extension_api::CapabilityToolContribution;
use ash_extension_api::CapabilityToolContributor;
use ash_extension_api::ExtensionError;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::ExtensionToolAuthority;
use ash_remote::SshTarget;
use ash_remote_profile_store::RemoteConnectionProfileStore;
use ash_tools::ToolConcurrency;
use ash_tools::ToolContent;
use ash_tools::ToolDefinition;
use ash_tools::ToolExecutionFuture;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolInputSchema;
use ash_tools::ToolInvocation;
use ash_tools::ToolLoading;
use ash_tools::ToolName;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputSchema;
use ash_tools::ToolPayload;
use ash_tools::ToolSchemaMode;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use task_delivery::PeerFuture;
use task_delivery::Runtime;
use task_delivery::SnapshotInfo;
use task_delivery::TaskPackage;
use task_delivery::TaskReadParams;
use task_delivery::TaskReceipt;
use task_delivery::TaskReport;

pub(crate) struct SshPeer(pub(crate) PathBuf);
impl SshPeer {
    fn call<'a, T: DeserializeOwned + Send + 'a>(
        &'a self,
        target: &'a SshTarget,
        method: ClientMethod,
        params: Value,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, T> {
        Box::pin(async move {
            let profile = RemoteConnectionProfileStore::from_profile_root(&self.0)
                .connection(target)
                .map_err(error)?
                .ok_or_else(|| error("SSH runtime is not configured for this saved target"))?
                .active_profile();
            let cancellation = cancellation.clone();
            // The worker owns and joins SSH. Cancellation reaches that worker rather than merely
            // dropping an awaiting future while the process still sends the task.
            let value = tokio::task::spawn_blocking(move || {
                crate::managed::task_request(profile, method, params, &cancellation)
            })
            .await
            .map_err(error)?
            .map_err(error)?;
            serde_json::from_value(value).map_err(error)
        })
    }
}
impl task_delivery::Peer for SshPeer {
    fn snapshot_info<'a>(
        &'a self,
        target: &'a SshTarget,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, SnapshotInfo> {
        self.call(
            target,
            ClientMethod::TaskSnapshotInfo,
            json!({}),
            cancellation,
        )
    }
    fn receive<'a>(
        &'a self,
        target: &'a SshTarget,
        package: &'a TaskPackage,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, TaskReceipt> {
        self.call(
            target,
            ClientMethod::TaskReceive,
            serde_json::to_value(package).expect("task package serializes"),
            cancellation,
        )
    }
    fn read<'a>(
        &'a self,
        target: &'a SshTarget,
        params: &'a TaskReadParams,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, TaskReport> {
        self.call(
            target,
            ClientMethod::TaskRead,
            serde_json::to_value(params).expect("task read serializes"),
            cancellation,
        )
    }
}

pub(crate) fn install(
    registry: &mut ExtensionRegistryBuilder,
    runtime: Arc<Runtime>,
    dirs: Arc<crate::dir_grants::DirGrants>,
) {
    registry.capability_tool_contributor("task-delivery", Arc::new(Contribution { runtime, dirs }));
}
struct Contribution {
    runtime: Arc<Runtime>,
    dirs: Arc<crate::dir_grants::DirGrants>,
}
impl CapabilityToolContributor for Contribution {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        Ok([Access::Targets, Access::List, Access::Send, Access::Read]
            .into_iter()
            .map(|access| {
                CapabilityToolContribution::new(
                    Arc::new(TaskTool {
                        runtime: self.runtime.clone(),
                        dirs: self.dirs.clone(),
                        access,
                    }),
                    match access {
                        Access::Targets | Access::List => {
                            ExtensionToolAuthority::ManagedStateRead {
                                resource: "task-delivery-links".into(),
                            }
                        }
                        Access::Read => ExtensionToolAuthority::ExternalRead {
                            service: "ssh-task-delivery".into(),
                            network_scopes: vec!["ssh:saved-connections".into()],
                            credential_reference: None,
                        },
                        Access::Send => ExtensionToolAuthority::ExternalWrite {
                            service: "ssh-task-delivery".into(),
                            network_scopes: vec!["ssh:saved-connections".into()],
                            credential_reference: None,
                            artifact_root: "task-delivery-code-snapshot".into(),
                        },
                    },
                )
            })
            .collect())
    }
}
#[derive(Clone, Copy)]
enum Access {
    Targets,
    List,
    Send,
    Read,
}
impl Access {
    fn name(self) -> &'static str {
        match self {
            Self::Targets => "remote_task_targets",
            Self::List => "remote_task_list",
            Self::Send => "remote_task_send",
            Self::Read => "remote_task_read",
        }
    }
}
struct TaskTool {
    runtime: Arc<Runtime>,
    dirs: Arc<crate::dir_grants::DirGrants>,
    access: Access,
}
impl ToolExecutor for TaskTool {
    fn definition(&self) -> ToolDefinition {
        let (description, schema) = match self.access {
            Access::Targets => (
                "List saved SSH task destinations and whether their runtime is configured.",
                json!({"type":"object","additionalProperties":false,"properties":{}}),
            ),
            Access::List => (
                "List the latest 50 outgoing task links owned by this source Thread. Use this after reconnecting or after a response was lost to recover the saved delivery_id for querying or an identical retry. Does not contact the remote machine.",
                json!({"type":"object","additionalProperties":false,"properties":{}}),
            ),
            Access::Send => (
                "Deliver an independent task to a saved SSH machine. Requires the user's instruction to delegate to that machine. Include source acceptance evidence and all context needed by the recipient. Transfers this execution directory's exact Git HEAD and disk tree, including nonignored untracked files; unsaved editor buffers are not included. Destination uses its own model, credentials and permissions and continues after this connection closes. Returns a linked Session receipt. After an uncertain result retry with the returned delivery_id and the identical arguments; never make a new delivery merely because the response was lost. Git pack is limited to 64 MiB; submodules and embedded repositories are rejected.",
                json!({"type":"object","additionalProperties":false,"required":["target","title","instructions","context"],
                    "properties":{"target":{"type":"string"},"title":{"type":"string","maxLength":256},
                        "instructions":{"type":"string"},"context":{"type":"string"},"delivery_id":{"type":"string"}}}),
            ),
            Access::Read => (
                "Read an outgoing task's current remote queue/Turn status and latest agent report using its delivery_id. The source Thread must own the saved delivery. Running status is not acceptance evidence. Follow up with the destination Session directly when user input or approval is needed.",
                json!({"type":"object","additionalProperties":false,"required":["delivery_id"],
                    "properties":{"delivery_id":{"type":"string"}}}),
            ),
        };
        ToolDefinition::function(
            ToolName::new(self.access.name()).expect("task tool name"),
            description,
            ToolInputSchema::parse(schema).expect("task tool schema"),
            ToolOutputSchema::Unspecified,
            ToolSchemaMode::ProviderDefault,
            ToolLoading::Eager,
        )
        .expect("task tool definition")
    }
    fn concurrency(&self) -> ToolConcurrency {
        match self.access {
            Access::Send => ToolConcurrency::Exclusive,
            Access::Targets | Access::List | Access::Read => ToolConcurrency::ParallelSafe,
        }
    }
    fn execute(&self, call: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(async move {
            let result = self.execute_call(&call).await;
            ToolExecutionOutcome::Returned(match result {
                Ok(value) => ToolOutput::success(vec![ToolContent::Text(value.to_string())]),
                Err(error) => ToolOutput::error(vec![ToolContent::Text(error.to_string())]),
            })
        })
    }
}
impl TaskTool {
    async fn execute_call(&self, call: &ToolInvocation) -> task_delivery::Result<Value> {
        if call.binding().exposed_name().as_str() != self.access.name() {
            return Err(error("task tool binding mismatch"));
        }
        let cancellation = call.context().cancellation();
        cancellation.check().map_err(error)?;
        let owner = call
            .context()
            .thread_id()
            .ok_or_else(|| error("source Thread is missing"))?;
        let ToolPayload::FunctionArguments(args) = call.payload() else {
            return Err(error("task tool requires JSON arguments"));
        };
        if serde_json::to_vec(args)?.len() > 2 * task_delivery::MAX_TEXT_BYTES + 1024 {
            return Err(error("task arguments exceed their byte limit"));
        }
        match self.access {
            Access::Targets => self.runtime.targets(),
            Access::List => self.runtime.outgoing_links(owner),
            Access::Send => {
                let request = serde_json::from_value(args.clone())?;
                // Host extensions do not carry shell execution directories. Resolve the caller's
                // bound worktree through the same directory owner used by file and Git tools.
                let scope = self
                    .dirs
                    .thread_scope(owner, ash_file_access::Permission::ReadFiles)
                    .map_err(error)?
                    .ok_or_else(|| error("source execution directory is missing"))?;
                self.dirs
                    .thread_scope(owner, ash_file_access::Permission::MutateRepository)
                    .map_err(error)?
                    .ok_or_else(|| error("source Git snapshot permission is missing"))?;
                let directory = scope.primary().dir().canonical_path();
                let receipt = self
                    .runtime
                    .send(
                        owner,
                        &format!("{}:{}", call.turn_id(), call.operation_id().as_str()),
                        directory,
                        &request,
                        cancellation,
                    )
                    .await?;
                Ok(serde_json::to_value(receipt)?)
            }
            Access::Read => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Read {
                    delivery_id: ash_protocol::ContentDigest,
                }
                let args: Read = serde_json::from_value(args.clone())?;
                Ok(serde_json::to_value(
                    self.runtime
                        .read_outgoing(owner, &args.delivery_id, cancellation)
                        .await?,
                )?)
            }
        }
    }
}
fn error(error: impl std::fmt::Display) -> task_delivery::Error {
    task_delivery::Error::Runtime(error.to_string())
}

impl crate::AppServer {
    pub(crate) fn task_delivery_request(
        &self,
        method: ClientMethod,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, crate::server::RpcError> {
        use ash_app_server_protocol::protocol::error::AppServerErrorName;
        let service = self.task_delivery.as_ref().ok_or_else(|| {
            crate::server::RpcError::new(-32200, AppServerErrorName::TaskDeliveryUnavailable)
        })?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| {
                crate::server::RpcError::new(-32000, AppServerErrorName::ServerOverloaded)
            })?;
        let output = match method {
            ClientMethod::TaskSnapshotInfo => {
                let _: ash_app_server_protocol::protocol::common::EmptyParams =
                    serde_json::from_value(params.clone()).map_err(|_| {
                        crate::server::RpcError::new(-32602, AppServerErrorName::InvalidParams)
                    })?;
                runtime
                    .block_on(
                        service
                            .snapshot_info()
                            .with_cancellation(cancellation.clone()),
                    )
                    .map_err(|_| {
                        crate::server::RpcError::new(-32800, AppServerErrorName::RequestCancelled)
                    })?
                    .and_then(|value| serde_json::to_value(value).map_err(Into::into))
            }
            ClientMethod::TaskReceive => {
                let package: TaskPackage =
                    serde_json::from_value(params.clone()).map_err(|_| {
                        crate::server::RpcError::new(-32602, AppServerErrorName::InvalidParams)
                    })?;
                // Once provisioning begins, finish durable acceptance even if the sending socket
                // closes. A lost response is resolved by replaying the same immutable package.
                runtime
                    .block_on(service.receive(&package))
                    .and_then(|value| {
                        self.updates.publish_session_changed(&value.session_id);
                        self.updates.publish_queue_changed();
                        serde_json::to_value(value).map_err(Into::into)
                    })
            }
            ClientMethod::TaskRead => {
                let params = serde_json::from_value(params.clone()).map_err(|_| {
                    crate::server::RpcError::new(-32602, AppServerErrorName::InvalidParams)
                })?;
                service
                    .read(&params)
                    .and_then(|value| serde_json::to_value(value).map_err(Into::into))
            }
            _ => unreachable!("task delivery dispatch"),
        };
        output.map_err(|error| {
            let (code, name) = match error {
                task_delivery::Error::Invalid(_) => (-32602, AppServerErrorName::InvalidParams),
                task_delivery::Error::Conflict => {
                    (-32201, AppServerErrorName::TaskDeliveryConflict)
                }
                task_delivery::Error::NotFound => {
                    (-32202, AppServerErrorName::TaskDeliveryNotFound)
                }
                task_delivery::Error::Runtime(_)
                | task_delivery::Error::Storage(_)
                | task_delivery::Error::Encoding(_) => {
                    (-32203, AppServerErrorName::TaskDeliveryOperationFailed)
                }
            };
            crate::server::RpcError::with_details(code, name, error.to_string())
        })
    }
}

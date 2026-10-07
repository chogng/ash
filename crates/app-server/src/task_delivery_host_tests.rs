use super::*;
use ash_model_provider::ModelEventSink;
use ash_model_provider::ModelInvoker;
use ash_model_provider::ModelProviderError;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelStreamEvent;
use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_profile_store::RemoteConnectionCatalog;
use ash_remote_profile_store::RemoteConnectionEntry;
use ash_remote_profile_store::RemoteConnectionName;
use ash_remote_profile_store::RemoteConnectionSaveMode;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::process::Command;
use task_delivery::Peer;
use task_delivery::PeerFuture;
use task_delivery::Runtime;
use task_delivery::RuntimeServices;
use task_delivery::SendTask;
use task_delivery::SnapshotInfo;
use task_delivery::TaskPackage;
use task_delivery::TaskReadParams;
use task_delivery::TaskReceipt;
use task_delivery::TaskReport;

const ACCEPTANCE_REPORT: &str = "macOS 验收完成：已检查移交的版本，启动正常。";

#[derive(Default)]
struct AcceptanceModel(Mutex<Vec<ModelRequest>>);

impl ModelInvoker for AcceptanceModel {
    fn output_transport(&self) -> ModelOutputTransport {
        ModelOutputTransport::NativeStreaming
    }

    fn stream_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        cancellation
            .check()
            .map_err(|signal| ModelProviderError::Cancelled(signal.reason().to_string()))?;
        self.0.lock().unwrap().push(request.clone());
        sink.emit(ModelStreamEvent::TextDelta(ACCEPTANCE_REPORT.into()))?;
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(ACCEPTANCE_REPORT.into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

struct RpcPeer(Arc<AppServer>);
impl RpcPeer {
    fn request<'a, T: serde::de::DeserializeOwned + Send + 'a>(
        &self,
        method: &'static str,
        params: Value,
    ) -> PeerFuture<'a, T> {
        let server = self.0.clone();
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || {
                let mut connection = server.connection();
                initialize_task_connection(&server, &mut connection);
                let response = call(
                    &server,
                    &mut connection,
                    json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}),
                );
                server.close_connection(connection);
                response
            })
            .await
            .unwrap();
            if let Some(error) = result.get("error") {
                return Err(task_delivery::Error::Runtime(error.to_string()));
            }
            Ok(serde_json::from_value(result["result"].clone())?)
        })
    }
}
impl Peer for RpcPeer {
    fn snapshot_info<'a>(
        &'a self,
        _: &'a SshTarget,
        _: &'a CancellationToken,
    ) -> PeerFuture<'a, SnapshotInfo> {
        self.request("task/snapshotInfo", json!({}))
    }
    fn receive<'a>(
        &'a self,
        _: &'a SshTarget,
        package: &'a TaskPackage,
        _: &'a CancellationToken,
    ) -> PeerFuture<'a, TaskReceipt> {
        self.request("task/receive", serde_json::to_value(package).unwrap())
    }
    fn read<'a>(
        &'a self,
        _: &'a SshTarget,
        params: &'a TaskReadParams,
        _: &'a CancellationToken,
    ) -> PeerFuture<'a, TaskReport> {
        self.request("task/read", serde_json::to_value(params).unwrap())
    }
}
fn initialize_task_connection(server: &AppServer, connection: &mut ConnectionState) {
    let response = call(
        server,
        connection,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"task-delivery-test","version":"1"},"capabilities":{}}}),
    );
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        response["result"]["capabilities"]["contracts"]["taskDelivery"]["version"],
        1
    );
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn open(
    profile: &Path,
    directory: &Path,
    shared: Option<Arc<crate::LocalProfileRuntime>>,
) -> Arc<AppServer> {
    let mut options = crate::AppServerOptions::new(profile)
        .with_dir_root(directory)
        .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(Arc::new(
            EchoModel,
        ))))
        .without_built_in_skills();
    if let Some(shared) = shared {
        options = options.with_profile_runtime(shared);
    }
    Arc::new(crate::open_app_server(options).unwrap())
}

fn task_runtime(
    source: &AppServer,
    profile: &Path,
    directory: &Path,
    destination: Arc<AppServer>,
) -> Arc<Runtime> {
    let database = profile.join("state.sqlite3");
    Arc::new(
        Runtime::open(
            &database,
            RuntimeServices {
                profile_root: profile.into(),
                directory: directory.into(),
                profile_id: ash_state::SqliteThreadStore::open(&database)
                    .unwrap()
                    .history_identity()
                    .unwrap(),
                threads: Arc::downgrade(&source.threads),
                queue: Arc::new(queue::QueueStore::open(&database).unwrap()),
                config: source.config.clone().unwrap(),
                peer: Arc::new(RpcPeer(destination)),
            },
        )
        .unwrap(),
    )
}

#[test]
fn task_delivery_replays_one_remote_session_and_executes_after_source_disconnect() {
    let source_profile = tempfile::tempdir().unwrap();
    let target_profile = tempfile::tempdir().unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    git(source_dir.path(), &["init", "--initial-branch=main"]);
    git(source_dir.path(), &["config", "user.name", "Ash Test"]);
    git(
        source_dir.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    std::fs::write(source_dir.path().join("tracked"), "base").unwrap();
    git(source_dir.path(), &["add", "."]);
    git(
        source_dir.path(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "base"],
    );
    git(
        target_dir.path(),
        &["clone", source_dir.path().to_str().unwrap(), "."],
    );
    std::fs::write(source_dir.path().join("tracked"), "staged Windows").unwrap();
    git(source_dir.path(), &["add", "tracked"]);
    std::fs::write(source_dir.path().join("tracked"), "disk Windows").unwrap();
    std::fs::write(source_dir.path().join("new.bin"), [0, 255, 1]).unwrap();
    std::fs::write(target_dir.path().join("tracked"), "existing Mac work").unwrap();
    let source_index = git(source_dir.path(), &["write-tree"]);
    let target_state = Arc::new(crate::LocalProfileRuntime::open(target_profile.path()).unwrap());
    let destination = open(
        target_profile.path(),
        target_dir.path(),
        Some(target_state.clone()),
    );
    let source = open(source_profile.path(), source_dir.path(), None);
    let mut connection = source.connection();
    initialize_task_connection(&source, &mut connection);
    // The source is the existing Windows task in the repository that was already accepted.
    let owner = ash_protocol::ThreadId::new("windows-task").unwrap();
    source
        .threads
        .create_thread(ash_core::CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("windows-agent").unwrap(),
            origin: ash_protocol::ThreadOrigin::Root,
            agent: None,
            session_id: ash_protocol::SessionId::new(owner.as_str()).unwrap(),
            thread_id: owner.clone(),
            title: "Windows 验收".into(),
            execution_target: Some(ash_protocol::SessionExecutionTarget::Local {
                root: source_dir.path().to_str().unwrap().into(),
            }),
        })
        .unwrap();
    let target = SshTarget::new(
        SshHost::parse("mac").unwrap(),
        RemoteDirPath::parse("/remote/project").unwrap(),
    );
    RemoteConnectionCatalog::from_profile_root(source_profile.path())
        .save(
            RemoteConnectionEntry::new(RemoteConnectionName::parse("mac").unwrap(), target),
            RemoteConnectionSaveMode::Create,
        )
        .unwrap();
    let database = source_profile.path().join("state.sqlite3");
    let delivery = task_runtime(
        &source,
        source_profile.path(),
        source_dir.path(),
        destination.clone(),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut request = SendTask {
        target: "mac".into(),
        title: "macOS 验收".into(),
        instructions: "验证 macOS 启动并报告结果".into(),
        context: "Windows 构建与验收已通过；请检查 macOS。".into(),
        delivery_id: None,
    };
    let installed = source
        .agent_extension_registry()
        .contribute_capability_tools()
        .unwrap();
    assert!(
        installed
            .iter()
            .any(|tool| tool.executor().definition().name().as_str() == "remote_task_send")
    );
    let dirs = Arc::new(crate::dir_grants::DirGrants::default());
    dirs.bind_thread_dir(
        owner.clone(),
        ash_file_access::Dir::open_local(source_dir.path()).unwrap(),
    );
    let mut builder = ash_extension_api::ExtensionRegistryBuilder::new();
    crate::task_delivery_host::install(&mut builder, delivery.clone(), dirs);
    let registry = builder.build();
    let contributions = registry.contribute_capability_tools().unwrap();
    let send = contributions
        .iter()
        .find(|tool| tool.executor().definition().name().as_str() == "remote_task_send")
        .unwrap();
    assert!(matches!(
        send.authority(),
        ash_extension_api::ExtensionToolAuthority::ExternalWrite { .. }
    ));
    let definition = send.executor().definition();
    let invocation = ash_tools::ToolInvocation::new(
        ash_tools::ToolOperationId::new("operation").unwrap(),
        ash_protocol::ToolCallId::new("call").unwrap(),
        ash_protocol::TurnId::new("turn").unwrap(),
        ash_tools::ToolBinding::new(
            ash_tools::ToolRegistryGeneration::new(1),
            ash_tools::ToolBindingId::new("send").unwrap(),
            definition.name().clone(),
            definition.digest(),
            ash_tools::ToolRuntimeKey::new("send").unwrap(),
        ),
        ash_tools::ToolPayload::FunctionArguments(serde_json::to_value(&request).unwrap()),
        ash_tools::ToolExecutionContext::new(
            ash_tools::EnvId::new("host-extensions").unwrap(),
            ash_async_utils::CancellationSource::new().token(),
            ash_tools::ToolRuntimeAuthority::Unrestricted,
        )
        .with_thread_id(owner.clone()),
    );
    assert!(invocation.context().execution_dir().is_none());
    let ash_tools::ToolExecutionOutcome::Returned(output) =
        runtime.block_on(send.executor().execute(invocation))
    else {
        panic!("task did not execute");
    };
    assert_eq!(
        output.status(),
        ash_tools::ToolOutputStatus::Success,
        "{output:?}"
    );
    let ash_tools::ToolContent::Text(text) = &output.content()[0] else {
        panic!("task receipt is not text");
    };
    let receipt: TaskReceipt = serde_json::from_str(text).unwrap();
    assert_eq!(
        receipt.directory,
        std::fs::canonicalize(&receipt.directory)
            .unwrap()
            .to_str()
            .unwrap(),
    );
    assert_ne!(receipt.thread_id, owner);
    assert_eq!(receipt.source.thread_id, owner);
    assert_eq!(
        std::fs::read_to_string(Path::new(&receipt.directory).join("tracked")).unwrap(),
        "disk Windows"
    );
    assert_eq!(
        std::fs::read(Path::new(&receipt.directory).join("new.bin")).unwrap(),
        [0, 255, 1]
    );
    assert_eq!(
        git(Path::new(&receipt.directory), &["rev-parse", "HEAD"]),
        receipt.head
    );
    assert_eq!(git(source_dir.path(), &["write-tree"]), source_index);
    assert_eq!(
        std::fs::read_to_string(target_dir.path().join("tracked")).unwrap(),
        "existing Mac work"
    );
    std::fs::write(source_dir.path().join("tracked"), "changed after delivery").unwrap();
    request.delivery_id = Some(receipt.delivery_id.clone());
    // Simulate stopping after durable enqueue but before the receipt write. Replay must recover
    // the existing worktree, Thread and queue command rather than accepting another task.
    {
        let state = ash_state::open_sqlite_database(
            &target_profile.path().join("state.sqlite3"),
            ash_state::SqliteDurability::Durable,
        )
        .unwrap();
        assert_eq!(
            state
                .execute(
                    "UPDATE task_delivery_packages SET receipt=NULL WHERE direction='in' AND id=?1",
                    [receipt.delivery_id.as_str()],
                )
                .unwrap(),
            1,
        );
    }
    assert_eq!(
        runtime
            .block_on(delivery.send(
                &owner,
                "later-operation",
                source_dir.path(),
                &request,
                &ash_async_utils::CancellationSource::new().token()
            ))
            .unwrap(),
        receipt
    );
    assert_eq!(destination.threads.list_threads().unwrap().len(), 1);
    let saved = task_delivery::Store::open(&database)
        .unwrap()
        .outgoing(&owner, &receipt.delivery_id)
        .unwrap();
    let mut rejected = saved.package.clone();
    rejected.instructions = "different task with the same identity".into();
    let mut receiver = destination.connection();
    initialize_task_connection(&destination, &mut receiver);
    let conflict = call(
        &destination,
        &mut receiver,
        json!({"jsonrpc":"2.0","id":2,"method":"task/receive","params":rejected}),
    );
    assert_eq!(conflict["error"]["code"], -32201, "{conflict}");
    rejected = saved.package;
    rejected.delivery_id = task_delivery::digest(b"tampered-pack");
    rejected.code.pack_digest = task_delivery::digest(b"different pack bytes");
    let invalid = call(
        &destination,
        &mut receiver,
        json!({"jsonrpc":"2.0","id":3,"method":"task/receive","params":rejected}),
    );
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    assert_eq!(destination.threads.list_threads().unwrap().len(), 1);
    destination.close_connection(receiver);
    let subdirectory = source_dir.path().join("subproject");
    std::fs::create_dir(&subdirectory).unwrap();
    let mut nested_request = request.clone();
    nested_request.delivery_id = None;
    assert!(matches!(
        runtime.block_on(delivery.send(
            &owner,
            "subproject-operation",
            &subdirectory,
            &nested_request,
            &ash_async_utils::CancellationSource::new().token(),
        )),
        Err(task_delivery::Error::Invalid(_))
    ));
    assert_eq!(
        delivery.outgoing_links(&owner).unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let pending = runtime
        .block_on(delivery.read_outgoing(
            &owner,
            &receipt.delivery_id,
            &ash_async_utils::CancellationSource::new().token(),
        ))
        .unwrap();
    assert_eq!(pending.receipt, receipt);
    assert_eq!(pending.queue_status, queue::QueueStatus::Pending);
    source.close_connection(connection);
    drop(installed);
    drop(contributions);
    drop(registry);
    drop(delivery);
    drop(source);
    drop(destination);
    drop(target_state);
    // Reopen the destination's persistent profile with no shared in-memory owner. The queued
    // task and its receipt must survive both SSH disconnection and a receiver restart.
    let model = Arc::new(AcceptanceModel::default());
    let worker = Arc::new(
        crate::open_app_server(
            crate::AppServerOptions::new(target_profile.path())
                .with_user_config_dir_root(&receipt.directory)
                .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(
                    model.clone(),
                )))
                .without_built_in_skills(),
        )
        .unwrap(),
    );
    let queue_runtime = worker.start_queue().unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let report = loop {
        let report = worker
            .task_delivery
            .as_ref()
            .unwrap()
            .read(&TaskReadParams {
                delivery_id: receipt.delivery_id.clone(),
            })
            .unwrap();
        if report.turn_status == Some(ash_protocol::TurnStatus::Completed) {
            break report;
        }
        assert!(Instant::now() < deadline, "{report:?}");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(report.queue_status, queue::QueueStatus::Started);
    assert_eq!(report.message.as_deref(), Some(ACCEPTANCE_REPORT));
    let requests = model.0.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let input = requests[0]
        .input
        .iter()
        .filter_map(|item| match item {
            InputItem::Message(message) => Some(message),
            InputItem::ToolResult(_) | InputItem::Reasoning(_) => None,
        })
        .flat_map(|message| &message.content)
        .filter_map(|content| match content {
            ContentPart::Text(text) => Some(text.as_str()),
            ContentPart::AudioAttachment { .. }
            | ContentPart::AudioUrl { .. }
            | ContentPart::ImageAttachment { .. }
            | ContentPart::ImageUrl { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    for expected in [
        request.instructions.as_str(),
        request.context.as_str(),
        owner.as_str(),
        receipt.head.as_str(),
        receipt.tree.as_str(),
    ] {
        assert!(
            input.contains(expected),
            "missing transferred input: {expected}"
        );
    }
    drop(requests);
    let restarted_source = open(source_profile.path(), source_dir.path(), None);
    let restarted_delivery = task_runtime(
        &restarted_source,
        source_profile.path(),
        source_dir.path(),
        worker.clone(),
    );
    let cancellation = ash_async_utils::CancellationSource::new().token();
    assert_eq!(
        runtime
            .block_on(restarted_delivery.read_outgoing(&owner, &receipt.delivery_id, &cancellation))
            .unwrap(),
        report,
    );
    assert_eq!(
        runtime
            .block_on(restarted_delivery.send(
                &owner,
                "after-restart",
                source_dir.path(),
                &request,
                &cancellation,
            ))
            .unwrap(),
        receipt,
    );
    assert_eq!(
        worker
            .threads
            .read_thread(&receipt.thread_id)
            .unwrap()
            .turns
            .len(),
        1
    );
    let mut catalog = worker.connection();
    initialize_task_connection(&worker, &mut catalog);
    let listed = call(
        &worker,
        &mut catalog,
        json!({"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}),
    );
    assert!(
        listed.to_string().contains(receipt.session_id.as_str()),
        "{listed}"
    );
    worker.close_connection(catalog);
    drop(queue_runtime);
}

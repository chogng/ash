use super::*;
use crate::AppServer;
use crate::model_catalog::ModelCatalog;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::registry::SerializationAccess;
use ash_async_utils::CancellationSource;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_protocol::ModelAccess;
use ash_protocol::ModelRef;
use ash_uds::UnixStream;
use core_api::CoreError;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::Shutdown;
use std::time::Duration;

#[test]
fn stalled_marketplace_queries_leave_state_changes_available() {
    let server = Arc::new(server());
    let mut connection = server.connection();
    let initialized = server.handle_json(
        &mut connection,
        &json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
            "clientInfo":{"name":"marketplace-dispatch-test", "version":"1"}, "capabilities":{},
        }})
        .to_string(),
    );
    assert!(serde_json::from_str::<Value>(&initialized).unwrap()["result"].is_object());
    thread::scope(|scope| {
        let requests = RequestDispatcher::start(scope).unwrap();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let unblock = ReleaseCatalog(Arc::clone(&release));
        let (started, entered) = mpsc::channel();
        let cancellation = CancellationSource::new();
        for (index, (method, params)) in [
            ("marketplace/search", json!({"query":"held"})),
            ("marketplace/get", json!({"packageId":"example/tools"})),
        ]
        .into_iter()
        .enumerate()
        {
            let lane = RequestLane::for_message(method, &params);
            let prepared = server
                .prepare_request(
                    &connection,
                    &json!({"jsonrpc":"2.0", "id":index + 2, "method":method, "params":params})
                        .to_string(),
                )
                .unwrap();
            let handle = requests.handle();
            let ticket = handle.reserve(lane).unwrap();
            let release = Arc::clone(&release);
            let started = started.clone();
            handle.schedule(
                ticket,
                &server.request_scheduler,
                connection.connection_id,
                prepared.scope,
                cancellation.token(),
                lane,
                PendingJob::Blocking(Box::new(move |_| {
                    started.send(()).unwrap();
                    let mut released = release.0.lock().unwrap();
                    while !*released {
                        released = release.1.wait(released).unwrap();
                    }
                    Ok(())
                })),
            );
        }
        entered.recv_timeout(Duration::from_secs(3)).unwrap();
        let (completed, received) = mpsc::channel();
        requests
            .dispatch(
                Arc::clone(&server),
                &connection,
                json!({"jsonrpc":"2.0", "id":4, "method":"session/create", "params":{
                    "commandId":"catalog-independent-session", "title":"ready", "executionTarget":null,
                }}).to_string(),
                move |response| {
                    completed.send(response).unwrap();
                    Ok(())
                },
            )
            .unwrap();
        let response = received.recv_timeout(Duration::from_secs(3));
        drop(unblock);
        requests.finish().unwrap();
        assert!(serde_json::from_str::<Value>(&response.unwrap()).unwrap()["result"].is_object());
    });
    server.close_connection(connection);
}

#[test]
fn check_ignore_dispatch_queries_authorized_paths_and_rejects_directory_escape() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    std::fs::write(root.path().join(".gitignore"), "*.log\n!keep.log\n").unwrap();
    std::fs::write(root.path().join("ignored.log"), "ignored").unwrap();
    std::fs::write(root.path().join("keep.log"), "kept").unwrap();
    let authorization = Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::InspectRepository]),
    )
    .authorize(Permission::InspectRepository)
    .unwrap();
    let server = Arc::new(server().with_git_root(authorization).unwrap());
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served = thread::spawn(move || {
        serving.serve_product_host_stream(BufReader::new(host.try_clone().unwrap()), host)
    });
    client.initialize();
    for (id, paths, expected) in [
        (
            2,
            json!(["ignored.log", "keep.log"]),
            json!({"ignoredPaths":["ignored.log"]}),
        ),
        (3, json!(["../outside"]), Value::Null),
        (4, json!([]), Value::Null),
    ] {
        client.send(
            id,
            "git/checkIgnore",
            json!({"operationId":format!("ignore-{id}"),"paths":paths}),
        );
        let response = loop {
            let message = client.read();
            if message["id"] == id {
                break message;
            }
        };
        if expected.is_null() {
            assert_eq!(response["error"]["code"], -32602, "{response}");
        } else {
            assert_eq!(response["result"], expected, "{response}");
        }
    }
    let held = server
        .request_scheduler
        .acquire(
            0,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    client.send(
        5,
        "git/checkIgnore",
        json!({"operationId":"ignore-queued", "paths":["ignored.log"]}),
    );
    client.send(
        6,
        "git/checkIgnore/cancel",
        json!({"operationId":"ignore-queued"}),
    );
    let mut responses = Vec::new();
    while responses.len() < 2 {
        let response = client.read();
        if response["id"] == 5 || response["id"] == 6 {
            responses.push(response);
        }
    }
    assert!(
        responses
            .iter()
            .any(|message| message["id"] == 5 && message["error"]["message"] == "RequestCancelled")
    );
    assert!(
        responses
            .iter()
            .any(|message| message["id"] == 6 && message["result"]["status"] == "requested")
    );
    drop(held);
    client.send(
        7,
        "git/checkIgnore/cancel",
        json!({"operationId":"ignore-2"}),
    );
    loop {
        let response = client.read();
        if response["id"] == 7 {
            assert_eq!(response["result"], json!({"status":"completed"}));
            break;
        }
    }
    client.close();
    served.join().unwrap().unwrap();
}

#[test]
fn repository_admission_preserves_alias_order_without_blocking_other_requests() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    for path in [root.path(), nested.as_path()] {
        let output = std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let authorization = Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::MutateRepository]),
    )
    .authorize(Permission::MutateRepository)
    .unwrap();
    let server = Arc::new(server().with_git_root(authorization).unwrap());
    let git = server.git_runtime_service().unwrap();
    let repositories = git.repositories().repositories;
    let root_id = repositories
        .iter()
        .find(|repo| repo.path.is_empty())
        .unwrap()
        .id
        .clone();
    let nested_id = repositories
        .iter()
        .find(|repo| repo.path == "nested")
        .unwrap()
        .id
        .clone();
    let held = server
        .request_scheduler
        .acquire(
            99,
            RequestSerializationScope::Repository {
                common_dir: git.common_dir_for(None).unwrap(),
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served = thread::spawn(move || {
        serving.serve_product_host_stream(BufReader::new(host.try_clone().unwrap()), host)
    });
    client.initialize();
    client.send(2, "git/status", json!({}));
    client.send(3, "git/status", json!({"repositoryId":root_id}));
    client.send(4, "session/list", json!({}));
    client.send(5, "git/status", json!({"repositoryId":nested_id}));
    let mut completed = Vec::new();
    while completed.len() != 2 {
        let response = client.read();
        if let Some(id) = response["id"].as_u64() {
            assert!(response["result"].is_object(), "{response}");
            completed.push(id);
        }
    }
    completed.sort();
    assert_eq!(completed, [4, 5]);
    assert_eq!(server.request_scheduler.waiting_count(), 2);
    drop(held);
    let mut released = Vec::new();
    while released.len() != 2 {
        let response = client.read();
        if let Some(id) = response["id"].as_u64() {
            assert!(response["result"].is_object(), "{response}");
            released.push(id);
        }
    }
    released.sort();
    assert_eq!(released, [2, 3]);
    client.close();
    served.join().unwrap().unwrap();
}

pub(crate) fn server() -> AppServer {
    AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(
            ash_model_provider::EchoModel,
        ))),
    )
    .with_ephemeral_env_state()
}

#[test]
fn stalled_git_clone_leaves_queries_and_control_requests_available() {
    use std::io::Read;
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let accepting = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "Git did not connect");
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Git listener failed: {error}"),
            }
        }
    });
    let destination = tempfile::tempdir().unwrap();
    let server = Arc::new(server());
    let serving = Arc::clone(&server);
    let (mut client, host) = Client::pair();
    let served = thread::spawn(move || {
        let (reader, writer) = ash_app_server_transport::LocalStream::pair(host).unwrap();
        serving.serve_product_host_stream(BufReader::new(reader), writer)
    });
    client.initialize();
    client.send(
        2,
        "git/clone",
        json!({
            "url":format!("git://{address}/repo.git"), "parentPath":destination.path(),
        }),
    );
    let mut remote = accepting.join().unwrap();
    remote.set_nonblocking(false).unwrap();
    remote
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = [0; 256];
    assert!(remote.read(&mut bytes).unwrap() > 0);
    client.send(3, "model/list", json!({}));
    client.send(4, "session/list", json!({}));
    client.send(5, "language/cancel", json!({"operationId":"not-started"}));
    let mut responses = Vec::new();
    while responses.len() < 3 {
        let response = client.read();
        if let Some(id) = response["id"].as_u64() {
            assert!(response["result"].is_object(), "{response}");
            responses.push(id);
        }
    }
    responses.sort();
    assert_eq!(responses, [3, 4, 5]);
    remote.shutdown(Shutdown::Both).unwrap();
    let failure = client.read();
    assert_eq!(failure["id"], 2);
    assert_eq!(failure["error"]["code"], -32061);
    assert_eq!(destination.path().read_dir().unwrap().count(), 0);
    client.close();
    served.join().unwrap().unwrap();
}

pub(crate) struct Client {
    pub(crate) writer: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Client {
    pub(crate) fn pair() -> (Self, UnixStream) {
        let (client, host) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        (
            Self {
                reader: BufReader::new(client.try_clone().unwrap()),
                writer: client,
            },
            host,
        )
    }

    pub(crate) fn send(&mut self, id: u64, method: &str, params: Value) {
        writeln!(
            self.writer,
            "{}",
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
        )
        .unwrap();
    }

    pub(crate) fn initialize(&mut self) {
        self.send(
            1,
            "initialize",
            json!({"clientInfo":{"name":"dispatch-test","version":"1"},"capabilities":{}}),
        );
        let response = self.read();
        assert_eq!(response["id"], 1);
        assert!(response["result"].is_object(), "{response}");
    }

    pub(crate) fn read(&mut self) -> Value {
        let mut line = String::new();
        assert_ne!(
            self.reader.read_line(&mut line).unwrap(),
            0,
            "server closed before delivering a response"
        );
        serde_json::from_str(&line).unwrap()
    }

    pub(crate) fn close(&self) {
        self.writer.shutdown(Shutdown::Write).unwrap();
    }
}

struct BlockingCatalog {
    started: mpsc::Sender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

impl ModelCatalog for BlockingCatalog {
    fn set_preferences(
        &self,
        _: crate::model_catalog::ModelPreferencesCommand,
    ) -> Result<ash_config::ConfigCommandResult, crate::model_catalog::ModelPreferencesError> {
        unreachable!("this catalog fixture does not accept preference writes")
    }

    fn list(&self) -> Result<Vec<ModelCatalogEntry>, CoreError> {
        self.started.send(()).unwrap();
        let mut released = self.release.0.lock().unwrap();
        while !*released {
            released = self.release.1.wait(released).unwrap();
        }
        Ok(Vec::new())
    }

    fn current_access(&self, _: &ModelRef) -> Result<ModelAccess, CoreError> {
        Ok(ModelAccess::Unknown)
    }

    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
        Ok(None)
    }
}

pub(crate) struct ReleaseCatalog(Arc<(Mutex<bool>, Condvar)>);

impl Drop for ReleaseCatalog {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
}

pub(crate) fn blocking_catalog_server() -> (Arc<AppServer>, mpsc::Receiver<()>, ReleaseCatalog) {
    let (started, entered) = mpsc::channel();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let server = server().with_model_catalog(Arc::new(BlockingCatalog {
        started,
        release: Arc::clone(&release),
    }));
    (Arc::new(server), entered, ReleaseCatalog(release))
}

#[test]
fn jsonl_delivers_notifications_and_other_requests_during_a_slow_request() {
    let (server, entered, release) = blocking_catalog_server();
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served =
        thread::spawn(move || serving.serve_jsonl(BufReader::new(host.try_clone().unwrap()), host));
    client.initialize();
    client.send(2, "model/list", json!({}));
    entered.recv_timeout(Duration::from_secs(3)).unwrap();

    server.publish_fs_changed_for_test(
        ash_app_server_protocol::protocol::fs::FsChanged::PathsChanged {
            dir_id: None,
            paths: vec!["src/lib.rs".into()],
        },
    );
    client.send(3, "session/list", json!({}));
    let first = client.read();
    let second = client.read();
    assert!(
        [&first, &second]
            .iter()
            .any(|message| message["method"] == "fs/changed")
    );
    assert!(
        [&first, &second]
            .iter()
            .any(|message| message["id"] == 3 && message["result"].is_object())
    );

    drop(release);
    assert_eq!(client.read()["id"], 2);
    client.close();
    served.join().unwrap().unwrap();
}

#[test]
fn jsonl_keeps_a_mutation_response_before_its_causal_notifications() {
    let server = Arc::new(server());
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served =
        thread::spawn(move || serving.serve_jsonl(BufReader::new(host.try_clone().unwrap()), host));
    client.initialize();
    client.send(2, "session/catalog/subscribe", json!({}));
    assert_eq!(client.read()["id"], 2);
    client.send(
        3,
        "session/create",
        json!({"commandId":"causal-session", "title":"causal", "executionTarget":null}),
    );
    let response = client.read();
    assert_eq!(response["id"], 3);
    assert!(response["result"].is_object(), "{response}");
    let notification = client.read();
    assert_eq!(notification["method"], "session/changed");
    assert_eq!(
        notification["params"]["sessionId"],
        response["result"]["session"]["sessionId"]
    );
    client.close();
    served.join().unwrap().unwrap();
}

#[test]
fn queued_resource_requests_leave_execution_and_control_capacity_available() {
    let server = Arc::new(server());
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served =
        thread::spawn(move || serving.serve_jsonl(BufReader::new(host.try_clone().unwrap()), host));
    client.initialize();
    let held = server
        .request_scheduler
        .acquire(
            0,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    for id in 2..=66 {
        client.send(id, "session/list", json!({}));
    }
    client.send(
        1000,
        "language/cancel",
        json!({"operationId":"not-started"}),
    );
    client.send(1001, "session/request", json!({
        "commandId":"interrupt-turn", "sessionId":"unknown-session", "request": {
            "type":"interruptTurn", "threadId":"unknown-thread", "turnId":"unknown-turn", "expectedSequence":0,
        },
    }));
    client.send(
        1002,
        "session/request",
        json!({
            "commandId":"stop-session", "sessionId":"unknown-session", "request":{"type":"stop"},
        }),
    );
    let first = client.read();
    let second = client.read();
    let third = client.read();
    let fourth = client.read();
    assert!([&first, &second, &third, &fourth].iter().any(|message| message["id"] == 66 && message["error"]["message"] == "ServerOverloaded"));
    assert!(
        [&first, &second, &third, &fourth]
            .iter()
            .any(|message| message["id"] == 1000 && message["result"].is_object())
    );
    assert!(
        [&first, &second, &third, &fourth]
            .iter()
            .any(|message| message["id"] == 1001
                && message["error"].is_object()
                && message["error"]["message"] != "ServerOverloaded")
    );
    assert!(
        [&first, &second, &third, &fourth]
            .iter()
            .any(|message| message["id"] == 1002
                && message["error"].is_object()
                && message["error"]["message"] != "ServerOverloaded")
    );
    drop(held);
    for _ in 0..64 {
        assert!(client.read()["result"].is_object());
    }
    client.close();
    served.join().unwrap().unwrap();
}

#[test]
fn response_backpressure_releases_resources_used_by_other_connections() {
    let server = Arc::new(server());
    let mut connection = server.connection();
    let initialize = json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params": {
        "clientInfo":{"name":"backpressure-test", "version":"1"}, "capabilities":{},
    }})
    .to_string();
    assert!(serde_json::from_str::<Value>(&server.handle_json(&mut connection, &initialize)).unwrap()["result"].is_object());
    let (started, delivered) = mpsc::channel();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let unblock = ReleaseCatalog(Arc::clone(&release));
    let serving = Arc::clone(&server);
    let served = thread::spawn(move || {
        thread::scope(|scope| {
            let requests = RequestDispatcher::start(scope).unwrap();
            requests.dispatch(Arc::clone(&serving), &connection,
                json!({"jsonrpc":"2.0", "id":2, "method":"session/create", "params":{
                    "commandId":"slow-writer-session", "title":"slow writer", "executionTarget":null,
                }}).to_string(),
            move |response| {
                started.send(serde_json::from_str::<Value>(&response).unwrap()).unwrap();
                let mut ready = release.0.lock().unwrap();
                while !*ready { ready = release.1.wait(ready).unwrap(); }
                Ok(())
            },
        ).unwrap();
            requests.finish().unwrap();
            serving.close_connection(connection);
        })
    });
    assert!(delivered.recv_timeout(Duration::from_secs(3)).unwrap()["result"].is_object());
    let (finished, received) = mpsc::channel();
    let querying = Arc::clone(&server);
    let queried = thread::spawn(move || {
        let mut connection = querying.connection();
        let initialized = querying.handle_json(&mut connection, &initialize);
        assert!(serde_json::from_str::<Value>(&initialized).unwrap()["result"].is_object());
        let response = querying.handle_json(
            &mut connection,
            &json!({
                "jsonrpc":"2.0", "id":2, "method":"session/list", "params":{},
            })
            .to_string(),
        );
        finished
            .send(serde_json::from_str::<Value>(&response).unwrap())
            .unwrap();
        querying.close_connection(connection);
    });
    assert!(received.recv_timeout(Duration::from_secs(3)).unwrap()["result"].is_object());
    queried.join().unwrap();
    drop(unblock);
    served.join().unwrap();
}

#[test]
fn cancellation_completes_a_queued_request_before_its_resource_is_released() {
    let server = Arc::new(server());
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served =
        thread::spawn(move || serving.serve_jsonl(BufReader::new(host.try_clone().unwrap()), host));
    client.initialize();
    let held = server
        .request_scheduler
        .acquire(
            0,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    client.send(
        2,
        "language/completions",
        json!({"operationId":"queued", "request":{}}),
    );
    client.send(3, "language/cancel", json!({"operationId":"queued"}));
    let first = client.read();
    let second = client.read();
    assert!(
        [&first, &second]
            .iter()
            .any(|message| message["id"] == 2 && message["error"]["message"] == "RequestCancelled")
    );
    assert!(
        [&first, &second]
            .iter()
            .any(|message| message["id"] == 3 && message["result"].is_object())
    );
    drop(held);
    client.close();
    served.join().unwrap().unwrap();
}

#[test]
fn socket_eof_cancels_waiting_requests_before_joining_workers() {
    let server = Arc::new(server());
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let (done, completed) = mpsc::channel();
    let served = thread::spawn(move || {
        let result =
            serving.serve_product_host_stream(BufReader::new(host.try_clone().unwrap()), host);
        done.send(result).unwrap();
    });
    client.initialize();
    let held = server
        .request_scheduler
        .acquire(
            0,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    client.send(2, "session/list", json!({}));
    client.close();
    let response = client.read();
    assert_eq!(response["id"], 2);
    assert_eq!(response["error"]["message"], "RequestCancelled");
    let result = completed.recv_timeout(Duration::from_secs(3));
    drop(held);
    result.unwrap().unwrap();
    served.join().unwrap();
}

#[test]
fn socket_initialization_does_not_wait_for_unrelated_domain_mutations() {
    let server = Arc::new(server());
    let held = server
        .request_scheduler
        .acquire(
            0,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    let (mut client, host) = Client::pair();
    let serving = Arc::clone(&server);
    let served = thread::spawn(move || {
        serving.serve_product_host_stream(BufReader::new(host.try_clone().unwrap()), host)
    });
    client.initialize();
    client.close();
    served.join().unwrap().unwrap();
    drop(held);
}

#[test]
fn request_byte_saturation_rejects_work_but_keeps_control_and_releases_on_completion() {
    use crate::server::message_queue::MessageBudget;
    let server = Arc::new(server());
    let mut connection = server.product_host_connection();
    let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"bytes-test","version":"1"},"capabilities":{}}});
    assert!(
        serde_json::from_str::<Value>(
            &server.handle_json(&mut connection, &initialize.to_string())
        )
        .unwrap()["result"]
            .is_object()
    );
    let ordinary = json!({"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}).to_string();
    let control = json!({"jsonrpc":"2.0","id":4,"method":"language/cancel","params":{"operationId":"not-started"}}).to_string();
    let budget = MessageBudget::new(ordinary.len());
    let held = server
        .request_scheduler
        .acquire(
            connection.connection_id,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    thread::scope(|scope| {
        let mut dispatch = RequestDispatcher::start(scope).unwrap();
        dispatch.handle.budgets.ordinary = budget.clone();
        dispatch.handle.budgets.control = MessageBudget::new(control.len());
        let (responses, received) = mpsc::channel();
        for raw in [
            ordinary.clone(),
            ordinary.replace("\"id\":2", "\"id\":3"),
            control,
        ] {
            let responses = responses.clone();
            dispatch
                .dispatch(Arc::clone(&server), &connection, raw, move |response| {
                    responses
                        .send(serde_json::from_str::<Value>(&response).unwrap())
                        .unwrap();
                    Ok(())
                })
                .unwrap();
        }
        let rejected = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(rejected["id"], 3);
        assert_eq!(rejected["error"]["message"], "ServerOverloaded");
        let stopped = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(stopped["id"], 4);
        assert!(stopped["result"].is_object());
        assert!(budget.try_reserve(1).is_none());
        drop(held);
        assert_eq!(
            received.recv_timeout(Duration::from_secs(3)).unwrap()["id"],
            2
        );
        dispatch.finish().unwrap();
    });
    assert!(budget.try_reserve(ordinary.len()).is_some());
}

#[test]
fn socket_eof_stops_running_git_network_operations_without_waiting_for_remote_reply() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use std::io::Read;
    use std::net::TcpListener;
    for method in ["git/clone", "git/fetch", "git/pull", "git/push"] {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let accepting = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((stream, _)) => return stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "Git did not connect");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("Git listener failed: {error}"),
                }
            }
        });
        let mut backend = server();
        if method != "git/clone" {
            for args in [
                vec!["init", "--initial-branch=main"],
                vec![
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Initial",
                ],
            ] {
                let output = std::process::Command::new("git")
                    .args(args)
                    .current_dir(directory.path())
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            for (key, value) in [
                ("remote.origin.url", format!("git://{address}/repo.git")),
                (
                    "remote.origin.fetch",
                    "+refs/heads/*:refs/remotes/origin/*".to_string(),
                ),
                ("branch.main.remote", "origin".to_string()),
                ("branch.main.merge", "refs/heads/main".to_string()),
            ] {
                assert!(
                    std::process::Command::new("git")
                        .args(["config", key, &value])
                        .current_dir(directory.path())
                        .status()
                        .unwrap()
                        .success()
                );
            }
            let authorization = Grant::for_environment(
                Dir::open_local(directory.path()).unwrap(),
                GrantSource::HostConfiguration,
                Permissions::new([Permission::MutateRepository]),
            )
            .authorize(Permission::MutateRepository)
            .unwrap();
            backend = backend.with_git_root(authorization).unwrap();
        }
        let backend = Arc::new(backend);
        let serving = Arc::clone(&backend);
        let (mut client, host) = Client::pair();
        let (done, completed) = mpsc::channel();
        let served = thread::spawn(move || {
            let (reader, writer) = ash_app_server_transport::LocalStream::pair(host).unwrap();
            done.send(serving.serve_product_host_stream(BufReader::new(reader), writer))
                .unwrap();
        });
        client.initialize();
        client.send(
            2,
            method,
            if method == "git/clone" {
                json!({"url":format!("git://{address}/repo.git"),"parentPath":directory.path()})
            } else {
                json!({})
            },
        );
        let mut remote = accepting.join().unwrap();
        remote.set_nonblocking(false).unwrap();
        remote
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = [0; 256];
        assert!(
            remote.read(&mut bytes).unwrap() > 0,
            "{method} must actually start"
        );
        client.close();
        let stopped = completed.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            stopped.as_ref().err().is_none_or(|error| matches!(
                error.kind(),
                io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
            )),
            "{method}: {stopped:?}"
        );
        served.join().unwrap();
        // Killing Git's process closes its socket; Windows may reset the TCP
        // connection instead of delivering an orderly EOF.
        match remote.read(&mut bytes) {
            Ok(0) => {}
            #[cfg(windows)]
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            other => panic!("{method} left its network process alive: {other:?}"),
        }
        if method == "git/clone" {
            for entry in directory.path().read_dir().unwrap() {
                assert!(
                    entry.unwrap().path().read_dir().unwrap().next().is_some(),
                    "empty clone reservation was retained"
                );
            }
        }
        let (mut other, host) = Client::pair();
        let served = thread::spawn(move || {
            backend.serve_product_host_stream(BufReader::new(host.try_clone().unwrap()), host)
        });
        other.initialize();
        other.send(2, "model/list", json!({}));
        assert!(other.read()["result"].is_object());
        other.close();
        served.join().unwrap().unwrap();
    }
}

#[test]
fn cancelling_git_lock_wait_does_not_wait_for_background_repository_work() {
    use ash_async_utils::CancellationSource;
    let operation = Arc::new(Mutex::new(()));
    let held = operation.lock().unwrap();
    let waiting = Arc::clone(&operation);
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let (done, completed) = mpsc::channel();
    let waiter = thread::spawn(move || {
        done.send(matches!(
            crate::git_service::lock_for_request(&waiting, &token),
            Err(crate::git_service::GitServiceError::Cancelled)
        ))
        .unwrap();
    });
    cancellation.cancel();
    assert!(completed.recv_timeout(Duration::from_secs(3)).unwrap());
    drop(held);
    waiter.join().unwrap();
}

#[test]
fn dropping_idle_dispatcher_releases_scoped_workers() {
    let (send, receive) = mpsc::channel();
    let owner = thread::spawn(move || {
        thread::scope(|scope| {
            drop(RequestDispatcher::start(scope).unwrap());
        });
        send.send(()).unwrap();
    });
    receive.recv_timeout(Duration::from_secs(3)).unwrap();
    owner.join().unwrap();
}

#[test]
fn network_requests_require_connection_initialization() {
    let server = Arc::new(server());
    let connection = server.connection();
    thread::scope(|scope| {
        let requests = RequestDispatcher::start(scope).unwrap();
        let (send, receive) = mpsc::channel();
        requests
            .dispatch(
                Arc::clone(&server),
                &connection,
                json!({"jsonrpc":"2.0","id":1,"method":"github/labels/list","params":{"operationId":"before-initialize"}})
                    .to_string(),
                move |response| {
                    send.send(serde_json::from_str::<Value>(&response).unwrap())
                        .unwrap();
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(3)).unwrap()["error"]["message"],
            "NotInitialized"
        );
        requests.finish().unwrap();
    });
    server.close_connection(connection);
}

#[test]
fn host_capacity_spans_connections_and_keeps_control_available() {
    use crate::server::message_queue::HostInputBudgets;
    use crate::server::message_queue::MessageBudget;
    let server = Arc::new(server());
    let mut first = server.product_host_connection();
    let mut second = server.product_host_connection();
    for connection in [&mut first, &mut second] {
        crate::tests::initialize(&server, connection);
    }
    let held = server
        .request_scheduler
        .acquire(
            first.connection_id,
            RequestSerializationScope::Global {
                access: SerializationAccess::Exclusive,
            },
        )
        .unwrap();
    let host = Arc::new(HostInputBudgets {
        requests: MessageBudget::new(1),
        ..HostInputBudgets::default()
    });
    thread::scope(|scope| {
        let held = held;
        let mut first_dispatch = RequestDispatcher::start(scope).unwrap();
        let mut second_dispatch = RequestDispatcher::start(scope).unwrap();
        first_dispatch.handle.budgets.host = Arc::clone(&host);
        second_dispatch.handle.budgets.host = Arc::clone(&host);
        let (send, receive) = mpsc::channel();
        for (dispatch, connection, id, method, params) in [
            (&first_dispatch, &first, 2, "session/list", json!({})),
            (&second_dispatch, &second, 3, "model/list", json!({})),
            (
                &second_dispatch,
                &second,
                4,
                "github/cancel",
                json!({"operationId":"not-started"}),
            ),
        ] {
            let send = send.clone();
            dispatch
                .dispatch(
                    Arc::clone(&server),
                    connection,
                    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
                    move |response| {
                        send.send(serde_json::from_str::<Value>(&response).unwrap())
                            .unwrap();
                        Ok(())
                    },
                )
                .unwrap();
        }
        let rejected = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(rejected["id"], 3);
        assert_eq!(rejected["error"]["message"], "ServerOverloaded");
        let control = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(control["id"], 4);
        assert_eq!(control["result"]["status"], "requested");
        assert!(host.requests.try_reserve(1).is_none());
        drop(held);
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(3)).unwrap()["id"],
            2
        );
        first_dispatch.finish().unwrap();
        let send = send.clone();
        second_dispatch
            .dispatch(
                Arc::clone(&server),
                &second,
                json!({"jsonrpc":"2.0","id":5,"method":"model/list","params":{}}).to_string(),
                move |response| {
                    send.send(serde_json::from_str::<Value>(&response).unwrap())
                        .unwrap();
                    Ok(())
                },
            )
            .unwrap();
        assert!(receive.recv_timeout(Duration::from_secs(3)).unwrap()["result"].is_object());
        second_dispatch.finish().unwrap();
    });
    assert!(host.requests.try_reserve(1).is_some());
    server.close_connection(first);
    server.close_connection(second);
}

#[test]
fn host_input_bytes_follow_routed_clones_and_leave_control_capacity_available() {
    use crate::server::message_queue::HostInputBudgets;
    use crate::server::message_queue::MessageBudget;
    let host = Arc::new(HostInputBudgets {
        ordinary: MessageBudget::new(4),
        control: MessageBudget::new(1),
        ..HostInputBudgets::default()
    });
    let first = InputBudgets {
        host: Arc::clone(&host),
        ..InputBudgets::default()
    };
    let second = InputBudgets {
        host: Arc::clone(&host),
        ..InputBudgets::default()
    };
    let mut raw = IncomingRequest::from("1234".to_owned());
    raw.retain(&first, RequestLane::Network).unwrap();
    let mut routed = raw.clone();
    routed.retain(&second, RequestLane::Network).unwrap();
    let mut rejected = IncomingRequest::from("x".to_owned());
    assert!(rejected.retain(&second, RequestLane::Interactive).is_err());
    rejected.retain(&second, RequestLane::Control).unwrap();
    raw.clear();
    drop(raw);
    assert!(host.ordinary.try_reserve(1).is_none());
    drop(routed);
    assert!(host.ordinary.try_reserve(4).is_some());
    drop(rejected);
    assert!(host.control.try_reserve(1).is_some());
}

#[test]
fn registered_cancel_methods_have_reserved_control_execution() {
    use ash_app_server_protocol::protocol::registry::CLIENT_METHODS;
    for method in CLIENT_METHODS
        .iter()
        .filter(|method| method.method.ends_with("/cancel"))
    {
        assert_eq!(
            RequestLane::for_message(method.method, &json!({})),
            RequestLane::Control,
            "{}",
            method.method
        );
    }
}

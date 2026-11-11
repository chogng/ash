use std::fs;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_async_utils::CancellationSource;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_plugin::LocalPluginPackage;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputArtifactData;
use ash_protocol::ToolSourceProvenance;
use core_api::CoreError;
use serde_json::Value;
use serde_json::json;

use super::super::AppServerOptions;
use super::super::LocalProfileRuntime;
use super::super::open_app_server;
use super::local_call;
use super::plugin_request;

const CONNECTOR_ID: &str = "acme/revocation:connector:account";
const RESOURCE_URI: &str = "fixture://connector/record";
const WAIT: Duration = Duration::from_secs(10);

#[test]
fn shared_profile_disconnect_revokes_loaded_connector_in_both_directories() {
    let profile = tempfile::tempdir().unwrap();
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let reads = profile.path().join("mcp-reads");
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    let plugins = &runtime.plugin_authority;
    let package = plugins
        .install_local(
            PluginAuthorityCommandId::new("install-revocation-fixture").unwrap(),
            0,
            &fixture_package(source.path()),
        )
        .unwrap()
        .package;
    for (command_id, command) in [
        (
            "enable-fixture",
            PluginAuthorityCommand::Enable {
                package: package.clone(),
            },
        ),
        ("grant-fixture", PluginAuthorityCommand::Grant { package }),
    ] {
        plugins
            .apply(plugin_request(plugins, command_id, command))
            .unwrap();
    }
    let open = |dir: &Path| {
        let server = open_app_server(
            AppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::clone(&runtime))
                .with_dir_root(dir)
                .without_built_in_skills(),
            ash_app_server_diff::compute,
        )
        .unwrap();
        let mut connection = server.connection();
        let initialized = local_call(
            &server,
            &mut connection,
            json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{"clientInfo":{"name":"connector-revocation-test","version":"1"},"capabilities":{}}
            }),
        );
        assert_eq!(initialized["result"]["capabilities"]["connectors"], true);
        (server, connection)
    };
    let (first, mut first_connection) = open(first_dir.path());
    let listed = local_call(
        &first,
        &mut first_connection,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"connector/list", "params":{}
        }),
    );
    assert_eq!(
        listed["result"]["connectors"][0]["state"]["status"],
        "disconnected"
    );
    let connected = local_call(
        &first,
        &mut first_connection,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"connector/connect/apiToken",
            "params":{
                "commandId":"connect-fixture", "expectedGeneration":listed["result"]["generation"],
                "connectorId":CONNECTOR_ID, "connectionGeneration":1, "accountId":"fixture",
                "accountDisplayName":"Fixture", "apiToken":format!("fixture:{}", reads.display())
            }
        }),
    );
    assert_eq!(connected["result"]["disposition"], "updated", "{connected}");
    let (second, mut second_connection) = open(second_dir.path());
    let cancellation = CancellationSource::new().token();
    let bindings = [&first, &second].map(|server| {
        let ports = server.local_env_tool_ports().unwrap();
        let tools = ports.test_tool_service();
        let deadline = Instant::now() + WAIT;
        let name = loop {
            let (catalog, _, _) = ports.capabilities_snapshot();
            if let Some(tool) = catalog.into_iter().find(|tool| {
                tool.source_chain.iter().any(|source| {
                    matches!(source, ToolSourceProvenance::Mcp { remote_name, .. }
                        if remote_name == "revocation_probe")
                })
            }) {
                break ToolName::new(tool.name).unwrap();
            }
            assert!(Instant::now() < deadline, "Connector tool was not loaded");
            thread::sleep(Duration::from_millis(10));
        };
        let call = ToolCall {
            id: ToolCallId::new("bound-connector-call").unwrap(),
            name,
            arguments: json!({}),
        };
        // Keep the old registry binding alive across disconnect and catalog replacement.
        tools.prepare(&call).unwrap();
        let artifact = tools
            .read_resource(&call, RESOURCE_URI, &cancellation)
            .unwrap();
        assert_eq!(
            artifact.data,
            ToolOutputArtifactData::Text {
                text: "fixture data".into()
            }
        );
        (tools, call)
    });

    let disconnected = local_call(
        &first,
        &mut first_connection,
        json!({
            "jsonrpc":"2.0", "id":4, "method":"connector/disconnect",
            "params":{
                "commandId":"disconnect-fixture", "expectedGeneration":connected["result"]["generation"],
                "connectorId":CONNECTOR_ID
            }
        }),
    );
    assert_eq!(
        disconnected["result"]["credentialCleanup"], "deleted",
        "{disconnected}"
    );
    for (tools, call) in bindings {
        let error = tools
            .read_resource(&call, RESOURCE_URI, &cancellation)
            .unwrap_err();
        assert!(
            matches!(&error, CoreError::Policy(message) if message.contains("Connector is no longer authorized")),
            "{error:?}"
        );
    }
    assert_eq!(fs::read_to_string(reads).unwrap(), "read\nread\n");
    let sibling = local_call(
        &second,
        &mut second_connection,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"connector/list", "params":{}
        }),
    );
    let generation = &disconnected["result"]["command"]["generation"];
    assert_eq!(&sibling["result"]["generation"], generation);
    assert_eq!(
        sibling["result"]["connectors"][0]["state"]["status"],
        "disconnected"
    );
    let notifications = second.connection_notifications(&second_connection);
    let deadline = Instant::now() + WAIT;
    loop {
        if notifications.drain_values().iter().any(|notification| {
            notification["method"] == "connector/changed"
                && &notification["params"]["generation"] == generation
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Sibling did not receive revocation notification"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn fixture_package(root: &Path) -> LocalPluginPackage {
    fs::create_dir(root.join(".ash-plugin")).unwrap();
    #[cfg(windows)]
    let (launcher, script) = ("launch.cmd", "@echo off\r\n%*\r\n");
    #[cfg(unix)]
    let (launcher, script) = ("launch.sh", "#!/bin/sh\nexec \"$@\"\n");
    fs::write(root.join(launcher), script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(launcher), fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(root.join(".ash-plugin/plugin.json"), json!({
        "schemaVersion": 1, "id": "acme/revocation", "version": "1.0.0",
        "displayName": "Revocation fixture", "compatibility": {"ash": ">=0.1.0"},
        "contributions": {
            "mcpServers": [{"id": "fixture", "definition": "mcp.json"}],
            "connectors": [{
                "id": "account", "displayName": "Fixture account",
                "description": "Connector revocation test.", "mcpServer": "fixture"
            }]
        },
        "permissions": [{"type": "process", "executable": launcher}],
        "credentialSlots": [{
            "name": "token", "kind": "secretText", "requiredFor": ["connector:account", "mcp:fixture"]
        }]
    }).to_string()).unwrap();
    let (_, module) = module_path!().split_once("::").unwrap();
    fs::write(root.join("mcp.json"), json!({
        "transport": {
            "type": "stdio", "executable": launcher, "credentialEnv": "ASH_REVOCATION_FIXTURE_TOKEN",
            "args": [std::env::current_exe().unwrap(), "--exact",
                format!("{module}::stdio_connector_fixture"), "--nocapture"]
        }
    }).to_string()).unwrap();
    LocalPluginPackage::load(root).unwrap()
}

#[test]
fn stdio_connector_fixture() {
    let Ok(token) = std::env::var("ASH_REVOCATION_FIXTURE_TOKEN") else {
        return;
    };
    let reads = token.strip_prefix("fixture:").unwrap();
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str().unwrap() {
            "initialize" => json!({
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools":{}, "resources":{}},
                "serverInfo": {"name":"connector-fixture", "version":"1"}
            }),
            "tools/list" => json!({"tools":[{
                "name":"revocation_probe", "inputSchema":{"type":"object","properties":{}}
            }]}),
            "resources/read" => {
                let mut log = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(reads)
                    .unwrap();
                writeln!(log, "read").unwrap();
                json!({"contents":[{
                    "uri":request["params"]["uri"], "mimeType":"text/plain", "text":"fixture data"
                }]})
            }
            method => panic!("unexpected fixture request: {method}"),
        };
        // libtest may write its test name before the first response.
        writeln!(
            stdout,
            "\n{}",
            json!({"jsonrpc":"2.0", "id":id, "result":result})
        )
        .unwrap();
        stdout.flush().unwrap();
    }
}

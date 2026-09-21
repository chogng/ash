use std::io::BufReader;
use std::path::Path;
use std::process::Output;
use std::time::Duration;

use anyhow::Result;
use app_server_protocol::protocol::common::SchemaHash;
use app_server_protocol::protocol::common::ServerInfo;
use app_server_protocol::protocol::initialize::InitializeResult;
use app_server_protocol::protocol::initialize::ProtocolVersion;
use app_server_protocol::protocol::initialize::ServerCapabilities;
use app_server_protocol::rpc::JsonRpcId;
use app_server_protocol::rpc::JsonRpcSuccess;
use app_server_transport::CapabilityTokenSha256;
use app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use app_server_transport::JsonlTransport;
use app_server_transport::start_websocket_acceptor;
use libtest_mimic::Arguments;
use libtest_mimic::Trial;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::process::Command;

const TOKEN: &str = "test-client-loopback-capability-token";

fn main() {
    // The test executable also acts as a stdio peer, preserving the actual launch contract.
    if std::env::args().skip(1).collect::<Vec<_>>() == ["--listen", "stdio://"] {
        fixture().unwrap();
        return;
    }
    libtest_mimic::run(
        &Arguments::from_args(),
        vec![
            Trial::test("stdio_initialize_and_cleanup", || {
                run(stdio_initialize_and_cleanup()).map_err(Into::into)
            }),
            Trial::test("stdio_request_file_and_events", || {
                run(stdio_request_file_and_events()).map_err(Into::into)
            }),
            Trial::test("stdio_commands", || {
                run(stdio_commands()).map_err(Into::into)
            }),
            Trial::test("stdio_failures_and_cleanup", || {
                run(stdio_failures_and_cleanup()).map_err(Into::into)
            }),
            Trial::test("stdio_terminates_unresponsive_child", || {
                run(stdio_terminates_unresponsive_child()).map_err(Into::into)
            }),
            Trial::test("websocket_request_and_authentication", || {
                run(websocket_request_and_authentication()).map_err(Into::into)
            }),
            Trial::test("websocket_rejects_external_endpoint", || {
                run(websocket_rejects_external_endpoint()).map_err(Into::into)
            }),
        ],
    )
    .exit();
}

fn run(future: impl Future<Output = Result<()>>) -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(future)
}

fn initialized() -> Value {
    serde_json::to_value(InitializeResult {
        server_info: ServerInfo {
            name: "test-peer".into(),
            version: "1".into(),
        },
        protocol_version: ProtocolVersion::current(),
        schema_hash: SchemaHash(app_server_protocol::schema_hash()),
        capabilities: ServerCapabilities::default(),
        slash_commands: Vec::new(),
    })
    .unwrap()
}

fn fixture() -> Result<()> {
    let mode = std::env::var("CLIENT_TEST_MODE")?;
    let held_port = if mode == "stubborn" {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        std::fs::write(
            std::env::var_os("CLIENT_TEST_PORT").unwrap(),
            listener.local_addr()?.to_string(),
        )?;
        Some(listener)
    } else {
        None
    };
    let mut wire = JsonlTransport::new(
        BufReader::new(std::io::stdin()),
        std::io::stdout(),
        DEFAULT_MAX_MESSAGE_BYTES,
    );
    let request: Value = serde_json::from_str(&wire.read_message()?.unwrap())?;
    assert_eq!(request["method"], "initialize");
    assert_eq!(request["id"], 1);
    assert_eq!(
        request["params"]["clientInfo"]["name"],
        "ash-app-server-test-client"
    );
    assert_eq!(request["params"]["capabilities"]["notifications"], true);
    assert!(request["params"]["capabilities"]["agentInteractions"].is_null());
    let mut result = initialized();
    if mode == "major" {
        result["protocolVersion"]["major"] = json!(999);
    }
    if mode == "timeout" {
        assert!(
            wire.read_message()?.is_none(),
            "client must close stdin after timeout"
        );
    } else {
        wire.write_message(&serde_json::to_string(&JsonRpcSuccess::new(
            JsonRpcId::Number(1),
            result,
        ))?)?;
        if let Some(line) = wire.read_message()? {
            let request: Value = serde_json::from_str(&line)?;
            assert_eq!(request["id"], 2);
            match mode.as_str() {
                "error" => wire.write_message(&json!({"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad params","data":{"field":"query"}}}).to_string())?,
                "id" => wire.write_message(&json!({"jsonrpc":"2.0","id":9,"result":{}}).to_string())?,
                "malformed" => wire.write_message("not JSON")?,
                "eof" => {},
                "request-timeout" => { assert!(wire.read_message()?.is_none()); }
                "events" => {
                    wire.write_message(&json!({"jsonrpc":"2.0","method":"session/changed","params":{"sessionId":"session"}}).to_string())?;
                    wire.write_message(&json!({"jsonrpc":"2.0","id":"host-1","method":"browser/open","params":{}}).to_string())?;
                    let rejection: Value = serde_json::from_str(&wire.read_message()?.unwrap())?;
                    assert_eq!(rejection["id"], "host-1");
                    assert_eq!(rejection["error"]["code"], -32601);
                    wire.write_message(&json!({"jsonrpc":"2.0","id":2,"result":{
                        "params":request["params"],
                        "home":std::env::var("ASH_HOME")?,
                        "workspace":std::env::var("ASH_WORKSPACE_ROOT").ok()
                    }}).to_string())?;
                }
                _ => {
                    let result = match request["method"].as_str().unwrap() {
                        "model/list" => json!({"models":[]}),
                        "session/list" => json!({"sessions":[]}),
                        "session/subscribe" => {
                            assert_eq!(request["params"]["sessionId"], "session");
                            json!({"subscribed":true})
                        }
                        method => panic!("unexpected method: {method}"),
                    };
                    wire.write_message(&json!({"jsonrpc":"2.0","id":2,"result":result}).to_string())?;
                }
            }
            if mode != "eof" {
                // Watch modes are terminated by the peer after an observable notification.
                if mode == "watch" {
                    wire.write_message(&json!({"jsonrpc":"2.0","method":"session/changed","params":{"sessionId":"session"}}).to_string())?;
                } else {
                    assert!(wire.read_message()?.is_none());
                }
            }
        }
    }
    if let Some(listener) = held_port {
        // Retain an observable OS resource while refusing to exit after stdin EOF.
        let _ = listener.accept()?;
    }
    std::fs::write(std::env::var_os("CLIENT_TEST_EXIT").unwrap(), b"exited")?;
    if mode == "exit" {
        anyhow::bail!("intentional peer failure after its response");
    }
    Ok(())
}

fn client() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ash-app-server-test-client"));
    command
        .env_remove("ASH_APP_SERVER_BIN")
        .env_remove("ASH_APP_SERVER_URL")
        .env_remove("ASH_APP_SERVER_TOKEN")
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

fn stdio_client(root: &Path, mode: &str) -> Command {
    let mut command = client();
    command
        .arg("--server-bin")
        .arg(std::env::current_exe().unwrap())
        .arg("--home")
        .arg(root)
        .arg("--timeout")
        .arg(if mode.ends_with("timeout") { "1" } else { "5" })
        .env("CLIENT_TEST_MODE", mode)
        .env("CLIENT_TEST_EXIT", root.join("exited"))
        .env("ASH_WORKSPACE_ROOT", "must-not-be-inherited");
    command
}

async fn output(command: &mut Command) -> Result<Output> {
    Ok(tokio::time::timeout(Duration::from_secs(10), command.output()).await??)
}

fn lines(output: &Output) -> Vec<Value> {
    String::from_utf8(output.stdout.clone())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

async fn stdio_initialize_and_cleanup() -> Result<()> {
    let root = tempfile::tempdir()?;
    let output = output(stdio_client(root.path(), "ok").arg("initialize")).await?;
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(lines(&output), vec![initialized()]);
    assert!(root.path().join("exited").exists());
    Ok(())
}

async fn stdio_request_file_and_events() -> Result<()> {
    for workspace in [None, Some("explicit-workspace")] {
        let root = tempfile::tempdir()?;
        let params = root.path().join("params.json");
        std::fs::write(&params, r#"{"query":"中文 + newline\n"}"#)?;
        let mut command = stdio_client(root.path(), "events");
        if let Some(workspace) = workspace {
            command.args(["--workspace", workspace]);
        }
        command
            .args(["request", "test/echo"])
            .arg(format!("@{}", params.display()));
        let output = output(&mut command).await?;
        assert!(output.status.success(), "{}", stderr(&output));
        let messages = lines(&output);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["method"], "session/changed");
        assert_eq!(messages[1]["method"], "browser/open");
        assert_eq!(messages[2]["params"]["query"], "中文 + newline\n");
        assert_eq!(messages[2]["home"], root.path().to_str().unwrap());
        assert_eq!(messages[2]["workspace"], json!(workspace));
        assert!(root.path().join("exited").exists());
    }
    Ok(())
}

async fn stdio_commands() -> Result<()> {
    for (args, expected, success) in [
        (vec!["model-list"], json!({"models":[]}), true),
        (vec!["session-list"], json!({"sessions":[]}), true),
        (
            vec!["watch", "--session-id", "session"],
            json!({"subscribed":true}),
            false,
        ),
        (
            vec!["request", "session/list", "--watch"],
            json!({"sessions":[]}),
            false,
        ),
    ] {
        let root = tempfile::tempdir()?;
        let mode = if success { "ok" } else { "watch" };
        let output = output(stdio_client(root.path(), mode).args(args)).await?;
        assert_eq!(output.status.success(), success, "{}", stderr(&output));
        let messages = lines(&output);
        assert!(messages.contains(&expected), "{messages:?}");
        if !success {
            assert_eq!(messages.last().unwrap()["method"], "session/changed");
            assert!(stderr(&output).contains("disconnected"));
        }
        assert!(root.path().join("exited").exists());
    }
    Ok(())
}

async fn stdio_failures_and_cleanup() -> Result<()> {
    for (mode, expected) in [
        ("major", "protocol major mismatch"),
        ("timeout", "initialize timed out"),
        ("request-timeout", "model/list timed out"),
        ("exit", "App Server exited with"),
        ("error", "RPC error -32602: bad params"),
        ("id", "unexpected response id"),
        ("malformed", "invalid App Server JSON-RPC message"),
        ("eof", "disconnected"),
    ] {
        let root = tempfile::tempdir()?;
        let output = output(stdio_client(root.path(), mode).arg("model-list")).await?;
        assert!(!output.status.success());
        assert!(
            stderr(&output).contains(expected),
            "{mode}: {}",
            stderr(&output)
        );
        assert!(
            root.path().join("exited").exists(),
            "child did not exit: {mode}"
        );
    }
    Ok(())
}

async fn stdio_terminates_unresponsive_child() -> Result<()> {
    let root = tempfile::tempdir()?;
    let port_file = root.path().join("port");
    let output = output(
        stdio_client(root.path(), "stubborn")
            .env("CLIENT_TEST_PORT", &port_file)
            .arg("initialize"),
    )
    .await?;
    assert!(output.status.success(), "{}", stderr(&output));
    let address = std::fs::read_to_string(port_file)?.parse()?;
    assert!(
        std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err(),
        "the unresponsive child still owns its TCP listener"
    );
    assert!(!root.path().join("exited").exists());
    Ok(())
}

async fn websocket_request_and_authentication() -> Result<()> {
    let digest = format!("{:x}", Sha256::digest(TOKEN.as_bytes()));
    let listener = start_websocket_acceptor("127.0.0.1:0".parse()?, CapabilityTokenSha256::from_hex(&digest)?, |reader, writer| {
        let mut wire = JsonlTransport::new(BufReader::new(reader), writer, DEFAULT_MAX_MESSAGE_BYTES);
        let initialize: Value = serde_json::from_str(&wire.read_message().unwrap().unwrap()).unwrap();
        assert_eq!(initialize["method"], "initialize");
        wire.write_message(&json!({"jsonrpc":"2.0","id":1,"result":initialized()}).to_string()).unwrap();
        let request: Value = serde_json::from_str(&wire.read_message().unwrap().unwrap()).unwrap();
        wire.write_message(&json!({"jsonrpc":"2.0","id":request["id"],"result":{"method":request["method"],"params":request["params"]}}).to_string()).unwrap();
        // Keep the authenticated connection alive until the client closes it.
        let _ = wire.read_message();
    }).await?;
    let url = format!("ws://{}", listener.address());
    let successful = output(client().env("ASH_APP_SERVER_TOKEN", TOKEN).args([
        "--url",
        &url,
        "request",
        "test/echo",
        r#"{"value":42}"#,
    ]))
    .await?;
    assert!(successful.status.success(), "{}", stderr(&successful));
    assert_eq!(
        lines(&successful),
        vec![json!({"method":"test/echo","params":{"value":42}})]
    );
    assert!(!stderr(&successful).contains(TOKEN));

    let rejected =
        output(client().args(["--url", &url, "--token", "wrong-secret", "initialize"])).await?;
    assert!(!rejected.status.success());
    assert!(stderr(&rejected).contains("401"), "{}", stderr(&rejected));
    assert!(!stderr(&rejected).contains("wrong-secret"));

    let missing = output(client().args(["--url", &url, "initialize"])).await?;
    assert!(!missing.status.success());
    assert!(stderr(&missing).contains("requires --token"));
    listener.shutdown().await?;
    Ok(())
}

async fn websocket_rejects_external_endpoint() -> Result<()> {
    let output = output(client().args([
        "--url",
        "ws://192.0.2.1:4222",
        "--token",
        TOKEN,
        "initialize",
    ]))
    .await?;
    assert!(!output.status.success());
    assert!(stderr(&output).contains("loopback"));
    Ok(())
}

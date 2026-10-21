use crate::RmcpClient;
use crate::RmcpClientError;
use crate::RmcpClientOptions;
use crate::RmcpTimeouts;
use crate::StdioServerCommand;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const FIXTURE: &str = "process_tests::stdio_fixture";
const MODE: &str = "ASH_MCP_PROCESS_TEST_MODE";
const ROOT: &str = "ASH_MCP_PROCESS_TEST_ROOT";

#[test]
fn stdio_fixture() {
    let Ok(mode) = std::env::var(MODE) else {
        return;
    };
    let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let marker = if mode == "leaf" { "leaf" } else { "parent" };
    std::fs::write(
        root.join(marker),
        listener.local_addr().unwrap().to_string(),
    )
    .unwrap();
    if mode == "leaf" {
        std::thread::sleep(Duration::from_secs(15));
        return;
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FIXTURE, "--nocapture"])
        .env(MODE, "leaf")
        .spawn()
        .unwrap();
    if mode == "stall" {
        // Keep inherited pipes open, like npm exec launching a server that never initializes.
        child.wait().unwrap();
        return;
    }
    for line in std::io::stdin().lock().lines() {
        let request: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if request["method"] == "initialize" {
            let response = serde_json::json!({
                "jsonrpc": "2.0", "id": request["id"],
                "result": {"protocolVersion": request["params"]["protocolVersion"],
                    "capabilities": {}, "serverInfo": {"name": "process-fixture", "version": "0"}}
            });
            // The test harness also writes text; keep the wire response on its own line.
            writeln!(std::io::stdout(), "\n{response}").unwrap();
        }
    }
    // Exit on stdin EOF while the descendant still holds the inherited output pipes.
}

async fn probes(root: &Path) -> Vec<TcpStream> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.join("parent").exists() || !root.join("leaf").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    ["parent", "leaf"]
        .into_iter()
        .map(|name| {
            let address = std::fs::read_to_string(root.join(name)).unwrap();
            let stream = TcpStream::connect(address).unwrap();
            stream.set_nonblocking(true).unwrap();
            stream
        })
        .collect()
}

async fn assert_stopped(mut probes: Vec<TcpStream>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        for stream in &mut probes {
            loop {
                match stream.read(&mut [0]) {
                    Ok(0) => break,
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    result => panic!("unexpected liveness probe: {result:?}"),
                }
            }
        }
    })
    .await
    .expect("MCP launcher or descendant survived cleanup");
}

fn command(root: &Path, mode: &str) -> StdioServerCommand {
    StdioServerCommand::new(std::env::current_exe().unwrap())
        .with_args(["--exact", FIXTURE, "--nocapture"])
        .with_env(MODE, mode)
        .with_env(ROOT, root)
}

fn options() -> RmcpClientOptions {
    RmcpClientOptions::new("process-test", "0").with_timeouts(RmcpTimeouts {
        initialize: Duration::from_secs(2),
        request: Duration::from_secs(2),
        shutdown: Duration::from_secs(5),
    })
}

#[tokio::test]
async fn initialize_timeout_terminates_launcher_and_descendant() {
    let root = tempfile::tempdir().unwrap();
    let task = tokio::spawn(RmcpClient::connect_stdio(
        command(root.path(), "stall"),
        options(),
    ));
    let probes = probes(root.path()).await;
    assert!(matches!(
        task.await.unwrap(),
        Err(RmcpClientError::InitializeTimeout(_))
    ));
    assert_stopped(probes).await;
}

#[tokio::test]
async fn cancelled_initialize_terminates_launcher_and_descendant() {
    let root = tempfile::tempdir().unwrap();
    let task = tokio::spawn(RmcpClient::connect_stdio(
        command(root.path(), "stall"),
        options(),
    ));
    let probes = probes(root.path()).await;
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert_stopped(probes).await;
}

#[tokio::test]
async fn repeated_shutdown_and_drop_terminate_launcher_and_descendant() {
    for shutdown in [true, false, true, false] {
        let root = tempfile::tempdir().unwrap();
        let client = RmcpClient::connect_stdio(command(root.path(), "serve"), options())
            .await
            .unwrap();
        let probes = probes(root.path()).await;
        if shutdown {
            client.shutdown().await.unwrap();
        } else {
            drop(client);
        }
        assert_stopped(probes).await;
    }
}

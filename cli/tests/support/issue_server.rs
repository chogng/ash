//! Runs the real App Server behind an isolated SSH transport, with only GitHub HTTP scripted.

use crate::tui_process::Fixture;
use crate::tui_process::LARGE_SIZE;
use crate::tui_process::TuiProcess;
use ash_async_utils::CancellationSource;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use github::GitHubAccountManager;
use std::io::BufReader;
use std::io::Write;
use std::net::Shutdown;
use std::os::unix::net::UnixListener;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

struct GitHubHttp {
    provider: PathBuf,
}

impl HttpClient for GitHubHttp {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        let endpoint = request
            .url()
            .strip_prefix("https://api.github.com/")
            .unwrap();
        assert!(request.headers().iter().any(|header| {
            header.name().eq_ignore_ascii_case("Authorization")
                && header.value() == "Bearer fixture-only-token"
        }));
        let mut child = Command::new(&self.provider)
            .args([
                match request.method() {
                    HttpMethod::Get => "GET",
                    HttpMethod::Post => "POST",
                    HttpMethod::Patch => "PATCH",
                    HttpMethod::Put => "PUT",
                    HttpMethod::Delete => "DELETE",
                },
                endpoint,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.body())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        Ok(HttpResponse::new(
            if output.status.success() { 200 } else { 503 },
            vec![HttpHeader::new("Content-Type", "application/json")],
            if output.status.success() {
                output.stdout
            } else {
                serde_json::to_vec(&serde_json::json!({
                    "message": String::from_utf8_lossy(&output.stderr).trim(),
                }))
                .unwrap()
            },
        ))
    }
}

pub struct IssueServer {
    server: Arc<ash_app_server::AppServer>,
    _socket_dir: tempfile::TempDir,
    ssh: PathBuf,
    stopping: Arc<AtomicBool>,
    connection: Arc<Mutex<Option<UnixStream>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl IssueServer {
    pub fn start(fixture: &Fixture) -> Self {
        let http = Arc::new(GitHubHttp {
            provider: fixture.find_file("issue-provider").unwrap(),
        });
        let secrets = Arc::new(
            ash_secrets::FileSecretStore::open(fixture.profile().join("secrets")).unwrap(),
        );
        let accounts = github::GitHubOAuth::tokens(http.clone(), secrets);
        accounts
            .connect_token(
                "github.com",
                ash_secrets::SecretValue::new(b"fixture-only-token".to_vec()),
                &CancellationSource::new().token(),
            )
            .unwrap();
        let server = Arc::new(
            ash_app_server::open_app_server(
                ash_app_server::AppServerOptions::new(fixture.profile())
                    .with_codex_home(fixture.codex_home())
                    .with_dir_root(fixture.workspace()),
            )
            .unwrap()
            .with_github_accounts(accounts.clone())
            .with_github_credentials(accounts, http)
            .unwrap(),
        );

        // The normal fixture paths exceed Unix socket limits. This private temporary directory
        // still restricts the product-host transport to this test and its child CLI processes.
        let socket_dir = tempfile::Builder::new()
            .prefix("ash-issue-")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = socket_dir.path().join("server.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let ssh = socket_dir.path().join("ssh");
        cargo_bin::write_executable(
            &ssh,
            &format!(
                r#"#!/usr/bin/env python3
import socket
import sys
import threading

if "__ASH_REMOTE_RUNTIME_FOUND__" in sys.argv[-1]:
    print("__ASH_REMOTE_RUNTIME_FOUND__:/fixture-runtime")
    sys.exit(0)

peer = socket.socket(socket.AF_UNIX)
peer.connect({socket})

def receive():
    while data := peer.recv(65536):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

reader = threading.Thread(target=receive)
reader.start()
while data := sys.stdin.buffer.read1(65536):
    peer.sendall(data)
peer.shutdown(socket.SHUT_WR)
reader.join()
peer.close()
"#,
                socket = serde_json::to_string(socket.to_str().unwrap()).unwrap(),
            ),
        )
        .unwrap();
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = stopping.clone();
        let connection = Arc::new(Mutex::new(None));
        let stream_slot = connection.clone();
        let backend = server.clone();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        // Accepted sockets inherit the listener's nonblocking mode on macOS.
                        stream.set_nonblocking(false).unwrap();
                        {
                            let mut slot = stream_slot.lock().unwrap();
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            *slot = Some(stream.try_clone().unwrap());
                        }
                        let reader = BufReader::new(stream.try_clone().unwrap());
                        let result = backend.serve_product_host_jsonl(reader, stream);
                        stream_slot.lock().unwrap().take();
                        // The real CLI closes SSH before pending notifications can finish writing.
                        if let Err(error) = result
                            && !matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                            )
                        {
                            panic!("issue fixture transport: {error}");
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("issue fixture transport: {error}"),
                }
            }
        });
        Self {
            server,
            _socket_dir: socket_dir,
            ssh,
            stopping,
            connection,
            worker: Some(worker),
        }
    }

    pub fn connect(&self, fixture: &Fixture) -> TuiProcess {
        TuiProcess::start(
            fixture,
            &[
                "remote",
                "connect",
                "--host",
                "fixture-ssh",
                "--dir",
                fixture.workspace().to_str().unwrap(),
                "--runtime",
                "fixture-runtime",
                "--ssh",
                self.ssh.to_str().unwrap(),
            ],
            LARGE_SIZE,
        )
    }

    pub fn sessions(&self) -> Vec<ash_protocol::Session> {
        self.server.threads().list_sessions().unwrap()
    }
}

impl Drop for IssueServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(connection) = self.connection.lock().unwrap().take() {
            let _ = connection.shutdown(Shutdown::Both);
        }
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

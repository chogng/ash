#![cfg(unix)]

use std::fs;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::num::NonZeroU16;
use std::num::NonZeroU64;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_remote::RemoteDirPath;
use ash_remote::RemotePlatform;
use ash_remote::RemoteProfile;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_connections::RemoteRuntimeArtifact;
use ash_remote_connections::RemoteRuntimeArtifactIntegrity;
use ash_remote_connections::RemoteRuntimeInstallRoot;
use ash_remote_connections::RemoteRuntimeVersion;
use ash_remote_connections::SshAppServerConnectionOptions;
use ash_remote_connections::SshRemoteRuntimeInstaller;
use ash_remote_connections::SshTunnelDiagnostics;
use ash_remote_connections::SshTunnelOptions;
use ash_remote_connections::SshTunnelReadiness;
use bytes::Bytes;
use flate2::read::GzDecoder;
use rustls::pki_types::PrivatePkcs8KeyDer;
use sha2::Digest;
use sha2::Sha256;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

const HOST: &str = "ash-h3-fixture";
const TOKEN: &str = "ash-gateway-fixture";

#[test]
fn helper_reports_invalid_origin_on_stderr_without_writing_ssh_bytes() {
    let output = Command::new(env!("CARGO_BIN_EXE_ash-remote"))
        .args([
            "proxy-command",
            "invalid-url",
            "host:22",
            "unused",
            "unused",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid gateway URL"));
}

#[test]
#[ignore = "requires a host Remote runtime archive and an OpenSSH server"]
fn remote_install_connect_and_forward_through_proxy_command() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    // The release fixture supplies isolated sshd, keys, and a strict known_hosts entry.
    let ssh_config = std::env::var("ASH_TEST_PROXY_SSH_CONFIG").unwrap();
    let ssh_port: u16 = std::env::var("ASH_TEST_PROXY_SSH_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let archive = std::env::var("ASH_TEST_PROXY_ARCHIVE").unwrap();
    let helper = env!("CARGO_BIN_EXE_ash-remote");
    let token_file = root.join("token");
    fs::write(&token_file, TOKEN).unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
    let ca = root.join("gateway.pem");
    fs::write(&ca, cert.cert.pem()).unwrap();
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.cert.der().clone()],
        PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
    )
    .unwrap();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let server_config = quinn::ServerConfig::with_crypto(Arc::new(
        quinn::crypto::rustls::QuicServerConfig::try_from(tls).unwrap(),
    ));
    let gateway = {
        let _enter = runtime.enter();
        quinn::Endpoint::server(server_config, "127.0.0.1:0".parse().unwrap()).unwrap()
    };
    let config = root.join("ssh_config");
    let original = fs::read_to_string(ssh_config).unwrap();
    let helper_log = root.join("proxy-helper.log");
    let helper_wrapper = root.join("proxy-helper");
    fs::write(
        &helper_wrapper,
        format!(
            "#!/bin/sh\nexec \"{helper}\" proxy-command \"$@\" 2>>\"{log}\"\n",
            log = helper_log.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&helper_wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        &config,
        format!(
            "Host {HOST}\n  ProxyCommand \"{}\" https://{} 127.0.0.1:%p \"{}\" \"{}\"\n{}",
            helper_wrapper.display(),
            gateway.local_addr().unwrap(),
            ca.display(),
            token_file.display(),
            original.replace("ash-release-fixture", HOST),
        ),
    )
    .unwrap();
    let ssh = root.join("ssh");
    fs::write(
        &ssh,
        format!(
            "#!/bin/sh\nexec /usr/bin/ssh -F '{}' \"$@\"\n",
            config.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();

    std::thread::scope(|scope| {
        let server = gateway.clone();
        let worker = scope.spawn(move || runtime.block_on(serve(server, ssh_port)));
        let result = std::panic::catch_unwind(|| exercise(&root, &ssh, Path::new(&archive)));
        let drained = result.is_ok() && {
            // Let sshd and the helper exchange FIN before closing the test gateway.
            let deadline = Instant::now() + Duration::from_secs(5);
            while gateway.open_connections() != 0 {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            gateway.open_connections() == 0
        };
        gateway.close(0u8.into(), b"");
        let connections = worker.join().unwrap();
        result.unwrap();
        let diagnostics = fs::read_to_string(helper_log).unwrap();
        assert!(diagnostics.is_empty(), "{diagnostics}");
        assert!(drained, "SSH proxy connection did not close");
        assert!(
            connections >= 4,
            "each SSH operation must reach the gateway"
        );
    });
}

async fn serve(endpoint: quinn::Endpoint, port: u16) -> usize {
    let mut streams = tokio::task::JoinSet::new();
    let mut connections = 0;
    while let Some(incoming) = endpoint.accept().await {
        connections += 1;
        streams.spawn(async move {
            let quic = incoming.await.unwrap();
            let mut h3 = h3::server::builder()
                .build(h3_quinn::Connection::new(quic.clone()))
                .await
                .unwrap();
            let resolver = h3.accept().await.unwrap().unwrap();
            let (request, stream) = resolver.resolve_request().await.unwrap();
            assert_eq!(request.method(), http::Method::CONNECT);
            assert_eq!(request.uri().to_string(), format!("127.0.0.1:{port}"));
            assert_eq!(
                request.headers()[http::header::AUTHORIZATION],
                format!("Bearer {TOKEN}")
            );
            let socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let (mut send, mut recv) = stream.split();
            send.send_response(http::Response::new(())).await.unwrap();
            let (mut read, mut write) = socket.into_split();
            let upload = async {
                while let Some(mut data) = recv.recv_data().await.map_err(std::io::Error::other)? {
                    write.write_all_buf(&mut data).await?;
                }
                write.shutdown().await
            };
            let download = async {
                let mut buffer = [0; 16 * 1024];
                loop {
                    let count = read.read(&mut buffer).await?;
                    if count == 0 {
                        return send.finish().await.map_err(std::io::Error::other);
                    }
                    send.send_data(Bytes::copy_from_slice(&buffer[..count]))
                        .await
                        .map_err(std::io::Error::other)?;
                }
            };
            // A client may close its QUIC connection immediately after SSH disconnect.
            let _ = tokio::try_join!(upload, download);
            quic.closed().await;
        });
    }
    while let Some(result) = streams.join_next().await {
        result.unwrap();
    }
    connections
}

fn exercise(root: &Path, ssh: &Path, archive: &Path) {
    let host = SshHost::parse(HOST).unwrap();
    let installer = SshRemoteRuntimeInstaller::new(host.clone())
        .with_ssh_executable(ssh)
        .with_install_root(
            RemoteRuntimeInstallRoot::parse(root.join("installed").to_str().unwrap()).unwrap(),
        );
    let platform = installer.probe_platform().unwrap();
    let artifact = archive_artifact(archive, platform);
    let installed = installer.install(&artifact).unwrap();
    assert!(Path::new(installed.runtime().executable()).is_file());
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let connection = SshAppServerConnectionOptions::new(RemoteProfile::new(
        SshTarget::new(
            host.clone(),
            RemoteDirPath::parse(workspace.to_str().unwrap()).unwrap(),
        ),
        installed.runtime().clone(),
    ))
    .with_ssh_executable(ssh);
    let initialization = connection.probe_compatibility(
        ClientInfo {
            name: "proxy-command-test".into(),
            version: "0.1.0".into(),
        },
        ClientCapabilities::default(),
    );
    let daemon =
        Path::new(installed.runtime().executable()).with_file_name("ash-app-server-daemon");
    let stopped = Command::new(ssh)
        .args(["-T", HOST, &format!("'{}' stop", daemon.display())])
        .output()
        .unwrap();
    initialization.unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );

    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let remote_port = NonZeroU16::new(listener.local_addr().unwrap().port()).unwrap();
    let local_port = ash_remote_connections::select_available_loopback_port().unwrap();
    let mut tunnel = SshTunnelOptions::new(host, local_port, remote_port)
        .with_ssh_executable(ssh)
        .with_diagnostics(SshTunnelDiagnostics::InheritStderr)
        .start()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while tunnel.poll_readiness().unwrap() == SshTunnelReadiness::Pending {
        assert!(
            Instant::now() < deadline,
            "SSH forward did not become ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut local = TcpStream::connect(("127.0.0.1", local_port.get())).unwrap();
    listener.set_nonblocking(true).unwrap();
    local
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    local.write_all(b"forwarded").unwrap();
    let mut remote = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error) => assert!(Instant::now() < deadline, "{error}"),
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    remote
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut buffer = [0; 9];
    remote.read_exact(&mut buffer).unwrap();
    assert_eq!(&buffer, b"forwarded");
    remote.write_all(b"response!").unwrap();
    local.read_exact(&mut buffer).unwrap();
    assert_eq!(&buffer, b"response!");
    tunnel.stop().unwrap();
}

fn archive_artifact(path: &Path, platform: RemotePlatform) -> RemoteRuntimeArtifact {
    let mut file = fs::File::open(path).unwrap();
    let mut digest = Sha256::new();
    let size = std::io::copy(&mut file, &mut digest).unwrap();
    let mut archive = tar::Archive::new(GzDecoder::new(fs::File::open(path).unwrap()));
    let mut unpacked = 0;
    let mut version = None;
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        unpacked += entry.size();
        if entry.path().unwrap() == Path::new("ash-package.json") {
            let manifest: serde_json::Value = serde_json::from_reader(&mut entry).unwrap();
            version =
                Some(RemoteRuntimeVersion::parse(manifest["version"].as_str().unwrap()).unwrap());
        }
    }
    RemoteRuntimeArtifact::new(
        path.to_owned(),
        version.unwrap(),
        platform,
        RemoteRuntimeArtifactIntegrity::new(
            NonZeroU64::new(size).unwrap(),
            NonZeroU64::new(unpacked).unwrap(),
            format!("{:x}", digest.finalize()),
        )
        .unwrap(),
    )
}

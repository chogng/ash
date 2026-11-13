//! OpenSSH subprocess for one authenticated HTTP/3 CONNECT stream.

use std::fs::File;
use std::io;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use ash_async_utils::CancellationSource;
use rustls::RootCertStore;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use tcp_tunnel::ConnectTarget;
use tcp_tunnel::Credentials;
use tcp_tunnel::ProxyClient;
use tcp_tunnel::ProxyConfig;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use url::Url;

const USAGE: &str =
    "usage: ash-remote proxy-command <https-origin> <host:port> <ca.pem> <token-file>";
const MAX_TOKEN_BYTES: u64 = 64 * 1024;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

pub(super) fn run(arguments: &[String]) -> Result<(), String> {
    let [origin, target, ca, token_file] = arguments else {
        return Err(USAGE.into());
    };
    let origin = Url::parse(origin).map_err(|_| "invalid gateway URL")?;
    let target = ConnectTarget::parse(target).map_err(|error| error.to_string())?;
    let mut roots = RootCertStore::empty();
    let certificates =
        CertificateDer::pem_file_iter(ca).map_err(|_| "could not open gateway CA")?;
    for certificate in certificates {
        roots
            .add(certificate.map_err(|_| "invalid gateway CA PEM")?)
            .map_err(|_| "invalid gateway CA certificate")?;
    }
    // This Host entry explicitly selects the only origin eligible for its bearer.
    let config =
        ProxyConfig::new(origin.clone(), &[origin], roots).map_err(|error| error.to_string())?;
    let credentials = read_credentials(Path::new(token_file))?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "could not start the SSH proxy runtime")?
        .block_on(forward(config, target, credentials))
}

fn read_credentials(path: &Path) -> Result<Credentials, String> {
    let mut token = String::new();
    File::open(path)
        .and_then(|file| file.take(MAX_TOKEN_BYTES + 3).read_to_string(&mut token))
        .map_err(|_| "could not read gateway token file")?;
    let token = token.strip_suffix('\n').unwrap_or(&token);
    let token = token.strip_suffix('\r').unwrap_or(token);
    Credentials::bearer(token, http::HeaderMap::new()).map_err(|error| error.to_string())
}

async fn forward(
    config: ProxyConfig,
    target: ConnectTarget,
    credentials: Credentials,
) -> Result<(), String> {
    #[cfg(unix)]
    let hangup = {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
            .map_err(|_| "could not watch for OpenSSH shutdown")?;
        async move {
            let _ = signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let hangup = std::future::pending::<()>();

    let cancellation = CancellationSource::new();
    let client = ProxyClient::connect(config, credentials, cancellation.token())
        .await
        .map_err(|error| error.to_string())?;
    let stream = client
        .open_stream(target, cancellation.token())
        .await
        .map_err(|error| error.to_string())?;

    // OpenSSH can keep stdin open after the peer closes. A detached reader
    // lets this subprocess exit without waiting for another local SSH byte.
    let (mut writer, mut stdin) = tokio::io::duplex(64 * 1024);
    let runtime = tokio::runtime::Handle::current();
    let (input_result, input_done) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("ssh-proxy-stdin".into())
        .spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut bytes = [0; 16 * 1024];
            let result = loop {
                match stdin.read(&mut bytes) {
                    Ok(0) => break Ok(()),
                    Ok(count) => {
                        if let Err(error) = runtime.block_on(writer.write_all(&bytes[..count])) {
                            break Err(error);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => break Err(error),
                }
            };
            let _ = input_result.send(result);
        })
        .map_err(|_| "could not start the SSH proxy input reader")?;

    let (mut receive, mut send) = tokio::io::split(stream);
    let mut stdout = tokio::io::stdout();
    let download = async {
        let mut bytes = [0; 16 * 1024];
        loop {
            let count = receive.read(&mut bytes).await?;
            if count == 0 {
                return Ok::<(), io::Error>(());
            }
            // Binary SSH messages may contain no newline.
            let written = async {
                stdout.write_all(&bytes[..count]).await?;
                stdout.flush().await
            }
            .await;
            match written {
                // OpenSSH can stop reading while a final gateway packet is in flight.
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
                result => result?,
            }
        }
    };
    let upload = async {
        let copy = async {
            tokio::io::copy(&mut stdin, &mut send).await?;
            send.shutdown().await
        };
        tokio::try_join!(async { input_done.await.map_err(io::Error::other)? }, copy)?;
        Ok::<(), io::Error>(())
    };
    tokio::pin!(download);
    tokio::pin!(hangup);
    let result = tokio::select! {
        biased;
        // OpenSSH sends SIGHUP to the helper during normal Unix shutdown.
        _ = &mut hangup => Ok(()),
        result = &mut download => result.map_err(|_| "SSH proxy download failed"),
        result = upload => match result {
            // Allow final peer bytes after stdin EOF, even if the gateway keeps
            // its receive half open after OpenSSH has exited.
            Ok(()) => tokio::select! {
                _ = hangup => Ok(()),
                result = tokio::time::timeout(SHUTDOWN_GRACE, download) =>
                    result.unwrap_or(Ok(())).map_err(|_| "SSH proxy download failed"),
            },
            Err(_) => Err("SSH proxy upload failed"),
        },
    };
    let cleanup = client.close().await;
    result?;
    cleanup.map_err(|error| error.to_string())
}

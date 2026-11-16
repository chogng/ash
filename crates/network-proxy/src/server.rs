use crate::NetworkDecision;
use crate::NetworkPolicyHandle;
use crate::NetworkRequest;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use std::io;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::timeout;

pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 64;

/// Owns the listeners and every connection for one process execution.
///
/// Dropping this value cancels pending policy requests, closes tunnels and listeners, and joins
/// its runtime thread. It must outlive the child process, including process-tree termination.
pub struct NetworkProxy {
    port: u16,
    cancellation: CancellationSource,
    worker: Option<thread::JoinHandle<()>>,
}

impl NetworkProxy {
    /// Serves HTTP, CONNECT and SOCKS5 on one execution-owned loopback endpoint.
    pub fn start(policy: NetworkPolicyHandle, parent: &CancellationToken) -> io::Result<Self> {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let listener = {
            let _entered = runtime.enter();
            TcpListener::from_std(listener)?
        };
        let cancellation = parent.child_source();
        let context = Arc::new(Context {
            policy,
            cancellation: cancellation.token(),
            policy_gate: Mutex::new(()),
            proxy_port: port,
        });
        let worker = thread::Builder::new()
            .name("network-proxy".into())
            .spawn(move || runtime.block_on(serve(listener, context)))?;
        Ok(Self {
            port,
            cancellation,
            worker: Some(worker),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Replaces inherited proxy routes for this child without changing the host environment.
    pub fn apply_to_command(&self, command: &mut Command) {
        crate::ProxyEnvironment::new(self.port.try_into().expect("bound proxy port"))
            .apply_to_command(command);
    }
}

impl Drop for NetworkProxy {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(crate) struct Context {
    policy: NetworkPolicyHandle,
    pub(crate) cancellation: CancellationToken,
    policy_gate: Mutex<()>,
    proxy_port: u16,
}

impl Context {
    pub(crate) async fn connect(&self, request: NetworkRequest) -> io::Result<TcpStream> {
        let cancellation = self.cancellation.child_source();
        let _guard = cancellation.cancel_on_drop();
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "network execution ended")),
            result = self.connect_authorized(request, cancellation.token()) => result,
        }
    }

    async fn connect_authorized(
        &self,
        request: NetworkRequest,
        cancellation: CancellationToken,
    ) -> io::Result<TcpStream> {
        // DNS is also outbound traffic. Reject unapproved hosts before consulting the resolver.
        // A Turn has one durable interactive request at a time; only decisions are serialized.
        let decision = {
            let _guard = self.policy_gate.lock().await;
            self.policy.decide(request.clone(), cancellation).await
        };
        if let NetworkDecision::Deny(reason) = decision {
            return Err(denied(&reason));
        }
        let addresses = timeout(
            HANDSHAKE_TIMEOUT,
            tokio::net::lookup_host(request.authority()),
        )
        .await??
        .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(io::Error::other("network target has no addresses"));
        }
        let literal = request.host().parse::<IpAddr>().ok();
        for address in &addresses {
            if address.ip().is_loopback() && self.proxy_port == address.port() {
                return Err(denied("proxy cannot connect to its own listeners"));
            }
            // A DNS name cannot authorize a private destination by changing its resolution.
            // An explicit IP or localhost still passes through the host's exact request policy.
            if !public_ip(address.ip())
                && literal != Some(address.ip())
                && !(request.host() == "localhost" && address.ip().is_loopback())
            {
                return Err(denied("hostname resolved to a non-public address"));
            }
        }
        timeout(HANDSHAKE_TIMEOUT, async {
            let mut last = io::Error::other("network target has no reachable addresses");
            for address in addresses {
                match TcpStream::connect(address).await {
                    Ok(stream) => return Ok(stream),
                    Err(error) => last = error,
                }
            }
            Err(last)
        })
        .await?
    }
}

pub(crate) fn denied(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason.to_owned())
}

async fn serve(listener: TcpListener, context: Arc<Context>) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = context.cancellation.cancelled() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            result = listener.accept() => match result {
                Ok((stream, _)) => {
                    if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
                        connections.spawn(serve_shared(stream, Arc::clone(&context), Arc::new(permit)));
                    }
                }
                Err(_) => break,
            },
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

async fn serve_shared(
    stream: TcpStream,
    context: Arc<Context>,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) {
    let mut first = [0];
    if !matches!(
        timeout(HANDSHAKE_TIMEOUT, stream.peek(&mut first)).await,
        Ok(Ok(1))
    ) {
        return;
    }
    if first[0] == 5 {
        let _ = crate::socks::serve(stream, context).await;
    } else {
        crate::http::serve(stream, context, Arc::clone(&permit)).await;
    }
}

pub(crate) async fn tunnel<A>(mut client: A, mut upstream: TcpStream, context: Arc<Context>)
where
    A: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        _ = context.cancellation.cancelled() => {},
        _ = copy_bidirectional(&mut client, &mut upstream) => {},
    }
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(
                (a, b, c),
                (0 | 10 | 127, _, _)
                    | (100, 64..=127, _)
                    | (169, 254, _)
                    | (172, 16..=31, _)
                    | (192, 0, 0..=2)
                    | (192, 88, 99)
                    | (192, 168, _)
                    | (198, 18..=19, _)
                    | (198, 51, 100)
                    | (203, 0, 113)
                    | (224..=255, _, _)
            )
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(ip));
            }
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] <= 0x1ff || s[1] == 0xdb8))
                && s[0] != 0x2002
                && s[0] & 0xfff0 != 0x3ff0
        }
    }
}

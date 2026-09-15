use crate::Error;
use crate::LocalEnvironment;
use exec_server_protocol::ExecError;
use exec_server_protocol::Message;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use sha2::Digest;
use sha2::Sha256;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 32;

/// Authenticated loopback endpoint. Remote hosts are reached through a host-owned SSH/TLS tunnel.
/// The listener owns transport workers; environment resources survive individual connections.
pub struct ExecListener {
    address: SocketAddr,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ExecListener {
    pub fn bind(
        address: SocketAddr,
        token: &str,
        environment: Arc<LocalEnvironment>,
    ) -> Result<Self, Error> {
        if !address.ip().is_loopback() || !valid_token(token) {
            return Err(Error::Remote(ExecError::InvalidInput));
        }
        let listener = TcpListener::bind(address)?;
        let address = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let token_hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let worker = thread::Builder::new()
            .name("exec-listener".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                let mut workers = Vec::new();
                while !stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if active.load(Ordering::Acquire) >= MAX_CONNECTIONS {
                                drop(stream);
                                continue;
                            }
                            active.fetch_add(1, Ordering::AcqRel);
                            let active_count = active.clone();
                            let environment = environment.clone();
                            match thread::Builder::new().name("exec-connection".into()).spawn(
                                move || {
                                    let _ = serve(stream, token_hash, &environment);
                                    active_count.fetch_sub(1, Ordering::AcqRel);
                                },
                            ) {
                                Ok(worker) => workers.push(worker),
                                Err(_) => {
                                    active.fetch_sub(1, Ordering::AcqRel);
                                }
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                    let mut index = 0;
                    while index < workers.len() {
                        if workers[index].is_finished() {
                            let _ = workers.swap_remove(index).join();
                        } else {
                            index += 1;
                        }
                    }
                }
                for worker in workers {
                    let _ = worker.join();
                }
            })?;
        Ok(Self {
            address,
            stopped,
            worker: Some(worker),
        })
    }
    pub fn address(&self) -> SocketAddr {
        self.address
    }
}
impl Drop for ExecListener {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(crate) fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit())
}

fn serve(
    mut stream: TcpStream,
    hash: [u8; 32],
    environment: &LocalEnvironment,
) -> Result<(), Error> {
    configure(&stream)?;
    let message: Message = read_frame(&mut stream)?;
    let supplied: [u8; 32] = Sha256::digest(message.token.as_bytes()).into();
    let matches = hash
        .iter()
        .zip(supplied)
        .fold(0u8, |diff, (left, right)| diff | (*left ^ right))
        == 0;
    let response = if !matches {
        Response::Error(ExecError::Unauthorized)
    } else if message.version != exec_server_protocol::VERSION {
        Response::Error(ExecError::IncompatibleVersion)
    } else if !matches!(message.request, Request::EnvironmentInfo)
        && message.incarnation.as_deref() != Some(environment.info().incarnation.as_str())
    {
        Response::Error(ExecError::StaleEnvironment)
    } else {
        environment.request(message.request)
    };
    write_frame(&mut stream, &response)
}

pub(crate) fn configure(stream: &TcpStream) -> Result<(), Error> {
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.set_nodelay(true)?;
    Ok(())
}
pub(crate) fn read_frame<T: serde::de::DeserializeOwned>(
    stream: &mut TcpStream,
) -> Result<T, Error> {
    let mut bytes = Vec::new();
    BufReader::new(stream.take((exec_server_protocol::MAX_FRAME_BYTES + 1) as u64))
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > exec_server_protocol::MAX_FRAME_BYTES || bytes.last() != Some(&b'\n') {
        return Err(Error::Protocol);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)
}
pub(crate) fn write_frame<T: serde::Serialize>(
    stream: &mut TcpStream,
    value: &T,
) -> Result<(), Error> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| Error::Protocol)?;
    bytes.push(b'\n');
    if bytes.len() > exec_server_protocol::MAX_FRAME_BYTES {
        return Err(Error::Protocol);
    }
    stream.write_all(&bytes)?;
    Ok(())
}

// Licensed under the MIT License.
//! A leased account's fixed, firewall-approved port forwards to one execution proxy.

use super::win::Result;
use std::io;
use std::net::Shutdown;
use std::net::SocketAddrV4;
use std::net::TcpListener;
use std::net::TcpStream;
use std::os::windows::io::AsRawSocket;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

pub(super) struct Proxy {
    stop: Arc<AtomicBool>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
    thread: Option<JoinHandle<()>>,
}

impl Proxy {
    pub(super) fn start(
        port: u16,
        destination: u16,
        account: String,
        capability: String,
    ) -> Result<Self> {
        let socket = socket2::Socket::new(
            socket2::Domain::IPV4,
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        )
        .map_err(|error| error.to_string())?;
        let exclusive: i32 = 1;
        if unsafe {
            windows_sys::Win32::Networking::WinSock::setsockopt(
                socket.as_raw_socket() as usize,
                windows_sys::Win32::Networking::WinSock::SOL_SOCKET,
                windows_sys::Win32::Networking::WinSock::SO_EXCLUSIVEADDRUSE,
                (&exclusive as *const i32).cast(),
                size_of::<i32>() as i32,
            )
        } != 0
        {
            return Err("could not reserve the execution proxy port exclusively".into());
        }
        socket
            .bind(&SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, port).into())
            .map_err(|error| error.to_string())?;
        socket.listen(32).map_err(|error| error.to_string())?;
        let listener: TcpListener = socket.into();
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let sockets = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::clone(&stop);
        let held = Arc::clone(&sockets);
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut incoming, peer)) => {
                        let authorized = incoming
                            .local_addr()
                            .and_then(|local| {
                                super::attribution::connection_identity_for_tcp_connection(
                                    local, peer,
                                )
                            })
                            .is_ok_and(|identity| {
                                identity.user_sid == account
                                    && identity.restricting_sids.contains(&capability)
                            });
                        if !authorized {
                            continue;
                        }
                        // Accepted sockets inherit nonblocking mode on Windows.
                        // The forwarding workers use blocking io::copy.
                        if incoming.set_nonblocking(false).is_err() {
                            continue;
                        }
                        // Bound both threads and retained sockets for one execution.
                        if workers.len() >= 256 {
                            continue;
                        }
                        let mut outgoing = match TcpStream::connect_timeout(
                            &SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, destination).into(),
                            Duration::from_secs(2),
                        ) {
                            Ok(stream) => stream,
                            Err(error) => {
                                eprintln!("Ash proxy endpoint connection failed: {error}");
                                continue;
                            }
                        };
                        let (
                            Ok(mut read_incoming),
                            Ok(mut write_outgoing),
                            Ok(held_incoming),
                            Ok(held_outgoing),
                        ) = (
                            incoming.try_clone(),
                            outgoing.try_clone(),
                            incoming.try_clone(),
                            outgoing.try_clone(),
                        )
                        else {
                            continue;
                        };
                        held.lock().unwrap().extend([held_incoming, held_outgoing]);
                        workers.push(std::thread::spawn(move || {
                            let _ = io::copy(&mut read_incoming, &mut write_outgoing);
                            let _ = write_outgoing.shutdown(Shutdown::Write);
                        }));
                        workers.push(std::thread::spawn(move || {
                            let _ = io::copy(&mut outgoing, &mut incoming);
                            let _ = incoming.shutdown(Shutdown::Write);
                        }));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
            for socket in held.lock().unwrap().iter() {
                let _ = socket.shutdown(Shutdown::Both);
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        Ok(Self {
            stop,
            sockets,
            thread: Some(thread),
        })
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for socket in self.sockets.lock().unwrap().iter() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;

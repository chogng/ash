use std::ffi::OsString;
use std::io::Read;
use std::net::Ipv4Addr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::time::Duration;
use std::time::Instant;

use crate::ExtensionHostError;

/// A fresh binding is allocated before spawning the child; it is never a product credential.
/// The listener lives only until this incarnation connects. Loopback works for both Node kinds
/// and does not expose the control stream through stdin/stdout inherited by debug adapters.
pub(super) struct NodeControlBinding {
    listener: TcpListener,
    token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct LiveChild;

    impl ash_sandboxing::SandboxProcess for LiveChild {
        fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
            None
        }
        fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
            None
        }
        fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
            None
        }
        fn try_wait(
            &mut self,
        ) -> std::io::Result<Option<ash_sandboxing::SandboxProcessExitStatus>> {
            Ok(None)
        }
        fn close(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_wrong_local_peer_does_not_consume_the_child_binding() {
        let binding = NodeControlBinding::new().unwrap();
        let address = binding.listener.local_addr().unwrap();
        let token = binding.token.clone();
        let accepting = std::thread::spawn(move || {
            binding.accept(
                &mut ash_sandboxing::ProcessHandle::new(LiveChild),
                Duration::from_secs(1),
            )
        });
        let mut wrong = TcpStream::connect(address).unwrap();
        wrong
            .write_all(b"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n")
            .unwrap();
        drop(wrong);
        let mut child = TcpStream::connect(address).unwrap();
        child.write_all(format!("{token}\n").as_bytes()).unwrap();
        assert!(accepting.join().unwrap().is_ok());
        // The listener has retired; another local process cannot join this incarnation.
        assert!(TcpStream::connect(address).is_err());
    }

    #[test]
    fn an_incomplete_hello_cannot_hold_startup_past_the_deadline() {
        let binding = NodeControlBinding::new().unwrap();
        let peer = TcpStream::connect(binding.listener.local_addr().unwrap()).unwrap();
        let result = binding.accept(
            &mut ash_sandboxing::ProcessHandle::new(LiveChild),
            Duration::from_millis(20),
        );
        assert!(matches!(result, Err(ExtensionHostError::StartupTimedOut)));
        drop(peer);
    }
}

impl NodeControlBinding {
    pub(super) fn new() -> Result<Self, ExtensionHostError> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let mut random = [0_u8; 32];
        getrandom::getrandom(&mut random).map_err(|_| ExtensionHostError::SpawnFailed)?;
        let token = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self { listener, token })
    }

    pub(super) fn arguments(&self) -> Result<[OsString; 4], ExtensionHostError> {
        Ok([
            "--protocol-address".into(),
            self.listener.local_addr()?.to_string().into(),
            "--protocol-token".into(),
            self.token.clone().into(),
        ])
    }

    pub(super) fn accept(
        self,
        child: &mut ash_sandboxing::ProcessHandle,
        timeout: Duration,
    ) -> Result<TcpStream, ExtensionHostError> {
        let deadline = Instant::now() + timeout;
        loop {
            if child.try_wait()?.is_some() {
                return Err(ExtensionHostError::HostExited);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ExtensionHostError::StartupTimedOut);
            }
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    // Accepted sockets inherit the listener's nonblocking flag on macOS.
                    stream.set_nonblocking(false)?;
                    // A local peer cannot hold startup indefinitely with an incomplete hello.
                    stream.set_read_timeout(Some(remaining.min(Duration::from_millis(100))))?;
                    let mut hello = [0_u8; 65];
                    if stream.read_exact(&mut hello).is_err()
                        || hello[64] != b'\n'
                        || hello[..64] != *self.token.as_bytes()
                    {
                        continue;
                    }
                    stream.set_read_timeout(None)?;
                    stream.set_nodelay(true)?;
                    return Ok(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(remaining.min(Duration::from_millis(5)));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

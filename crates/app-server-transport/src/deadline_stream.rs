use std::io;
use std::io::Read;
use std::io::Write;
use std::time::Instant;

use ash_uds::IpcStream;
#[cfg(unix)]
use rustix::event::PollFd;
#[cfg(unix)]
use rustix::event::PollFlags;
#[cfg(unix)]
use rustix::event::Timespec;
#[cfg(unix)]
use rustix::event::poll;

/// Applies one request deadline without Unix socket timeout options, which macOS can reject.
pub struct DeadlineStream {
    stream: IpcStream,
    deadline: Option<Instant>,
}

impl DeadlineStream {
    /// Wraps a local connection with an absolute read and write deadline.
    pub fn new(stream: IpcStream, deadline: Instant) -> io::Result<Self> {
        configure_deadline(&stream, deadline)?;
        Ok(Self {
            stream,
            deadline: Some(deadline),
        })
    }

    /// Restores ordinary blocking IO after the bounded exchange completes.
    pub fn clear_deadline(&mut self) -> io::Result<()> {
        clear_deadline(&self.stream)?;
        self.deadline = None;
        Ok(())
    }

    /// Clones the underlying connection for independent shutdown ownership.
    pub fn try_clone(&self) -> io::Result<IpcStream> {
        self.stream.try_clone()
    }

    #[cfg(windows)]
    fn wait_for_ready(&self, readers: &[&IpcStream], writers: &[&IpcStream]) -> io::Result<()> {
        let remaining = self
            .deadline
            .and_then(|deadline| deadline.checked_duration_since(Instant::now()))
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(deadline_elapsed)?;
        ash_uds::wait_for_ipc_activity(None, readers, writers, remaining)
    }

    #[cfg(unix)]
    fn wait_for_ready(&self, events: PollFlags) -> io::Result<()> {
        let deadline = self
            .deadline
            .ok_or_else(|| io::Error::other("socket deadline is not configured"))?;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(deadline_elapsed)?;
            let timeout = Timespec::try_from(remaining).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "socket deadline is out of range",
                )
            })?;
            let mut descriptor = PollFd::new(&self.stream, events);
            match poll(std::slice::from_mut(&mut descriptor), Some(&timeout)) {
                Ok(0) => return Err(deadline_elapsed()),
                Ok(_) => {
                    let ready = descriptor.revents();
                    if ready.contains(PollFlags::NVAL) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "socket descriptor is invalid",
                        ));
                    }
                    if ready.intersects(events | PollFlags::ERR | PollFlags::HUP) {
                        return Ok(());
                    }
                }
                Err(error) if error == rustix::io::Errno::INTR => {}
                Err(error) => return Err(io::Error::from(error)),
            }
        }
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.deadline.is_none() {
            return self.stream.read(buffer);
        }
        #[cfg(unix)]
        loop {
            self.wait_for_ready(PollFlags::IN)?;
            match self.stream.read(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => return result,
            }
        }
        #[cfg(windows)]
        loop {
            self.wait_for_ready(&[&self.stream], &[])?;
            match self.stream.read(buffer) {
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                result => return result,
            }
        }
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.deadline.is_none() {
            return self.stream.write(buffer);
        }
        #[cfg(unix)]
        loop {
            self.wait_for_ready(PollFlags::OUT)?;
            match self.stream.write(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => return result,
            }
        }
        #[cfg(windows)]
        loop {
            self.wait_for_ready(&[], &[&self.stream])?;
            match self.stream.write(buffer) {
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.deadline.is_none() {
            return self.stream.flush();
        }
        #[cfg(unix)]
        self.wait_for_ready(PollFlags::OUT)?;
        self.stream.flush()
    }
}

fn configure_deadline(stream: &IpcStream, _deadline: Instant) -> io::Result<()> {
    stream.set_nonblocking(true)
}

fn clear_deadline(stream: &IpcStream) -> io::Result<()> {
    stream.set_nonblocking(false)
}

fn deadline_elapsed() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "socket deadline elapsed")
}

#[cfg(test)]
#[path = "deadline_stream_tests.rs"]
mod tests;

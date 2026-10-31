use std::io;
use std::time::Duration;

use super::pipe::Direction;

pub(crate) fn wait_for_ipc_activity(
    listener: Option<&crate::IpcListener>,
    readers: &[&crate::IpcStream],
    writers: &[&crate::IpcStream],
    timeout: Duration,
) -> io::Result<()> {
    if listener.is_none() && readers.is_empty() && writers.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "IPC wait requires an endpoint",
        ));
    }
    match super::reactor::wait(Some(timeout), || {
        listener.is_some_and(|listener| listener.ready())
            || readers.iter().any(|stream| stream.ready(Direction::Read))
            || writers.iter().any(|stream| stream.ready(Direction::Write))
    }) {
        Err(error) if error.kind() == io::ErrorKind::TimedOut => Ok(()),
        result => result,
    }
}

use std::io;
use std::os::windows::io::AsRawSocket;
use std::time::Duration;

use windows_sys::Win32::Networking::WinSock::POLLNVAL;
use windows_sys::Win32::Networking::WinSock::POLLRDNORM;
use windows_sys::Win32::Networking::WinSock::POLLWRNORM;
use windows_sys::Win32::Networking::WinSock::SOCKET_ERROR;
use windows_sys::Win32::Networking::WinSock::WSAEINTR;
use windows_sys::Win32::Networking::WinSock::WSAGetLastError;
use windows_sys::Win32::Networking::WinSock::WSAPOLLFD;
use windows_sys::Win32::Networking::WinSock::WSAPoll;

pub(crate) fn wait_for_socket_activity(
    listener: Option<&crate::UnixListener>,
    readers: &[&crate::UnixStream],
    writers: &[&crate::UnixStream],
    timeout: Duration,
) -> io::Result<()> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "socket wait is out of range");
    // Round up a fractional millisecond so a short deadline never becomes a busy poll.
    let milliseconds =
        i32::try_from(timeout.as_nanos().div_ceil(1_000_000)).map_err(|_| invalid())?;
    let mut descriptors =
        Vec::with_capacity(usize::from(listener.is_some()) + readers.len() + writers.len());
    let descriptor = |socket, events| WSAPOLLFD {
        fd: socket,
        events,
        revents: 0,
    };
    if let Some(listener) = listener {
        descriptors.push(descriptor(listener.as_raw_socket() as _, POLLRDNORM));
    }
    descriptors.extend(
        readers
            .iter()
            .map(|stream| descriptor(stream.as_raw_socket() as _, POLLRDNORM)),
    );
    descriptors.extend(
        writers
            .iter()
            .map(|stream| descriptor(stream.as_raw_socket() as _, POLLWRNORM)),
    );
    let count = u32::try_from(descriptors.len()).map_err(|_| invalid())?;
    if count == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socket wait requires a socket",
        ));
    }
    // The vector owns count initialized descriptors and the borrowed sockets outlive this call.
    if unsafe { WSAPoll(descriptors.as_mut_ptr(), count, milliseconds) } == SOCKET_ERROR {
        let error = unsafe { WSAGetLastError() };
        if error != WSAEINTR {
            return Err(io::Error::from_raw_os_error(error));
        }
    }
    if descriptors
        .iter()
        .any(|descriptor| descriptor.revents & POLLNVAL != 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socket descriptor is invalid",
        ));
    }
    Ok(())
}

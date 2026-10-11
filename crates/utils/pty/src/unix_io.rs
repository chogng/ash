use std::fs::File;
use std::io;
use std::io::Read;
use std::io::Write;
use std::os::fd::BorrowedFd;
use std::os::fd::RawFd;
use std::sync::Arc;

use rustix::fs::OFlags;
use rustix::fs::fcntl_getfl;
use rustix::fs::fcntl_setfl;
use rustix::termios::SpecialCodeIndex;
use rustix::termios::tcgetattr;
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub(crate) struct PtyIo {
    fd: Arc<AsyncFd<File>>,
}

impl PtyIo {
    pub(crate) fn new(master_fd: RawFd) -> io::Result<Self> {
        // The PTY owner remains alive while its descriptor is duplicated.
        let fd = unsafe { BorrowedFd::borrow_raw(master_fd) }.try_clone_to_owned()?;
        fcntl_setfl(&fd, fcntl_getfl(&fd)? | OFlags::NONBLOCK)?;
        // Duplicates share O_NONBLOCK, so both reads and writes must use readiness.
        // Async tasks can be aborted even when a detached child keeps the PTY open
        // or the output channel is full; blocking read/send tasks cannot.
        // AsyncFd panics if the current runtime has no I/O driver.
        let fd = std::panic::catch_unwind(move || AsyncFd::new(File::from(fd)))
            .map_err(|_| io::Error::other("PTY I/O requires a Tokio runtime with I/O enabled"))??;
        Ok(Self { fd: Arc::new(fd) })
    }

    pub(crate) fn spawn(
        self,
        stdout_tx: mpsc::Sender<Vec<u8>>,
        mut writer_rx: mpsc::Receiver<Vec<u8>>,
    ) -> (JoinHandle<()>, JoinHandle<()>) {
        let fd = self.fd;
        let reader = Arc::clone(&fd);
        let reader_handle = tokio::spawn(async move {
            let mut buf = [0u8; 8_192];
            loop {
                match reader
                    .async_io(Interest::READABLE, |mut file| file.read(&mut buf))
                    .await
                {
                    Ok(0) => break,
                    Ok(count) => {
                        // Output caps may close the receiver before the child exits.
                        let _ = stdout_tx.send(buf[..count].to_vec()).await;
                    }
                    Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                    // Unix PTYs may report EIO rather than EOF when the slave closes.
                    Err(_) => break,
                }
            }
        });
        let writer_handle = tokio::spawn(async move {
            while let Some(bytes) = writer_rx.recv().await {
                if write_all(&fd, &bytes).await.is_err() {
                    return;
                }
            }
            // Preserve portable-pty's newline + current VEOF on stdin close,
            // including when the terminal input queue requires waiting.
            if let Ok(termios) = tcgetattr(fd.get_ref()) {
                let eof = termios.special_codes[SpecialCodeIndex::VEOF];
                if eof != 0 {
                    let _ = write_all(&fd, &[b'\n', eof]).await;
                }
            }
        });
        (reader_handle, writer_handle)
    }
}

async fn write_all(fd: &AsyncFd<File>, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        match fd
            .async_io(Interest::WRITABLE, |mut file| file.write(bytes))
            .await
        {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

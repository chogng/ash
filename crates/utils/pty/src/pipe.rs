#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::sync::atomic::AtomicBool;

#[cfg(all(test, windows))]
#[path = "pipe_tests.rs"]
mod tests;

#[cfg(windows)]
/// A Windows pipe reader whose owner can stop reads even while another process holds a writer.
/// Only this reader may consume bytes from the supplied pipe.
pub struct CancellablePipeReader {
    stdout: std::process::ChildStdout,
    closing: Arc<AtomicBool>,
}

#[cfg(windows)]
impl CancellablePipeReader {
    /// Wraps one owned output pipe and the connection's shared closing flag.
    pub fn new(stdout: std::process::ChildStdout, closing: Arc<AtomicBool>) -> Self {
        Self { stdout, closing }
    }
}

#[cfg(windows)]
impl std::io::Read for CancellablePipeReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::os::windows::io::AsRawHandle;
        use winapi::um::namedpipeapi::PeekNamedPipe;

        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.closing.load(std::sync::atomic::Ordering::Acquire) {
                return Ok(0);
            }
            let mut available = 0;
            // ChildStdout owns this readable pipe; this driver is its only reader.
            let success = unsafe {
                PeekNamedPipe(
                    self.stdout.as_raw_handle().cast(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if success == 0 {
                let error = std::io::Error::last_os_error();
                return if error.kind() == std::io::ErrorKind::BrokenPipe {
                    Ok(0)
                } else {
                    Err(error)
                };
            }
            if available > 0 {
                let length = buffer.len().min(available as usize);
                return self.stdout.read(&mut buffer[..length]);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

use std::io;

pub(super) fn acquire(_: &str) -> io::Result<Box<dyn Send>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "idle-sleep inhibition is unavailable on this platform",
    ))
}

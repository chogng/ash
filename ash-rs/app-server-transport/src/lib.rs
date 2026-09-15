//! Local connection lifecycle and bounded message transport for the App Server.

mod browser;
mod deadline_stream;
mod local_socket;
mod websocket;
pub use browser::BrowserListener;
pub use browser::BrowserOptions;
pub use browser::start_browser_listener;

pub use deadline_stream::DeadlineStream;
pub use local_socket::LocalConnectionGuard;
pub use local_socket::LocalConnections;
pub use local_socket::LocalSocketAccept;
pub use local_socket::PollingLocalListener;
pub use local_socket::validate_local_peer;
pub use websocket::CapabilityTokenSha256;
pub use websocket::StartedWebSocketListener;
pub use websocket::WebSocketReader;
pub use websocket::WebSocketWriter;
pub use websocket::parse_loopback_websocket_bind;
pub use websocket::start_websocket_acceptor;

use std::io;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;

/// Maximum JSONL frame size shared by both ends of the local App Server transport.
///
/// An editor file is capped at 50 MiB before serialization, while JSON escaping can
/// expand one UTF-8 byte to six wire bytes. Keep the transport bound large enough
/// to carry that validated payload without making framing unbounded.
pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 320 * 1024 * 1024;

/// Relays an open response stream without retaining bytes until connection close.
pub fn relay_output(reader: &mut impl Read, writer: &mut impl Write) -> io::Result<()> {
    let mut buffer = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if read == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..read])?;
        writer.flush()?;
    }
}

/// A JSON Lines transport whose read and write operations enforce the negotiated message limit.
pub struct JsonlTransport<R, W> {
    reader: JsonlReader<R>,
    writer: JsonlWriter<W>,
}

impl<R: BufRead, W: Write> JsonlTransport<R, W> {
    pub fn new(reader: R, writer: W, max_message_bytes: usize) -> Self {
        Self {
            reader: JsonlReader::new(reader, max_message_bytes),
            writer: JsonlWriter::new(writer, max_message_bytes),
        }
    }

    pub fn read_message(&mut self) -> io::Result<Option<String>> {
        self.reader.read_message()
    }

    pub fn write_message(&mut self, message: &str) -> io::Result<()> {
        self.writer.write_message(message)
    }
}

/// The bounded read half of a JSON Lines transport.
pub struct JsonlReader<R> {
    reader: R,
    max_message_bytes: usize,
}

impl<R: BufRead> JsonlReader<R> {
    pub fn new(reader: R, max_message_bytes: usize) -> Self {
        Self {
            reader,
            max_message_bytes,
        }
    }

    pub fn read_message(&mut self) -> io::Result<Option<String>> {
        let mut bytes = Vec::new();
        let read = self.reader.read_until(b'\n', &mut bytes)?;
        if read == 0 {
            return Ok(None);
        }
        if bytes.len() > self.max_message_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON-RPC message exceeds limit",
            ));
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        String::from_utf8(bytes).map(Some).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "JSON-RPC message is not UTF-8")
        })
    }
}

/// The bounded single-writer half of a JSON Lines transport.
pub struct JsonlWriter<W> {
    writer: W,
    max_message_bytes: usize,
}

impl<W: Write> JsonlWriter<W> {
    pub fn new(writer: W, max_message_bytes: usize) -> Self {
        Self {
            writer,
            max_message_bytes,
        }
    }

    pub fn write_message(&mut self, message: &str) -> io::Result<()> {
        if message.len() > self.max_message_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON-RPC message exceeds limit",
            ));
        }
        self.writer.write_all(message.as_bytes())?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()
    }
}

pub struct StdioTransport;
impl StdioTransport {
    pub fn listen_uri() -> &'static str {
        "stdio://"
    }
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod relay_tests;

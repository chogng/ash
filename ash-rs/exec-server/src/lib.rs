//! Local and remote execution environments beneath the product business backend.

mod client;
mod environment;
mod process;
pub mod terminal;
mod transport;

pub use client::ExecClient;
pub use client::RemoteEndpoint;
pub use environment::ExecutionEnvironment;
pub use environment::LocalEnvironment;
pub use transport::ExecListener;

use exec_server_protocol::ExecError;
use std::fmt;

#[derive(Debug)]
pub enum Error {
    Remote(ExecError),
    Transport(std::io::Error),
    Protocol,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Remote(error) => write!(f, "execution rejected: {error:?}"),
            Self::Transport(error) => write!(f, "execution connection failed: {error}"),
            Self::Protocol => f.write_str("invalid execution response"),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Transport(value)
    }
}

pub(crate) fn random_id() -> Result<String, Error> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::Protocol)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

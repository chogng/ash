use ash_protocol::ContentDigest;
use std::fmt;
use std::path::PathBuf;

#[derive(Debug)]
pub enum LocalTokenizerError {
    MissingRevision,
    ReadAsset {
        path: PathBuf,
        source: std::io::Error,
    },
    DigestMismatch {
        path: PathBuf,
        expected: ContentDigest,
        actual: ContentDigest,
    },
    InvalidTokenizer {
        path: PathBuf,
        message: String,
    },
    InvalidTemplate {
        path: PathBuf,
        message: String,
    },
    DuplicateBinding(String),
    DuplicateManifest(String),
    InvalidCacheRoot,
    InvalidAssetUrl,
    Download(String),
    DownloadStatus {
        url: String,
        status: u16,
    },
    Discovery(String),
    PublishAsset {
        path: PathBuf,
        source: std::io::Error,
    },
    Render(String),
    Encode(String),
}

impl fmt::Display for LocalTokenizerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRevision => {
                formatter.write_str("tokenizer asset revision must not be empty")
            }
            Self::ReadAsset { path, source } => {
                write!(
                    formatter,
                    "failed to read tokenizer asset {}: {source}",
                    path.display()
                )
            }
            Self::DigestMismatch {
                path,
                expected,
                actual,
            } => write!(
                formatter,
                "tokenizer asset {} digest mismatch: expected {expected}, got {actual}",
                path.display()
            ),
            Self::InvalidTokenizer { path, message } => write!(
                formatter,
                "invalid tokenizer asset {}: {message}",
                path.display()
            ),
            Self::InvalidTemplate { path, message } => write!(
                formatter,
                "invalid chat template asset {}: {message}",
                path.display()
            ),
            Self::DuplicateBinding(model) => {
                write!(
                    formatter,
                    "local tokenizer is already registered for {model}"
                )
            }
            Self::DuplicateManifest(model) => {
                write!(
                    formatter,
                    "tokenizer asset manifest is already registered for {model}"
                )
            }
            Self::InvalidCacheRoot => formatter.write_str("tokenizer cache root must not be empty"),
            Self::InvalidAssetUrl => {
                formatter.write_str("tokenizer asset URL must use HTTP or HTTPS")
            }
            Self::Download(message) => {
                write!(formatter, "tokenizer asset download failed: {message}")
            }
            Self::DownloadStatus { url, status } => {
                write!(
                    formatter,
                    "tokenizer asset download from {url} returned HTTP {status}"
                )
            }
            Self::Discovery(message) => {
                write!(formatter, "tokenizer asset discovery failed: {message}")
            }
            Self::PublishAsset { path, source } => write!(
                formatter,
                "failed to publish tokenizer asset {}: {source}",
                path.display()
            ),
            Self::Render(message) => write!(formatter, "chat template could not render: {message}"),
            Self::Encode(message) => {
                write!(formatter, "rendered prompt could not be encoded: {message}")
            }
        }
    }
}

impl std::error::Error for LocalTokenizerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ReadAsset { source, .. } | Self::PublishAsset { source, .. } => Some(source),
            _ => None,
        }
    }
}

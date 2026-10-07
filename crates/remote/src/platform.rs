use std::fmt;

/// A processor architecture supported by the POSIX SSH Remote runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteArchitecture {
    Aarch64,
    X86_64,
}

impl RemoteArchitecture {
    /// Returns the architecture component used by Rust target triples.
    pub const fn target_component(self) -> &'static str {
        match self {
            Self::Aarch64 => "aarch64",
            Self::X86_64 => "x86_64",
        }
    }
}

/// The C runtime selected by one Linux Remote package.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteLinuxLibc {
    Gnu,
    Musl,
}

/// A supported POSIX Remote platform and its exact package target.
///
/// Constructors keep impossible combinations out of the model: macOS has no Linux libc choice,
/// while Linux always identifies the package ABI as GNU or musl.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemotePlatform {
    Linux {
        architecture: RemoteArchitecture,
        libc: RemoteLinuxLibc,
    },
    MacOs {
        architecture: RemoteArchitecture,
    },
}

impl RemotePlatform {
    /// Parses one exact target emitted by the canonical Ash package builder.
    pub const fn from_target_triple(target: &str) -> Option<Self> {
        match target.as_bytes() {
            b"aarch64-unknown-linux-gnu" => Some(Self::linux(
                RemoteArchitecture::Aarch64,
                RemoteLinuxLibc::Gnu,
            )),
            b"aarch64-unknown-linux-musl" => Some(Self::linux(
                RemoteArchitecture::Aarch64,
                RemoteLinuxLibc::Musl,
            )),
            b"x86_64-unknown-linux-gnu" => Some(Self::linux(
                RemoteArchitecture::X86_64,
                RemoteLinuxLibc::Gnu,
            )),
            b"x86_64-unknown-linux-musl" => Some(Self::linux(
                RemoteArchitecture::X86_64,
                RemoteLinuxLibc::Musl,
            )),
            b"aarch64-apple-darwin" => Some(Self::mac_os(RemoteArchitecture::Aarch64)),
            b"x86_64-apple-darwin" => Some(Self::mac_os(RemoteArchitecture::X86_64)),
            _ => None,
        }
    }

    /// Creates a Linux package target with an explicit libc ABI.
    pub const fn linux(architecture: RemoteArchitecture, libc: RemoteLinuxLibc) -> Self {
        Self::Linux { architecture, libc }
    }

    /// Creates a macOS package target.
    pub const fn mac_os(architecture: RemoteArchitecture) -> Self {
        Self::MacOs { architecture }
    }

    /// Returns the architecture shared by platform probing and artifact selection.
    pub const fn architecture(self) -> RemoteArchitecture {
        match self {
            Self::Linux { architecture, .. } | Self::MacOs { architecture } => architecture,
        }
    }

    /// Returns the exact Rust target used by the canonical Ash package builder.
    pub const fn target_triple(self) -> &'static str {
        match self {
            Self::Linux {
                architecture: RemoteArchitecture::Aarch64,
                libc: RemoteLinuxLibc::Gnu,
            } => "aarch64-unknown-linux-gnu",
            Self::Linux {
                architecture: RemoteArchitecture::Aarch64,
                libc: RemoteLinuxLibc::Musl,
            } => "aarch64-unknown-linux-musl",
            Self::Linux {
                architecture: RemoteArchitecture::X86_64,
                libc: RemoteLinuxLibc::Gnu,
            } => "x86_64-unknown-linux-gnu",
            Self::Linux {
                architecture: RemoteArchitecture::X86_64,
                libc: RemoteLinuxLibc::Musl,
            } => "x86_64-unknown-linux-musl",
            Self::MacOs {
                architecture: RemoteArchitecture::Aarch64,
            } => "aarch64-apple-darwin",
            Self::MacOs {
                architecture: RemoteArchitecture::X86_64,
            } => "x86_64-apple-darwin",
        }
    }
}

impl fmt::Display for RemotePlatform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.target_triple())
    }
}

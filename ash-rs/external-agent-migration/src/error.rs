use std::fmt;
use std::io;

use crate::import::{ExternalAgent, ImportScope};

/// Failure to validate a caller-selected external configuration root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentImportError {
    RootUnavailable {
        agent: ExternalAgent,
        scope: ImportScope,
        error_kind: io::ErrorKind,
    },
    RootNotDirectory {
        agent: ExternalAgent,
        scope: ImportScope,
    },
    RootSymlinkNotAllowed {
        agent: ExternalAgent,
        scope: ImportScope,
    },
}

impl fmt::Display for AgentImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootUnavailable {
                agent,
                scope,
                error_kind,
            } => write!(
                formatter,
                "{agent:?} {scope:?} import root is unavailable ({error_kind:?})"
            ),
            Self::RootNotDirectory { agent, scope } => {
                write!(
                    formatter,
                    "{agent:?} {scope:?} import root is not a directory"
                )
            }
            Self::RootSymlinkNotAllowed { agent, scope } => write!(
                formatter,
                "{agent:?} {scope:?} import root cannot be a symbolic link"
            ),
        }
    }
}

impl std::error::Error for AgentImportError {}

use super::SessionExecutionTarget;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

/// Version 1 of an optional Session runtime's public DataChannel contract.
/// Workspace is a host directory; execution paths only come from the selected Provider.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum SessionRuntimeRequest {
    /// Product-owned target inventory, including stopped sources eligible for removal.
    List,
    Probe {
        workspace: PathBuf,
    },
    Prepare {
        workspace: PathBuf,
    },
    Stop {
        workspace: PathBuf,
    },
    Remove {
        workspace: PathBuf,
    },
}

/// Capability absence is distinct from an operation failure, which uses the RPC error channel.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SessionRuntimeResult {
    Targets {
        targets: Vec<SessionExecutionTarget>,
    },
    Availability {
        available: bool,
    },
    Target {
        target: SessionExecutionTarget,
    },
    Released,
}

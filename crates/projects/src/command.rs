use crate::ProjectRoot;
use ash_file_access::DirId;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ProjectCommand {
    Create {
        name: String,
        description: String,
    },
    UpdateDetails {
        name: String,
        description: String,
    },
    AddRoot {
        root: ProjectRoot,
    },
    UpdateRootDetails {
        dir_id: DirId,
        name: String,
        purpose: String,
    },
    RemoveRoot {
        dir_id: DirId,
    },
    LinkSession {
        session_id: SessionId,
    },
    UnlinkSession {
        session_id: SessionId,
    },
    Archive,
    Restore,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommandRequest {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    pub expected_revision: u64,
    pub command: ProjectCommand,
}

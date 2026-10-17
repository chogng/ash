use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Extension-owned view model. Transport response normalization stays in `api`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub conflicted: bool,
    pub submodule: Submodule,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub is_submodule: bool,
    pub commit_changed: bool,
    pub tracked_changes: bool,
    pub untracked_changes: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Head {
    Branch {
        name: String,
        #[serde(rename = "objectId")]
        object_id: String,
        upstream: Option<Upstream>,
    },
    Detached {
        #[serde(rename = "objectId")]
        object_id: String,
    },
    Unborn {
        name: String,
    },
}
impl Head {
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Branch { name, .. } | Self::Unborn { name } => Some(name),
            _ => None,
        }
    }
    pub fn object_id(&self) -> Option<&str> {
        match self {
            Self::Branch { object_id, .. } | Self::Detached { object_id } => Some(object_id),
            _ => None,
        }
    }
    pub fn upstream(&self) -> Option<&Upstream> {
        if let Self::Branch { upstream, .. } = self {
            upstream.as_ref()
        } else {
            None
        }
    }
    pub fn same_target(&self, other: &Self) -> bool {
        self.name() == other.name() && self.object_id() == other.object_id()
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Upstream {
    pub name: String,
    pub ahead: usize,
    pub behind: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub repository_id: String,
    pub stream_instance_id: String,
    pub revision: u64,
    pub history_revision: u64,
    pub path: String,
    pub head: Head,
    pub changes: Vec<Change>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDescriptor {
    pub id: String,
    pub label: String,
    pub path: String,
    pub dir_id: Option<String>,
    pub parent_path: Option<String>,
}
#[derive(Clone, Default)]
pub struct Configuration(pub Value);
impl Configuration {
    pub fn value(&self, key: &str) -> &Value {
        if let Some(value) = self.0.get(key) {
            return value;
        }
        key.split('.')
            .try_fold(&self.0, |value, segment| value.get(segment))
            .unwrap_or(&Value::Null)
    }
    pub fn boolean(&self, key: &str, default: bool) -> bool {
        self.value(key).as_bool().unwrap_or(default)
    }
    pub fn number(&self, key: &str, default: u64) -> u64 {
        self.value(key).as_u64().unwrap_or(default)
    }
    pub fn text<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.value(key).as_str().unwrap_or(default)
    }
    pub fn strings(&self, key: &str) -> Vec<String> {
        self.value(key)
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    }
}
#[derive(Clone)]
pub struct Repository {
    pub descriptor: RepositoryDescriptor,
    pub root_uri: String,
    pub configuration: Configuration,
    pub status: Option<Status>,
    pub catalog: Option<Catalog>,
    pub draft: String,
    pub input_revision: u64,
    pub operation: Option<RepositoryOperation>,
    pub error: String,
    /// The message editor's intent stays attached to the HEAD at which it was opened.
    pub commit_editor_head: Option<Head>,
    pub blame: Option<Blame>,
    pub pending_paths: Option<PendingPaths>,
    pub retired_streams: BTreeSet<String>,
}

/// Backend-owned remote facts retained with the extension's repository snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub remotes: Vec<String>,
    #[serde(default)]
    pub upstream_read_only: bool,
}
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum RepositoryOperation {
    Preparing,
    Synchronize,
    Other,
}
impl Repository {
    pub fn is_busy(&self) -> bool {
        self.operation.is_some()
    }
}
#[derive(Clone, PartialEq)]
pub struct Blame {
    pub label: String,
    pub details: String,
}

#[derive(Default)]
pub struct State {
    pub repositories: BTreeMap<String, Repository>,
    pub active: Option<String>,
    pub selection_revision: u64,
    pub folders: Vec<Value>,
    pub sequence: u64,
    pub revision: u64,
    pub configuration: Configuration,
    pub active_line_signature: String,
    pub installation_signature: Option<Value>,
    pub installation_available: bool,
    pub discovery_signature: Option<Value>,
    pub parent_prompts: BTreeSet<String>,
    pub discovery_result: Vec<RepositoryDescriptor>,
}

#[derive(Clone)]
pub struct PendingPaths {
    pub operation: PathOperation,
    pub paths: BTreeSet<String>,
}
#[derive(Clone, Copy)]
pub enum PathOperation {
    Stage,
    Unstage,
}

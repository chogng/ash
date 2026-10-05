use crate::PluginPath;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

use super::ManifestLocalId;

/// Editor Extension launch target declared by one immutable Plugin package.
///
/// The package-owned program implements Ash Host RPC directly. This declaration does not prove
/// that the regular file is executable on the current platform. A product supervisor checks
/// launchability, starts it out of process, enforces the runtime API, and projects registrations.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorExtensionContribution {
    pub id: ManifestLocalId,
    pub entrypoint: PluginPath,
    pub runtime_api_version: EditorExtensionRuntimeApiVersion,
    pub activation_events: Vec<EditorExtensionActivationEvent>,
    pub capabilities: Vec<EditorExtensionCapability>,
}

/// Version of the out-of-process Editor Extension runtime API requested by an entry point.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EditorExtensionRuntimeApiVersion {
    V1,
}

impl EditorExtensionRuntimeApiVersion {
    pub const fn as_u16(self) -> u16 {
        match self {
            Self::V1 => 1,
        }
    }
}

impl Serialize for EditorExtensionRuntimeApiVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u16(self.as_u16())
    }
}

impl<'de> Deserialize<'de> for EditorExtensionRuntimeApiVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match u16::deserialize(deserializer)? {
            1 => Ok(Self::V1),
            version => Err(serde::de::Error::custom(format!(
                "unsupported Editor Extension runtimeApiVersion {version}; expected 1"
            ))),
        }
    }
}

/// A bounded trigger that may cause the Extension Host to activate an entry point.
///
/// Provider capability and activation are intentionally separate. For example, a debug adapter may
/// activate on demand, while its permission ceiling is still `DebugAdapter`.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum EditorExtensionActivationEvent {
    Startup,
    OnCommand {
        id: String,
    },
    OnLanguage {
        id: String,
    },
    OnDemand {
        capability: EditorExtensionCapability,
    },
    OnDebugType {
        #[serde(rename = "debugType")]
        debug_type: String,
    },
    OnTaskType {
        #[serde(rename = "taskType")]
        task_type: String,
    },
    OnTestProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
    },
}

impl EditorExtensionActivationEvent {
    pub(crate) const fn required_capability(&self) -> Option<EditorExtensionCapability> {
        match self {
            Self::Startup => None,
            Self::OnCommand { .. } => Some(EditorExtensionCapability::Command),
            Self::OnLanguage { .. } => Some(EditorExtensionCapability::LanguageProvider),
            Self::OnDemand { capability } => Some(*capability),
            Self::OnDebugType { .. } => Some(EditorExtensionCapability::DebugAdapter),
            Self::OnTaskType { .. } => Some(EditorExtensionCapability::TaskProvider),
            Self::OnTestProfile { .. } => Some(EditorExtensionCapability::TestProfileProvider),
        }
    }
}

/// Maximum provider kinds that one executable entry point may register with the host.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorExtensionCapability {
    Command,
    LanguageProvider,
    DebugAdapter,
    TaskProvider,
    TestProfileProvider,
    DataChannel,
    LinkPresentationProvider,
    ExternalUriOpener,
}

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::mpsc;

use ash_utils_path::write_atomically;
use serde::Deserialize;
use serde::Serialize;

use crate::CapabilityRef;
use crate::PackageRef;

// Increment when the executable API's authority ceiling changes. A package digest alone
// must not let an old consent acquire newly introduced host capabilities.
const CONTRACT_VERSION: u16 = 5;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EditorExtensionPolicyAction {
    Enable,
    Disable,
    Grant,
    Revoke,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EditorExtensionPolicyError {
    InvalidBinding,
    RevisionConflict,
    Storage,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EditorExtensionPolicySnapshot {
    pub revision: u64,
    pub enabled: bool,
    pub granted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    package: PackageRef,
    contract_version: u16,
    enabled: bool,
    granted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Durable {
    schema_version: u32,
    revision: u64,
    records: BTreeMap<String, Record>,
}

struct State {
    durable: Durable,
    subscribers: Vec<mpsc::Sender<u64>>,
}

/// Profile-owned execution consent for exact Marketplace editor artifacts. Package installation
/// and capability leases remain with Manager; this owner never mutates the verified package.
pub struct EditorExtensionPolicy {
    path: PathBuf,
    state: Mutex<State>,
}

impl EditorExtensionPolicy {
    pub fn open(path: PathBuf) -> Result<Self, EditorExtensionPolicyError> {
        let durable = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 4 * 1024 * 1024 => {
                serde_json::from_slice::<Durable>(&bytes)
                    .map_err(|_| EditorExtensionPolicyError::Storage)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Durable {
                schema_version: 1,
                revision: 1,
                records: BTreeMap::new(),
            },
            _ => return Err(EditorExtensionPolicyError::Storage),
        };
        if durable.schema_version != 1
            || durable.revision == 0
            || durable.revision > 9_007_199_254_740_991
            || durable.records.len() > 1024
            || durable.records.iter().any(|(key, record)| {
                !valid_binding(&record.package, &CapabilityRef { id: key.clone() })
            })
        {
            return Err(EditorExtensionPolicyError::Storage);
        }
        Ok(Self {
            path,
            state: Mutex::new(State {
                durable,
                subscribers: Vec::new(),
            }),
        })
    }

    pub fn generation(&self) -> u64 {
        self.state
            .lock()
            .expect("editor policy poisoned")
            .durable
            .revision
    }

    pub fn subscribe(&self) -> mpsc::Receiver<u64> {
        let (sender, receiver) = mpsc::channel();
        self.state
            .lock()
            .expect("editor policy poisoned")
            .subscribers
            .push(sender);
        receiver
    }

    pub fn snapshot(
        &self,
        package: &PackageRef,
        capability: &CapabilityRef,
    ) -> EditorExtensionPolicySnapshot {
        let state = self.state.lock().expect("editor policy poisoned");
        let record = state.durable.records.get(&capability.id).filter(|record| {
            record.package == *package && record.contract_version == CONTRACT_VERSION
        });
        EditorExtensionPolicySnapshot {
            revision: state.durable.revision,
            enabled: record.is_some_and(|record| record.enabled),
            granted: record.is_some_and(|record| record.granted),
        }
    }

    pub fn set(
        &self,
        package: &PackageRef,
        capability: &CapabilityRef,
        action: EditorExtensionPolicyAction,
        expected_revision: u64,
    ) -> Result<EditorExtensionPolicySnapshot, EditorExtensionPolicyError> {
        if !valid_binding(package, capability) {
            return Err(EditorExtensionPolicyError::InvalidBinding);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| EditorExtensionPolicyError::Storage)?;
        if expected_revision != state.durable.revision {
            return Err(EditorExtensionPolicyError::RevisionConflict);
        }
        let mut next = state.durable.clone();
        if next.records.len() >= 1024 && !next.records.contains_key(&capability.id) {
            return Err(EditorExtensionPolicyError::Storage);
        }
        let record = next
            .records
            .entry(capability.id.clone())
            .or_insert_with(|| Record {
                package: package.clone(),
                contract_version: CONTRACT_VERSION,
                enabled: false,
                granted: false,
            });
        if record.package != *package {
            return Err(EditorExtensionPolicyError::InvalidBinding);
        }
        if record.contract_version != CONTRACT_VERSION {
            record.contract_version = CONTRACT_VERSION;
            record.enabled = false;
            record.granted = false;
        }
        match action {
            EditorExtensionPolicyAction::Enable => record.enabled = true,
            EditorExtensionPolicyAction::Disable => record.enabled = false,
            EditorExtensionPolicyAction::Grant => record.granted = true,
            EditorExtensionPolicyAction::Revoke => record.granted = false,
        }
        let enabled = record.enabled;
        let granted = record.granted;
        next.revision = next
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= 9_007_199_254_740_991)
            .ok_or(EditorExtensionPolicyError::Storage)?;
        let bytes = serde_json::to_vec(&next).map_err(|_| EditorExtensionPolicyError::Storage)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(EditorExtensionPolicyError::Storage);
        }
        std::fs::create_dir_all(
            self.path
                .parent()
                .ok_or(EditorExtensionPolicyError::Storage)?,
        )
        .map_err(|_| EditorExtensionPolicyError::Storage)?;
        write_atomically(&self.path, &bytes).map_err(|_| EditorExtensionPolicyError::Storage)?;
        let revision = next.revision;
        state.durable = next;
        // Publish after durable commit. The subscribed fleet cancels old invocations and
        // retires their processes before a policy RPC reports successful revocation.
        state
            .subscribers
            .retain(|sender| sender.send(revision).is_ok());
        Ok(EditorExtensionPolicySnapshot {
            revision,
            enabled,
            granted,
        })
    }
}

fn valid_binding(package: &PackageRef, capability: &CapabilityRef) -> bool {
    !capability.id.is_empty()
        && capability.id.len() <= 512
        && ash_plugin::PluginId::parse(&package.id).is_ok()
        && ash_plugin::PluginVersion::new(&package.version).is_ok()
        && ash_plugin::PluginPackageDigest::new(&package.digest).is_ok()
}

#[cfg(test)]
#[path = "editor_extension_policy_tests.rs"]
mod tests;

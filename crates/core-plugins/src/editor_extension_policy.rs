use std::collections::BTreeMap;
use std::collections::BTreeSet;
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
const CONTRACT_VERSION: u16 = 6;

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
    granted: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Durable {
    schema_version: u32,
    revision: u64,
    records: BTreeMap<String, Record>,
    disabled_extensions: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRecord {
    package: PackageRef,
    contract_version: u16,
    enabled: bool,
    granted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDurable {
    schema_version: u32,
    revision: u64,
    records: BTreeMap<String, LegacyRecord>,
}

struct State {
    durable: Durable,
    subscribers: Vec<mpsc::Sender<u64>>,
}

/// Profile-owned editor enablement and execution consent for exact Extensions artifacts. Installation
/// and capability leases remain with Manager; this owner never mutates the verified package.
pub struct EditorExtensionPolicy {
    path: PathBuf,
    state: Mutex<State>,
}

impl EditorExtensionPolicy {
    /// Reads whole-extension enablement without granting execution authority.
    pub fn is_extension_enabled(&self, id: &str) -> bool {
        !self
            .state
            .lock()
            .expect("editor policy poisoned")
            .durable
            .disabled_extensions
            .contains(id)
    }

    /// Persists enablement for a product-registered built-in runtime; executable admission remains with its host.
    pub fn set_built_in_enablement(
        &self,
        id: &str,
        action: EditorExtensionPolicyAction,
        expected_revision: u64,
    ) -> Result<EditorExtensionPolicySnapshot, EditorExtensionPolicyError> {
        if !valid_built_in_id(id)
            || matches!(
                action,
                EditorExtensionPolicyAction::Grant | EditorExtensionPolicyAction::Revoke
            )
        {
            return Err(EditorExtensionPolicyError::InvalidBinding);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| EditorExtensionPolicyError::Storage)?;
        if state.durable.revision != expected_revision {
            return Err(EditorExtensionPolicyError::RevisionConflict);
        }
        let mut next = state.durable.clone();
        match action {
            EditorExtensionPolicyAction::Enable => {
                next.disabled_extensions.remove(id);
            }
            EditorExtensionPolicyAction::Disable => {
                if next.disabled_extensions.len() >= 1024 && !next.disabled_extensions.contains(id)
                {
                    return Err(EditorExtensionPolicyError::Storage);
                }
                next.disabled_extensions.insert(id.into());
            }
            EditorExtensionPolicyAction::Grant | EditorExtensionPolicyAction::Revoke => {
                return Err(EditorExtensionPolicyError::InvalidBinding);
            }
        }
        let enabled = !next.disabled_extensions.contains(id);
        let revision = self.commit(&mut state, next)?;
        Ok(EditorExtensionPolicySnapshot {
            revision,
            enabled,
            granted: false,
        })
    }

    pub fn open(path: PathBuf) -> Result<Self, EditorExtensionPolicyError> {
        let durable = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 4 * 1024 * 1024 => {
                let value: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| EditorExtensionPolicyError::Storage)?;
                if value
                    .get("schemaVersion")
                    .and_then(serde_json::Value::as_u64)
                    == Some(1)
                {
                    let legacy: LegacyDurable = serde_json::from_value(value)
                        .map_err(|_| EditorExtensionPolicyError::Storage)?;
                    if legacy.schema_version != 1 {
                        return Err(EditorExtensionPolicyError::Storage);
                    }
                    let disabled_extensions = legacy
                        .records
                        .values()
                        .filter(|record| !record.enabled)
                        .map(|record| record.package.id.clone())
                        .collect();
                    Durable {
                        schema_version: 2,
                        revision: legacy.revision,
                        disabled_extensions,
                        records: legacy
                            .records
                            .into_iter()
                            .map(|(key, record)| {
                                (
                                    key,
                                    Record {
                                        package: record.package,
                                        contract_version: record.contract_version,
                                        granted: record.granted,
                                    },
                                )
                            })
                            .collect(),
                    }
                } else {
                    serde_json::from_value(value)
                        .map_err(|_| EditorExtensionPolicyError::Storage)?
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Durable {
                schema_version: 2,
                revision: 1,
                records: BTreeMap::new(),
                disabled_extensions: BTreeSet::new(),
            },
            _ => return Err(EditorExtensionPolicyError::Storage),
        };
        if durable.schema_version != 2
            || durable.revision == 0
            || durable.revision > 9_007_199_254_740_991
            || durable.records.len() > 1024
            || durable.disabled_extensions.len() > 1024
            || durable
                .disabled_extensions
                .iter()
                .any(|id| ash_utils_plugins::PluginId::parse(id).is_err() && !valid_built_in_id(id))
            || durable.records.iter().any(|(key, record)| {
                !valid_binding(&record.package, &CapabilityRef { id: key.clone() })
            })
        {
            return Err(EditorExtensionPolicyError::Storage);
        }
        let policy = Self {
            path,
            state: Mutex::new(State {
                durable,
                subscribers: Vec::new(),
            }),
        };
        {
            let mut state = policy
                .state
                .lock()
                .map_err(|_| EditorExtensionPolicyError::Storage)?;
            // The Ash Rust adapter changed publisher. Preserve an existing disablement
            // before the catalog resolves its new identity; never migrate execution consent.
            if state.durable.disabled_extensions.contains("vscode.rust") {
                let mut next = state.durable.clone();
                next.disabled_extensions.remove("vscode.rust");
                next.disabled_extensions.insert("ash.rust".into());
                policy.commit(&mut state, next)?;
            }
        }
        Ok(policy)
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
            enabled: !state.durable.disabled_extensions.contains(&package.id),
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
                granted: false,
            });
        if record.package != *package {
            return Err(EditorExtensionPolicyError::InvalidBinding);
        }
        if record.contract_version != CONTRACT_VERSION {
            record.contract_version = CONTRACT_VERSION;
            record.granted = false;
        }
        match action {
            EditorExtensionPolicyAction::Enable => {
                next.disabled_extensions.remove(&package.id);
            }
            EditorExtensionPolicyAction::Disable => {
                if next.disabled_extensions.len() >= 1024
                    && !next.disabled_extensions.contains(&package.id)
                {
                    return Err(EditorExtensionPolicyError::Storage);
                }
                next.disabled_extensions.insert(package.id.clone());
            }
            EditorExtensionPolicyAction::Grant => record.granted = true,
            EditorExtensionPolicyAction::Revoke => record.granted = false,
        }
        let granted = record.granted;
        let enabled = !next.disabled_extensions.contains(&package.id);
        let revision = self.commit(&mut state, next)?;
        Ok(EditorExtensionPolicySnapshot {
            revision,
            enabled,
            granted,
        })
    }

    fn commit(
        &self,
        state: &mut State,
        mut next: Durable,
    ) -> Result<u64, EditorExtensionPolicyError> {
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
        Ok(revision)
    }
}

fn valid_built_in_id(id: &str) -> bool {
    id.len() <= 160
        && id.split_once('.').is_some_and(|(publisher, name)| {
            [publisher, name].into_iter().all(|part| {
                !part.is_empty()
                    && part.bytes().all(|byte| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || matches!(byte, b'-' | b'_')
                    })
            })
        })
}

fn valid_binding(package: &PackageRef, capability: &CapabilityRef) -> bool {
    !capability.id.is_empty()
        && capability.id.len() <= 512
        && ash_utils_plugins::PluginId::parse(&package.id).is_ok()
        && ash_plugin::PluginVersion::new(&package.version).is_ok()
        && ash_plugin::PluginPackageDigest::new(&package.digest).is_ok()
}

#[cfg(test)]
#[path = "editor_extension_policy_tests.rs"]
mod tests;

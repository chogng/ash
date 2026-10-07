use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::RwLock;

use lsp_types::Registration;
use lsp_types::Unregistration;
use serde_json::Value;

const MAX_DYNAMIC_REGISTRATIONS: usize = 256;
const MAX_REGISTRATION_ID_BYTES: usize = 512;
const MAX_REGISTRATION_OPTIONS_BYTES: usize = 256 * 1024;

/// One server-created capability registration retained for the current server incarnation.
#[derive(Clone, Debug, PartialEq)]
pub struct LanguageServerDynamicRegistration {
    pub id: String,
    pub method: String,
    pub register_options: Option<Value>,
}

/// Immutable view of the dynamic capabilities for one initialized server incarnation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LanguageServerCapabilitySnapshot {
    pub revision: u64,
    pub registrations: Vec<LanguageServerDynamicRegistration>,
}

#[derive(Clone, Default)]
pub(crate) struct DynamicCapabilityRegistry {
    inner: Arc<RwLock<DynamicCapabilityState>>,
}

#[derive(Default)]
struct DynamicCapabilityState {
    revision: u64,
    registrations: BTreeMap<(String, String), LanguageServerDynamicRegistration>,
}

impl DynamicCapabilityRegistry {
    pub(crate) fn snapshot(&self) -> LanguageServerCapabilitySnapshot {
        let state = self.inner.read().expect("dynamic capability registry lock");
        LanguageServerCapabilitySnapshot {
            revision: state.revision,
            registrations: state.registrations.values().cloned().collect(),
        }
    }

    pub(crate) fn supports(&self, method: &str) -> bool {
        self.inner
            .read()
            .expect("dynamic capability registry lock")
            .registrations
            .keys()
            .any(|(registered_method, _)| registered_method == method)
    }

    pub(crate) fn register(
        &self,
        registrations: Vec<Registration>,
    ) -> Result<LanguageServerCapabilitySnapshot, String> {
        if registrations.is_empty() {
            return Err("capability registration batch must not be empty".into());
        }
        let mut state = self
            .inner
            .write()
            .expect("dynamic capability registry lock");
        if state
            .registrations
            .len()
            .saturating_add(registrations.len())
            > MAX_DYNAMIC_REGISTRATIONS
        {
            return Err(format!(
                "a server incarnation cannot own more than {MAX_DYNAMIC_REGISTRATIONS} dynamic capabilities"
            ));
        }
        let mut additions = Vec::with_capacity(registrations.len());
        for registration in registrations {
            validate_registration(&registration)?;
            let key = (registration.method.clone(), registration.id.clone());
            if state.registrations.contains_key(&key)
                || additions
                    .iter()
                    .any(|(candidate, _): &((String, String), _)| candidate == &key)
            {
                return Err(format!(
                    "dynamic capability '{}' already contains registration '{}'",
                    registration.method, registration.id
                ));
            }
            additions.push((
                key,
                LanguageServerDynamicRegistration {
                    id: registration.id,
                    method: registration.method,
                    register_options: registration.register_options,
                },
            ));
        }
        for (key, registration) in additions {
            state.registrations.insert(key, registration);
        }
        state.revision = state.revision.saturating_add(1).max(1);
        Ok(snapshot_from_state(&state))
    }

    pub(crate) fn unregister(
        &self,
        unregisterations: Vec<Unregistration>,
    ) -> Result<LanguageServerCapabilitySnapshot, String> {
        if unregisterations.is_empty() {
            return Err("capability unregistration batch must not be empty".into());
        }
        for unregistration in &unregisterations {
            validate_registration_identity(&unregistration.id, &unregistration.method)?;
        }
        let mut state = self
            .inner
            .write()
            .expect("dynamic capability registry lock");
        let mut changed = false;
        for unregistration in unregisterations {
            changed |= state
                .registrations
                .remove(&(unregistration.method, unregistration.id))
                .is_some();
        }
        if changed {
            state.revision = state.revision.saturating_add(1).max(1);
        }
        Ok(snapshot_from_state(&state))
    }
}

fn snapshot_from_state(state: &DynamicCapabilityState) -> LanguageServerCapabilitySnapshot {
    LanguageServerCapabilitySnapshot {
        revision: state.revision,
        registrations: state.registrations.values().cloned().collect(),
    }
}

fn validate_registration(registration: &Registration) -> Result<(), String> {
    validate_registration_identity(&registration.id, &registration.method)?;
    if registration
        .register_options
        .as_ref()
        .is_some_and(|options| {
            serde_json::to_vec(options)
                .map_or(true, |bytes| bytes.len() > MAX_REGISTRATION_OPTIONS_BYTES)
        })
    {
        return Err(format!(
            "dynamic capability '{}' registration options exceed {MAX_REGISTRATION_OPTIONS_BYTES} bytes",
            registration.method
        ));
    }
    Ok(())
}

fn validate_registration_identity(id: &str, method: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_REGISTRATION_ID_BYTES || id.contains('\0') {
        return Err(format!(
            "dynamic capability registration id must contain 1 to {MAX_REGISTRATION_ID_BYTES} bytes"
        ));
    }
    if !supported_dynamic_method(method) {
        return Err(format!(
            "dynamic capability method '{method}' is not supported by this client"
        ));
    }
    Ok(())
}

fn supported_dynamic_method(method: &str) -> bool {
    matches!(
        method,
        "textDocument/hover"
            | "textDocument/completion"
            | "textDocument/signatureHelp"
            | "textDocument/declaration"
            | "textDocument/definition"
            | "textDocument/typeDefinition"
            | "textDocument/implementation"
            | "textDocument/references"
            | "textDocument/formatting"
            | "textDocument/rangeFormatting"
            | "textDocument/codeAction"
            | "textDocument/rename"
            | "textDocument/linkedEditingRange"
            | "textDocument/prepareCallHierarchy"
            | "textDocument/prepareTypeHierarchy"
            | "textDocument/semanticTokens"
            | "textDocument/documentSymbol"
            | "textDocument/codeLens"
            | "textDocument/documentLink"
            | "textDocument/documentColor"
            | "textDocument/foldingRange"
            | "textDocument/inlayHint"
            | "textDocument/diagnostic"
            | "workspace/symbol"
            | "workspace/executeCommand"
    )
}

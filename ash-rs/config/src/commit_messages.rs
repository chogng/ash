use ash_file_access::DirId;
use ash_model_provider_config::ModelProviderConfig;
use ash_protocol::ModelRef;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Exact model and endpoint configuration authorized to receive one Directory's source text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitMessageEgressGrant {
    pub model: ModelRef,
    pub provider: ModelProviderConfig,
}

/// Directory-scoped authorization for automatic commit-message generation.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitMessageConfig {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub source_egress_grants: BTreeMap<DirId, CommitMessageEgressGrant>,
}

impl CommitMessageConfig {
    /// Returns the selected model only when the Directory grant still matches model and endpoint.
    pub fn authorized_model<'a>(
        &self,
        dir: &DirId,
        model: Option<&'a ModelRef>,
        providers: &BTreeMap<ash_protocol::ProviderId, ModelProviderConfig>,
    ) -> Option<&'a ModelRef> {
        let model = model?;
        let provider = providers.get(&model.provider)?;
        self.source_egress_grants
            .get(dir)
            .filter(|grant| grant.model == *model && grant.provider == *provider)
            .map(|_| model)
    }

    pub(crate) fn authorize(
        &mut self,
        dir: DirId,
        model: Option<&ModelRef>,
        providers: &BTreeMap<ash_protocol::ProviderId, ModelProviderConfig>,
    ) -> Result<(), &'static str> {
        let model = model
            .cloned()
            .ok_or("commit-message model is not configured")?;
        let provider = providers
            .get(&model.provider)
            .cloned()
            .ok_or("commit-message model provider is not configured")?;
        self.source_egress_grants
            .insert(dir, CommitMessageEgressGrant { model, provider });
        Ok(())
    }

    pub(crate) fn revoke(&mut self, dir: &DirId) {
        self.source_egress_grants.remove(dir);
    }

    pub(crate) fn revoke_all(&mut self) {
        self.source_egress_grants.clear();
    }
}

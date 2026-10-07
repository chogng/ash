//! Host-owned Git authorship policy contributed at each model invocation.
use extension_api::ExtensionError;
use extension_api::ExtensionRegistryBuilder;
use extension_api::PromptFragment;
use extension_api::PromptFragmentLayer;
use extension_api::PromptFragmentRetention;
use extension_api::PromptFragmentSource;
use extension_api::TurnInputContext;
use extension_api::TurnInputContributor;
use std::sync::Arc;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum GitAttributionPolicy {
    #[default]
    Disabled,
    Enabled {
        co_author: String,
        pull_request_notice: String,
    },
}
impl GitAttributionPolicy {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        if let Self::Enabled {
            co_author,
            pull_request_notice,
        } = self
        {
            if co_author.is_empty()
                || co_author.len() > 256
                || co_author.chars().any(char::is_control)
                || !co_author.ends_with('>')
                || !co_author.contains(" <")
                || !co_author.contains('@')
                || pull_request_notice.trim().is_empty()
                || pull_request_notice.len() > 1024
                || pull_request_notice.chars().any(char::is_control)
            {
                return Err(ExtensionError::new(
                    "Git attribution requires a bounded author identity and plain-text PR notice",
                ));
            }
        }
        Ok(())
    }
}
/// Resolves trusted product or organization policy for the current task.
/// Implementations must refresh account-dependent policy when account authority changes.
pub trait GitAttributionPolicySource: Send + Sync {
    fn policy(
        &self,
        context: &TurnInputContext<'_>,
    ) -> Result<GitAttributionPolicy, ExtensionError>;
}
impl GitAttributionPolicySource for GitAttributionPolicy {
    fn policy(&self, _: &TurnInputContext<'_>) -> Result<GitAttributionPolicy, ExtensionError> {
        self.validate()?;
        Ok(self.clone())
    }
}
struct GitAttributionExtension(Arc<dyn GitAttributionPolicySource>);
/// Installs a policy source; disabled policy emits no instructions.
pub fn install(
    builder: &mut ExtensionRegistryBuilder,
    source: Arc<dyn GitAttributionPolicySource>,
) {
    builder.turn_input_contributor("git-attribution", Arc::new(GitAttributionExtension(source)));
}
impl TurnInputContributor for GitAttributionExtension {
    fn contribute(
        &self,
        context: TurnInputContext<'_>,
    ) -> Result<Vec<PromptFragment>, ExtensionError> {
        let policy = self.0.policy(&context)?;
        policy.validate()?;
        let GitAttributionPolicy::Enabled {
            co_author,
            pull_request_notice,
        } = policy
        else {
            return Ok(Vec::new());
        };
        Ok(vec![PromptFragment::new(
            PromptFragmentSource::new("git-attribution", "authorship", "v1"),
            PromptFragmentLayer::Product,
            PromptFragmentRetention::Required,
            format!(
                "When the user authorizes creating a Git commit, include the exact trailer: Co-authored-by: {co_author}\nWhen the user authorizes creating a pull request, include this notice in its description: {pull_request_notice}\nThis policy does not authorize creating commits, pushing, or opening pull requests."
            ),
        )])
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;

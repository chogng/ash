//! Account-owned speed access. Model declarations describe capability, not subscription permission.

use crate::ChatGptAccount;
use crate::ChatGptError;
use crate::ChatGptOAuth;
use crate::credential::AccountIdentity;
use ash_async_utils::CancellationToken;
use backend_client::chatgpt::ConfigBundle;
use backend_client::chatgpt::DeliveredToml;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

const ACCESS_FRESH_FOR: Duration = Duration::from_secs(300);

/// Confirmed account permissions; absence means they have not been observed for this account.
/// These permissions are never saved in the user's provider configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChatGptSpeedAccess {
    pub fast: Option<bool>,
    pub ultrafast: Option<bool>,
}

#[derive(Clone, Eq, PartialEq)]
struct SpeedIdentity {
    account: AccountIdentity,
    plan: Option<String>,
    is_fedramp: bool,
}

pub(crate) struct SpeedObservation {
    identity: SpeedIdentity,
    access: ChatGptSpeedAccess,
    observed: Instant,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Plan {
    Pro100,
    Pro200,
    Pro500,
    Business,
    Enterprise,
    Edu,
    Other,
}

impl Plan {
    fn from_raw(raw: Option<&str>) -> Self {
        // Preserve the upstream raw identifiers: "pro" is the $200 plan, not every Pro plan.
        match raw {
            Some("prolite") => Self::Pro100,
            Some("pro") => Self::Pro200,
            Some("promax") => Self::Pro500,
            Some(
                "team"
                | "business"
                | "self_serve_business_prolite"
                | "self_serve_business_usage_based",
            ) => Self::Business,
            Some(
                "enterprise"
                | "hc"
                | "ent26"
                | "enterprise_cbp_automation"
                | "enterprise_cbp_usage_based",
            ) => Self::Enterprise,
            Some("edu" | "education" | "edu_plus" | "edu_pro") => Self::Edu,
            _ => Self::Other,
        }
    }

    fn needs_policy(self) -> bool {
        matches!(
            self,
            Self::Pro500 | Self::Business | Self::Enterprise | Self::Edu
        )
    }

    fn unobserved(self) -> ChatGptSpeedAccess {
        ChatGptSpeedAccess {
            fast: if self.needs_policy() {
                None
            } else {
                Some(true)
            },
            ultrafast: if matches!(self, Self::Pro500 | Self::Enterprise | Self::Edu) {
                None
            } else {
                Some(false)
            },
        }
    }
}

impl ChatGptOAuth {
    fn speed_identity(&self) -> Result<Option<SpeedIdentity>, ChatGptError> {
        let Some(execution) = self.model_execution_identity()? else {
            return Ok(None);
        };
        let credential = self
            .load_credential()?
            .ok_or_else(|| ChatGptError::new("ChatGPT account disappeared"))?;
        let account = credential.identity()?;
        if execution != format!("{}\0{}", account.user_id, account.account_id) {
            return Err(ChatGptError::new("ChatGPT account changed"));
        }
        Ok(Some(SpeedIdentity {
            account,
            plan: credential.plan.clone(),
            is_fedramp: credential.is_fedramp,
        }))
    }

    /// Catalog observations are isolated across both account changes and subscription changes.
    pub fn model_catalog_identity(&self) -> Result<Option<String>, ChatGptError> {
        Ok(self.speed_identity()?.map(|identity| {
            format!(
                "{}\0{}\0{}\0{}",
                identity.account.user_id,
                identity.account.account_id,
                identity.plan.as_deref().unwrap_or(""),
                identity.is_fedramp
            )
        }))
    }

    /// Reads current permissions without network I/O; expired workspace grants remain unknown.
    pub fn speed_access(&self) -> Result<ChatGptSpeedAccess, ChatGptError> {
        let Some(identity) = self.speed_identity()? else {
            return Ok(ChatGptSpeedAccess {
                fast: None,
                ultrafast: None,
            });
        };
        let plan = Plan::from_raw(identity.plan.as_deref());
        let observation = self
            .speed_access
            .lock()
            .map_err(|_| ChatGptError::new("ChatGPT speed access is unavailable"))?;
        if let Some(observation) = observation.as_ref()
            && observation.identity == identity
            && observation.observed.elapsed() < ACCESS_FRESH_FOR
        {
            return Ok(observation.access);
        }
        Ok(plan.unobserved())
    }

    /// Refreshes cloud-managed speed requirements alongside model discovery. The account API
    /// owns authentication recovery; the observer's next refresh observes permission revocation.
    pub fn refresh_speed_access(
        self: &Arc<Self>,
        cancellation: &CancellationToken,
    ) -> Result<(), ChatGptError> {
        let identity = self
            .speed_identity()?
            .ok_or_else(|| ChatGptError::new("ChatGPT account is unavailable"))?;
        let plan = Plan::from_raw(identity.plan.as_deref());
        let access = if plan.needs_policy() {
            let bundle = ChatGptAccount::new(Arc::clone(self))
                .read_config_bundle(&identity.account.account_id, cancellation)
                .map_err(|error| ChatGptError::new(error.to_string()))?;
            let requirements = speed_requirements(&bundle)?;
            ChatGptSpeedAccess {
                fast: Some(requirements.fast.unwrap_or(true)),
                // An Enterprise/Edu plan alone does not prove eligible billing, residency or
                // administrator access. Only an explicit account-bound grant enables that tier.
                ultrafast: Some(match plan {
                    Plan::Pro500 => requirements.ultrafast.unwrap_or(true),
                    Plan::Enterprise | Plan::Edu => requirements.ultrafast == Some(true),
                    Plan::Business | Plan::Pro100 | Plan::Pro200 | Plan::Other => false,
                }),
            }
        } else {
            plan.unobserved()
        };
        if self.speed_identity()?.as_ref() != Some(&identity) {
            return Err(ChatGptError::new(
                "ChatGPT plan or account changed during speed discovery",
            ));
        }
        *self
            .speed_access
            .lock()
            .map_err(|_| ChatGptError::new("ChatGPT speed access is unavailable"))? =
            Some(SpeedObservation {
                identity,
                access,
                observed: Instant::now(),
            });
        Ok(())
    }
}

#[derive(Default)]
struct SpeedRequirements {
    fast: Option<bool>,
    ultrafast: Option<bool>,
}

fn speed_requirements(bundle: &ConfigBundle) -> Result<SpeedRequirements, ChatGptError> {
    let mut result = SpeedRequirements::default();
    if let Some(document) = &bundle.requirements_toml {
        merge_requirements(&mut result, document)?;
    }
    Ok(result)
}

fn merge_requirements(
    result: &mut SpeedRequirements,
    document: &DeliveredToml,
) -> Result<(), ChatGptError> {
    // Enterprise fragments are delivered highest-priority first. System overlays precede
    // baseline policy; a lower-priority fragment cannot override an explicit decision.
    let fragments = document.enterprise_managed.iter().flatten().chain(
        document
            .managed_layers
            .iter()
            .flat_map(|layers| layers.system_overlay.iter().chain(&layers.baseline)),
    );
    for fragment in fragments {
        let value: toml::Value = toml::from_str(&fragment.contents)
            .map_err(|_| ChatGptError::new("Invalid ChatGPT speed requirements"))?;
        let Some(features) = value.get("features") else {
            continue;
        };
        let features = features
            .as_table()
            .ok_or_else(|| ChatGptError::new("Invalid ChatGPT speed requirements"))?;
        let read = |name| match features.get(name) {
            None => Ok(None),
            Some(toml::Value::Boolean(value)) => Ok(Some(*value)),
            Some(_) => Err(ChatGptError::new("Invalid ChatGPT speed requirements")),
        };
        let fast = read("fast_mode")?;
        let mut ultrafast = read("ultrafast_mode")?;
        // The old account permission denied both accelerated modes through this one fragment.
        if fragment.id == "rbac-fast-mode" && fast == Some(false) {
            ultrafast = Some(false);
        }
        result.fast = result.fast.or(fast);
        result.ultrafast = result.ultrafast.or(ultrafast);
    }
    Ok(())
}

#[cfg(test)]
#[path = "speed_tests.rs"]
mod tests;

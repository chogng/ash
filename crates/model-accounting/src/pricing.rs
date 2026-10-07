use crate::AccountingError;
use crate::ApiOperationId;
use crate::BillingPlatformId;
use crate::BillingRegionId;
use crate::ModelBillingContext;
use crate::ModelReferenceCost;
use crate::PricingVariantId;
use crate::RateCard;
use crate::RateSelector;
use crate::ServiceTierEvidence;
use crate::ServiceTierId;
use crate::TokenQuantities;
use crate::UnpricedReason;
use ash_protocol::ModelBillingEvidence;
use ash_protocol::ModelBillingRecord;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelReferenceCostRecord;
use ash_protocol::ModelResponseBilling;
use ash_protocol::ModelUsage;

/// Pricing output ready to embed in one durable invocation fact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvocationPrice {
    pub resolved_model: Option<ModelId>,
    pub billing: Option<ModelBillingRecord>,
    pub reference_cost: ModelReferenceCostRecord,
}

impl RateCard {
    /// Prices one invocation made against a verified first-party public API surface.
    pub fn price_invocation(
        &self,
        requested_model: Option<&ModelRef>,
        response_billing: Option<&ModelResponseBilling>,
        scope: ModelBillingScope,
        usage: Option<&ModelUsage>,
        started_at_unix_ms: u64,
    ) -> Result<InvocationPrice, AccountingError> {
        match scope {
            ModelBillingScope::SubscriptionPlan => {
                return Ok(unpriced(UnpricedReason::SubscriptionPlan));
            }
            ModelBillingScope::Unavailable => {
                return Ok(unpriced(UnpricedReason::MissingBillingContext));
            }
            ModelBillingScope::PublicApi => {}
        }
        let Some(requested_model) = requested_model else {
            return Ok(unpriced(UnpricedReason::MissingBillingContext));
        };
        let fixed_identity = requested_model.provider.as_str() == "kimi"
            && requested_model.model.as_str() == "kimi-k2.7-code-highspeed";
        let resolved_model = if fixed_identity {
            requested_model.model.clone()
        } else if let Some(model) =
            response_billing.and_then(|billing| billing.resolved_model.clone())
        {
            model
        } else if requested_model.provider.as_str() == "openai"
            && requested_model.model.as_str() == "gpt-5.6"
        {
            return Ok(unpriced(UnpricedReason::UnresolvedModelAlias));
        } else {
            requested_model.model.clone()
        };
        let Some((billing_platform, default_service_tier)) =
            public_api_dimensions(&requested_model.provider)
        else {
            return Ok(unpriced(UnpricedReason::MissingRate));
        };
        let service_tier = response_billing
            .and_then(|billing| billing.applied_service_tier.as_deref())
            .unwrap_or(default_service_tier);
        let Some(usage) = usage else {
            return Ok(unpriced(UnpricedReason::MissingUsage));
        };
        let Some(input_tokens) = usage.input_tokens else {
            return Ok(unpriced(UnpricedReason::MissingUsage));
        };
        let started_at_unix_ms =
            i64::try_from(started_at_unix_ms).map_err(|_| AccountingError::ArithmeticOverflow)?;
        let selector = RateSelector::new(
            requested_model.provider.clone(),
            BillingPlatformId::new(billing_platform)?,
            resolved_model.clone(),
            ApiOperationId::new("text_generation")?,
            ServiceTierId::new(service_tier)?,
            BillingRegionId::new("global")?,
            PricingVariantId::new("default")?,
        );
        let context = ModelBillingContext::new(
            selector,
            if response_billing
                .and_then(|billing| billing.applied_service_tier.as_ref())
                .is_some()
            {
                ServiceTierEvidence::ResponseField
            } else if fixed_identity {
                ServiceTierEvidence::FixedModelIdentity
            } else {
                ServiceTierEvidence::AcceptedRequest
            },
            input_tokens,
            started_at_unix_ms,
        );
        let quantities = TokenQuantities::from_model_usage(usage)?;
        let reference_cost = self.rate(&context, &quantities)?.to_record();
        Ok(InvocationPrice {
            resolved_model: Some(resolved_model),
            billing: Some(ModelBillingRecord {
                billing_platform: billing_platform.into(),
                operation: "text_generation".into(),
                requested_service_tier: None,
                applied_service_tier: service_tier.into(),
                service_tier_evidence: if response_billing
                    .and_then(|billing| billing.applied_service_tier.as_ref())
                    .is_some()
                {
                    ModelBillingEvidence::ResponseField
                } else if fixed_identity {
                    ModelBillingEvidence::FixedModelIdentity
                } else {
                    ModelBillingEvidence::AcceptedRequest
                },
                region: "global".into(),
                pricing_variant: "default".into(),
                rate_card_revision: self.revision().to_string(),
            }),
            reference_cost,
        })
    }
}

fn public_api_dimensions(
    provider: &ash_protocol::ProviderId,
) -> Option<(&'static str, &'static str)> {
    match provider.as_str() {
        "openai" => Some(("openai_api", "default")),
        "google" => Some(("gemini_api", "standard")),
        "xai" => Some(("xai_api", "default")),
        "kimi" => Some(("kimi_api", "standard")),
        _ => None,
    }
}

fn unpriced(reason: UnpricedReason) -> InvocationPrice {
    InvocationPrice {
        resolved_model: None,
        billing: None,
        reference_cost: ModelReferenceCost::Unpriced { reason }.to_record(),
    }
}

use crate::AccountingError;
use crate::ApiOperationId;
use crate::BillingPlatformId;
use crate::BillingRegionId;
use crate::IncompleteCostReason;
use crate::ModelBillingContext;
use crate::ModelReferenceCost;
use crate::PricingVariantId;
use crate::RateCard;
use crate::RateSelector;
use crate::ServiceTierEvidence;
use crate::ServiceTierId;
use crate::TokenDimension;
use crate::TokenQuantities;
use crate::UnpricedReason;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelReferenceCostRecord;
use ash_protocol::ModelResponseBilling;
use ash_protocol::ModelUsage;
use ash_protocol::ProviderId;

const TEST_RATE_CARD: &str = r#"
{
  "schemaVersion": 1,
  "revision": "official-2026-09-04",
  "reviewedAt": "2026-09-04",
  "sourceUrls": ["https://developers.openai.com/api/docs/pricing"],
  "rules": [
    {
      "selector": {
        "provider": "openai",
        "billingPlatform": "openai_api",
        "model": "gpt-5.6-sol",
        "operation": "text_generation",
        "serviceTier": "default",
        "region": "global",
        "pricingVariant": "default"
      },
      "inputRange": { "minInclusive": 0, "maxExclusive": 272001 },
      "currency": "USD",
      "rates": {
        "uncached_input_tokens": "4.00",
        "cached_input_tokens": "0.40",
        "cache_write_input_tokens": "5.00",
        "output_tokens": "20.00"
      }
    },
    {
      "selector": {
        "provider": "openai",
        "billingPlatform": "openai_api",
        "model": "gpt-5.6-sol",
        "operation": "text_generation",
        "serviceTier": "default",
        "region": "global",
        "pricingVariant": "default"
      },
      "inputRange": { "minInclusive": 272001 },
      "currency": "USD",
      "rates": {
        "uncached_input_tokens": "8.00",
        "cached_input_tokens": "0.80",
        "cache_write_input_tokens": "10.00",
        "output_tokens": "30.00"
      }
    },
    {
      "selector": {
        "provider": "openai",
        "billingPlatform": "openai_api",
        "model": "gpt-5.6-sol",
        "operation": "text_generation",
        "serviceTier": "priority",
        "region": "global",
        "pricingVariant": "default"
      },
      "inputRange": { "minInclusive": 0, "maxExclusive": 272001 },
      "currency": "USD",
      "rates": {
        "uncached_input_tokens": "8.00",
        "cached_input_tokens": "0.80",
        "cache_write_input_tokens": "10.00",
        "output_tokens": "40.00"
      }
    },
    {
      "selector": {
        "provider": "kimi",
        "billingPlatform": "kimi_api",
        "model": "kimi-k2.7-code-highspeed",
        "operation": "text_generation",
        "serviceTier": "standard",
        "region": "global",
        "pricingVariant": "default"
      },
      "currency": "USD",
      "rates": {
        "uncached_input_tokens": "1.90",
        "cached_input_tokens": "0.38",
        "cache_write_input_tokens": "0",
        "output_tokens": "8.00"
      }
    }
  ]
}
"#;

#[test]
fn fast_tier_uses_its_own_exact_rates() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let context = context("openai", "openai_api", "gpt-5.6-sol", "priority", 1_100)
        .with_requested_service_tier(ServiceTierId::new("fast").expect("service tier"));
    let usage = ModelUsage {
        input_tokens: Some(1_100),
        output_tokens: Some(50),
        cached_input_tokens: Some(100),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: Some(20),
    };
    let quantities = TokenQuantities::from_model_usage(&usage).expect("valid usage");

    let ModelReferenceCost::Complete(cost) = card
        .rate(&context, &quantities)
        .expect("cost calculation succeeds")
    else {
        panic!("expected a complete cost");
    };

    assert_eq!(cost.amount.currency().as_str(), "USD");
    assert_eq!(cost.amount.pico_units(), 10_080_000_000);
    assert_eq!(cost.line_items.len(), 4);
}

#[test]
fn reported_standard_tier_does_not_use_requested_fast_price() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let context = context("openai", "openai_api", "gpt-5.6-sol", "default", 1_100)
        .with_requested_service_tier(ServiceTierId::new("fast").expect("service tier"));
    let quantities = TokenQuantities::from_model_usage(&ModelUsage {
        input_tokens: Some(1_100),
        output_tokens: Some(50),
        cached_input_tokens: Some(100),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    })
    .expect("valid usage");

    let ModelReferenceCost::Complete(cost) = card
        .rate(&context, &quantities)
        .expect("cost calculation succeeds")
    else {
        panic!("expected a complete cost");
    };

    assert_eq!(cost.amount.pico_units(), 5_040_000_000);
}

#[test]
fn long_context_boundary_selects_the_long_rate() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let context = context("openai", "openai_api", "gpt-5.6-sol", "default", 272_001);
    let quantities = TokenQuantities::from_model_usage(&ModelUsage {
        input_tokens: Some(1),
        output_tokens: Some(0),
        cached_input_tokens: Some(0),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    })
    .expect("valid usage");

    let ModelReferenceCost::Complete(cost) = card
        .rate(&context, &quantities)
        .expect("cost calculation succeeds")
    else {
        panic!("expected a complete cost");
    };

    assert_eq!(cost.amount.pico_units(), 8_000_000);
}

#[test]
fn highspeed_model_is_selected_by_model_identity() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let context = context(
        "kimi",
        "kimi_api",
        "kimi-k2.7-code-highspeed",
        "standard",
        1_000,
    );
    let quantities = TokenQuantities::from_model_usage(&ModelUsage {
        input_tokens: Some(1_000),
        output_tokens: Some(100),
        cached_input_tokens: Some(100),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    })
    .expect("valid usage");

    let ModelReferenceCost::Complete(cost) = card
        .rate(&context, &quantities)
        .expect("cost calculation succeeds")
    else {
        panic!("expected a complete cost");
    };

    assert_eq!(cost.amount.pico_units(), 2_548_000_000);
}

#[test]
fn invocation_pricing_rejects_subscription_prices() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-5.6-sol").unwrap(),
    );
    let usage = ModelUsage {
        input_tokens: Some(1_000),
        output_tokens: Some(100),
        cached_input_tokens: Some(0),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    };

    let priced = card
        .price_invocation(
            Some(&model),
            None,
            ModelBillingScope::SubscriptionPlan,
            Some(&usage),
            0,
        )
        .unwrap();

    assert!(matches!(
        priced.reference_cost,
        ModelReferenceCostRecord::Unpriced {
            reason: ash_protocol::ModelReferenceCostReason::SubscriptionPlan
        }
    ));
}

#[test]
fn unknown_provider_is_not_priced_automatically_even_with_matching_rates() {
    let rates = TEST_RATE_CARD
        .replace("\"openai\"", "\"unknown-provider\"")
        .replace("\"gpt-5.6-sol\"", "\"test-model\"");
    let card = RateCard::from_json(&rates).unwrap();
    let model = ModelRef::new(
        ProviderId::new("unknown-provider").unwrap(),
        ModelId::new("test-model").unwrap(),
    );
    let usage = ModelUsage {
        input_tokens: Some(1_000),
        output_tokens: Some(100),
        cached_input_tokens: Some(0),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    };
    let quantities = TokenQuantities::from_model_usage(&usage).unwrap();
    assert!(matches!(
        card.rate(
            &context(
                "unknown-provider",
                "openai_api",
                "test-model",
                "default",
                1_000
            ),
            &quantities,
        )
        .unwrap(),
        ModelReferenceCost::Complete(_)
    ));
    let priced = card
        .price_invocation(
            Some(&model),
            None,
            ModelBillingScope::PublicApi,
            Some(&usage),
            1_788_480_000_000,
        )
        .unwrap();
    assert!(priced.billing.is_none());
    assert!(matches!(
        priced.reference_cost,
        ModelReferenceCostRecord::Unpriced { .. }
    ));
}

#[test]
fn invocation_pricing_records_highspeed_cost() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let model = ModelRef::new(
        ProviderId::new("kimi").unwrap(),
        ModelId::new("kimi-k2.7-code-highspeed").unwrap(),
    );
    let usage = ModelUsage {
        input_tokens: Some(1_000),
        output_tokens: Some(100),
        cached_input_tokens: Some(100),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    };

    let priced = card
        .price_invocation(
            Some(&model),
            None,
            ModelBillingScope::PublicApi,
            Some(&usage),
            0,
        )
        .unwrap();

    let ModelReferenceCostRecord::Complete { cost } = priced.reference_cost else {
        panic!("expected complete cost");
    };
    assert_eq!(cost.amount.pico_units, "2548000000");
}

#[test]
fn invocation_pricing_uses_reported_fast_tier_and_resolved_alias() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let requested = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-5.6").unwrap(),
    );
    let response = ModelResponseBilling {
        resolved_model: Some(ModelId::new("gpt-5.6-sol").unwrap()),
        applied_service_tier: Some("priority".into()),
    };
    let usage = ModelUsage {
        input_tokens: Some(1_100),
        output_tokens: Some(50),
        cached_input_tokens: Some(100),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    };

    let priced = card
        .price_invocation(
            Some(&requested),
            Some(&response),
            ModelBillingScope::PublicApi,
            Some(&usage),
            0,
        )
        .unwrap();

    assert_eq!(priced.resolved_model.unwrap().as_str(), "gpt-5.6-sol");
    assert_eq!(
        priced.billing.unwrap().service_tier_evidence,
        ash_protocol::ModelBillingEvidence::ResponseField
    );
    let ModelReferenceCostRecord::Complete { cost } = priced.reference_cost else {
        panic!("expected complete cost");
    };
    assert_eq!(cost.amount.pico_units, "10080000000");
}

#[test]
fn missing_token_details_produce_a_known_minimum() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let context = context("openai", "openai_api", "gpt-5.6-sol", "priority", 50);
    let quantities = TokenQuantities::from_model_usage(&ModelUsage {
        input_tokens: Some(50),
        output_tokens: Some(10),
        cached_input_tokens: None,
        cache_write_input_tokens: None,
        reasoning_tokens: None,
    })
    .expect("valid usage");

    let ModelReferenceCost::Partial {
        known_minimum,
        reason: IncompleteCostReason::MissingTokenQuantities(dimensions),
    } = card
        .rate(&context, &quantities)
        .expect("cost calculation succeeds")
    else {
        panic!("expected a partial cost");
    };

    assert_eq!(known_minimum.amount.pico_units(), 400_000_000);
    assert_eq!(dimensions.len(), 3);
}

#[test]
fn positive_unrated_dimension_produces_a_partial_cost() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let context = context("openai", "openai_api", "gpt-5.6-sol", "priority", 0);
    let extra = TokenDimension::new("provider_tool_tokens").expect("token dimension");
    let quantities = TokenQuantities::new()
        .with(
            TokenDimension::new(TokenDimension::UNCACHED_INPUT).unwrap(),
            Some(0),
        )
        .with(
            TokenDimension::new(TokenDimension::CACHED_INPUT).unwrap(),
            Some(0),
        )
        .with(
            TokenDimension::new(TokenDimension::CACHE_WRITE_INPUT).unwrap(),
            Some(0),
        )
        .with(
            TokenDimension::new(TokenDimension::OUTPUT).unwrap(),
            Some(0),
        )
        .with(extra.clone(), Some(1));

    let ModelReferenceCost::Partial {
        reason: IncompleteCostReason::MissingTokenRates(dimensions),
        ..
    } = card
        .rate(&context, &quantities)
        .expect("cost calculation succeeds")
    else {
        panic!("expected a partial cost");
    };

    assert_eq!(dimensions, vec![extra]);
}

#[test]
fn empty_usage_and_missing_rule_are_distinct() {
    let card = RateCard::from_json(TEST_RATE_CARD).expect("valid rate card");
    let known_context = context("openai", "openai_api", "gpt-5.6-sol", "priority", 0);
    let unknown_context = context("openai", "openai_api", "gpt-unknown", "priority", 0);

    assert_eq!(
        card.rate(&known_context, &TokenQuantities::new()).unwrap(),
        ModelReferenceCost::Unpriced {
            reason: UnpricedReason::MissingUsage,
        }
    );
    assert_eq!(
        card.rate(&unknown_context, &TokenQuantities::new())
            .unwrap(),
        ModelReferenceCost::Unpriced {
            reason: UnpricedReason::MissingRate,
        }
    );
}

#[test]
fn overlapping_rules_are_rejected_at_load_time() {
    let overlapping = TEST_RATE_CARD.replacen(
        "\"serviceTier\": \"priority\"",
        "\"serviceTier\": \"default\"",
        1,
    );

    assert!(matches!(
        RateCard::from_json(&overlapping),
        Err(AccountingError::OverlappingRateRules { .. })
    ));
}

#[test]
fn invalid_input_breakdown_is_rejected() {
    let usage = ModelUsage {
        input_tokens: Some(10),
        output_tokens: Some(0),
        cached_input_tokens: Some(8),
        cache_write_input_tokens: Some(3),
        reasoning_tokens: None,
    };

    assert_eq!(
        TokenQuantities::from_model_usage(&usage),
        Err(AccountingError::InvalidInputTokenBreakdown)
    );
}

#[test]
fn bundled_accelerated_prices_are_valid_and_auditable() {
    let card = RateCard::bundled_accelerated_public_prices().expect("bundled rate card");

    assert_eq!(card.revision().as_str(), "accelerated-public-2026-09-04");
    assert_eq!(card.rule_count(), 26);
    assert_eq!(card.metadata().source_urls.len(), 6);
    assert_eq!(card.digest().to_string().len(), 64);

    let context = context_at(
        "openai",
        "openai_api",
        "gpt-5.6-sol",
        "priority",
        1_100,
        1_788_480_000_000,
    );
    let quantities = TokenQuantities::from_model_usage(&ModelUsage {
        input_tokens: Some(1_100),
        output_tokens: Some(50),
        cached_input_tokens: Some(100),
        cache_write_input_tokens: Some(0),
        reasoning_tokens: None,
    })
    .expect("valid usage");
    let ModelReferenceCost::Complete(cost) = card.rate(&context, &quantities).unwrap() else {
        panic!("expected a complete bundled cost");
    };
    assert_eq!(cost.amount.pico_units(), 10_080_000_000);

    let before_review = context_at(
        "openai",
        "openai_api",
        "gpt-5.6-sol",
        "priority",
        1_100,
        1_788_479_999_999,
    );
    assert_eq!(
        card.rate(&before_review, &quantities).unwrap(),
        ModelReferenceCost::Unpriced {
            reason: UnpricedReason::MissingRate,
        }
    );
}

fn context(
    provider: &str,
    billing_platform: &str,
    model: &str,
    service_tier: &str,
    input_tokens: u64,
) -> ModelBillingContext {
    context_at(
        provider,
        billing_platform,
        model,
        service_tier,
        input_tokens,
        0,
    )
}

fn context_at(
    provider: &str,
    billing_platform: &str,
    model: &str,
    service_tier: &str,
    input_tokens: u64,
    started_at_unix_ms: i64,
) -> ModelBillingContext {
    ModelBillingContext::new(
        RateSelector::new(
            ProviderId::new(provider).expect("provider ID"),
            BillingPlatformId::new(billing_platform).expect("billing platform"),
            ModelId::new(model).expect("model ID"),
            ApiOperationId::new("text_generation").expect("operation"),
            ServiceTierId::new(service_tier).expect("service tier"),
            BillingRegionId::new("global").expect("region"),
            PricingVariantId::new("default").expect("pricing variant"),
        ),
        ServiceTierEvidence::ResponseField,
        input_tokens,
        started_at_unix_ms,
    )
}

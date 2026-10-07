use super::*;

#[test]
fn unsupported_original_falls_back_with_an_explicit_reason() {
    assert_eq!(
        normalize_image_detail(
            ImageDetailSelection::Explicit(ImageDetail::Original),
            ImageDetailCapabilities { original: false },
            ImageSourceDetailPolicy::Preserve,
        ),
        ImageDetailDecision {
            requested: ImageDetailSelection::Explicit(ImageDetail::Original),
            effective: ImageDetailSelection::ProviderDefault,
            reason: ImageDetailDecisionReason::OriginalUnsupportedDowngraded,
        }
    );
}

#[test]
fn source_policy_is_applied_before_model_capability() {
    assert_eq!(
        normalize_image_detail(
            ImageDetailSelection::Explicit(ImageDetail::Original),
            ImageDetailCapabilities { original: true },
            ImageSourceDetailPolicy::AtMost(ImageDetail::High),
        )
        .reason,
        ImageDetailDecisionReason::SourcePolicyDowngraded
    );
}

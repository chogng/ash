use crate::ImageDetail;

/// Explicit image-detail request, including the absence of a source-level preference.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageDetailSelection {
    ProviderDefault,
    Explicit(ImageDetail),
}

/// Source-owned maximum detail allowed before model capability normalization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageSourceDetailPolicy {
    Preserve,
    AtMost(ImageDetail),
}

/// Model support relevant to the provider-neutral image detail decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageDetailCapabilities {
    pub original: bool,
}

/// Stable diagnostic explaining the effective image-detail selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageDetailDecisionReason {
    Supported,
    ProviderDefaultSelected,
    OriginalUnsupportedDowngraded,
    SourcePolicyDowngraded,
}

/// Complete, observable result of normalizing one image detail request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageDetailDecision {
    pub requested: ImageDetailSelection,
    pub effective: ImageDetailSelection,
    pub reason: ImageDetailDecisionReason,
}

pub fn normalize_image_detail(
    requested: ImageDetailSelection,
    capabilities: ImageDetailCapabilities,
    source_policy: ImageSourceDetailPolicy,
) -> ImageDetailDecision {
    if requested == ImageDetailSelection::ProviderDefault {
        return ImageDetailDecision {
            requested,
            effective: requested,
            reason: ImageDetailDecisionReason::ProviderDefaultSelected,
        };
    }
    let ImageDetailSelection::Explicit(detail) = requested else {
        unreachable!("provider default returned above")
    };
    if let ImageSourceDetailPolicy::AtMost(maximum) = source_policy
        && detail_rank(detail) > detail_rank(maximum)
    {
        return ImageDetailDecision {
            requested,
            effective: ImageDetailSelection::Explicit(maximum),
            reason: ImageDetailDecisionReason::SourcePolicyDowngraded,
        };
    }
    if detail == ImageDetail::Original && !capabilities.original {
        return ImageDetailDecision {
            requested,
            effective: ImageDetailSelection::ProviderDefault,
            reason: ImageDetailDecisionReason::OriginalUnsupportedDowngraded,
        };
    }
    ImageDetailDecision {
        requested,
        effective: requested,
        reason: ImageDetailDecisionReason::Supported,
    }
}

fn detail_rank(detail: ImageDetail) -> u8 {
    match detail {
        ImageDetail::Auto => 0,
        ImageDetail::Low => 1,
        ImageDetail::High => 2,
        ImageDetail::Original => 3,
    }
}

#[cfg(test)]
#[path = "image_detail_tests.rs"]
mod tests;

use std::time::Duration;
use std::time::Instant;

use super::ElementId;
use super::FrameInvalidation;

/// A framework-owned property identity that may be animated on one element.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum AnimationProperty {
    /// A paint-only opacity value.
    Opacity,
    /// A horizontal layout or paint translation.
    TranslateX,
    /// A vertical layout or paint translation.
    TranslateY,
    /// A width value that participates in layout.
    Width,
    /// A height value that participates in layout.
    Height,
    /// A product-defined property identity owned outside the framework.
    Custom(u32),
}

/// Stable identity for one animated property across presentation rebuilds.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AnimationKey {
    element: ElementId,
    property: AnimationProperty,
}

impl AnimationKey {
    /// Creates a key from the mounted element and the property being animated.
    pub const fn new(element: ElementId, property: AnimationProperty) -> Self {
        Self { element, property }
    }

    pub const fn element(self) -> ElementId {
        self.element
    }

    pub const fn property(self) -> AnimationProperty {
        self.property
    }
}

/// Easing function applied to a scalar animation's normalized progress.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum AnimationEasing {
    /// Moves at a constant rate from the start value to the target value.
    #[default]
    Linear,
    /// Uses a smoothstep curve with a zero slope at both endpoints.
    EaseInOut,
}

impl AnimationEasing {
    pub(crate) fn apply(self, progress: f32) -> f32 {
        match self {
            Self::Linear => progress,
            Self::EaseInOut => progress * progress * (3.0 - 2.0 * progress),
        }
    }
}

/// Declarative transition parameters for a component-owned scalar property.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScalarAnimationSpec {
    duration: Duration,
    easing: AnimationEasing,
    invalidation: FrameInvalidation,
}

impl ScalarAnimationSpec {
    /// Creates a transition specification for one bound scalar property.
    pub const fn new(
        duration: Duration,
        easing: AnimationEasing,
        invalidation: FrameInvalidation,
    ) -> Self {
        Self {
            duration,
            easing,
            invalidation,
        }
    }

    pub const fn duration(self) -> Duration {
        self.duration
    }

    pub const fn easing(self) -> AnimationEasing {
        self.easing
    }

    pub const fn invalidation(self) -> FrameInvalidation {
        self.invalidation
    }
}

/// Animation binding sink consumed by presentation composition.
///
/// A retained runtime implements this contract. Components only declare a stable property key
/// and target; they do not depend on the runtime registry or own timers. Implementations must
/// preserve the current value for an existing key and retarget from that value.
pub trait AnimationBinding {
    /// Binds a scalar property for the current frame and returns its sampled value.
    fn bind_scalar(
        &mut self,
        key: AnimationKey,
        initial: f32,
        target: f32,
        spec: ScalarAnimationSpec,
        now: Instant,
    ) -> f32;
}

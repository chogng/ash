/// Presentation work that must be completed before the next frame can be presented.
///
/// Variants are ordered by cost and subsumption: rebuilding presentation also produces the scene
/// needed for rendering, so it supersedes a render-only request.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum FrameInvalidation {
    /// Render the current scene without rebuilding presentation.
    Render,
    /// Rebuild a host-defined presentation fragment while retaining the stable presentation.
    Fragment,
    /// Rebuild presentation and then render the resulting scene.
    Rebuild,
}

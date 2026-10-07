//! Product build provenance. Protocol and diagnostic contracts depend on `build-info` instead.

/// Returns the identity embedded in a product build, independent of its runtime environment.
pub fn current() -> build_info::BuildInfo {
    build_info::BuildInfo::new(
        option_env!("ASH_COMPILED_COMMIT"),
        option_env!("ASH_BUILD_ID"),
    )
}

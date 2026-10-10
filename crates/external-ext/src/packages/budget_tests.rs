use super::MAX_PACKAGES_DIAGNOSTIC_BYTES;
use super::MAX_PACKAGES_DIAGNOSTICS;
use super::MAX_PACKAGES_MANIFEST_RESPONSE_BYTES;
use super::MAX_PACKAGES_PACKAGE_CANDIDATES;
use super::MAX_PACKAGES_SNAPSHOT_BYTES;
use super::PackageBudget;
use super::PackageLimit;
use crate::packages::ExtensionDiagnostic;
use crate::packages::ExtensionDiagnosticCode;

#[test]
fn bounds_package_candidates_across_the_catalog() {
    let mut budget = PackageBudget::default();
    for _ in 0..MAX_PACKAGES_PACKAGE_CANDIDATES {
        budget
            .claim_package_candidate()
            .expect("candidate within budget");
    }

    assert_eq!(
        budget.claim_package_candidate(),
        Err(PackageLimit::PackageCandidates)
    );
}

#[test]
fn atomically_bounds_snapshot_and_manifest_response_bytes() {
    let mut snapshot_budget = PackageBudget::default();
    snapshot_budget
        .claim_published_extension(MAX_PACKAGES_SNAPSHOT_BYTES, 0)
        .expect("snapshot boundary");
    assert_eq!(
        snapshot_budget.claim_published_extension(1, 0),
        Err(PackageLimit::SnapshotBytes)
    );
    assert!(
        snapshot_budget
            .claim_published_extension(0, MAX_PACKAGES_MANIFEST_RESPONSE_BYTES)
            .is_ok(),
        "a failed claim must not consume the other budget"
    );

    let mut manifest_budget = PackageBudget::default();
    manifest_budget
        .claim_published_extension(0, MAX_PACKAGES_MANIFEST_RESPONSE_BYTES)
        .expect("manifest boundary");
    assert_eq!(
        manifest_budget.claim_published_extension(0, 1),
        Err(PackageLimit::ManifestResponseBytes)
    );
}

#[test]
fn reserves_the_last_diagnostic_for_a_truncation_marker() {
    let mut budget = PackageBudget::default();
    let mut diagnostics = Vec::new();
    for index in 0..MAX_PACKAGES_DIAGNOSTICS + 10 {
        budget.push_diagnostic(
            &mut diagnostics,
            ExtensionDiagnostic {
                source: "test".into(),
                subject: Some(index.to_string()),
                code: ExtensionDiagnosticCode::InvalidManifest,
                message: "invalid".into(),
            },
        );
    }

    assert_eq!(diagnostics.len(), MAX_PACKAGES_DIAGNOSTICS);
    let last = diagnostics.last().expect("truncation marker");
    assert_eq!(last.code, ExtensionDiagnosticCode::ResourceTooLarge);
    assert_eq!(last.subject, None);
    assert_eq!(last.message, "extension catalog diagnostic limit reached");
}

#[test]
fn bounds_total_diagnostic_text_bytes() {
    let mut budget = PackageBudget::default();
    let mut diagnostics = Vec::new();
    budget.push_diagnostic(
        &mut diagnostics,
        ExtensionDiagnostic {
            source: "test".into(),
            subject: None,
            code: ExtensionDiagnosticCode::InvalidManifest,
            message: "x".repeat(MAX_PACKAGES_DIAGNOSTIC_BYTES),
        },
    );

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(
        diagnostics[0].code,
        ExtensionDiagnosticCode::ResourceTooLarge
    );
    assert_eq!(
        diagnostics[0].message,
        "extension catalog diagnostic limit reached"
    );
}

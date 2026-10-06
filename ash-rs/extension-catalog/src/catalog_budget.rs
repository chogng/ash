use crate::catalog::ExtensionDiagnostic;
use crate::catalog::ExtensionDiagnosticCode;

pub(crate) const MAX_CATALOG_PACKAGE_CANDIDATES: usize = 4_096;
pub(crate) const MAX_CATALOG_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const MAX_CATALOG_MANIFEST_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_CATALOG_DIAGNOSTICS: usize = 4_096;
pub(crate) const MAX_CATALOG_DIAGNOSTIC_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogLimit {
    PackageCandidates,
    SnapshotBytes,
    ManifestResponseBytes,
}

#[derive(Default)]
pub(crate) struct CatalogBudget {
    package_candidates: usize,
    snapshot_bytes: usize,
    manifest_response_bytes: usize,
    diagnostic_bytes: usize,
    diagnostics_truncated: bool,
}

impl CatalogBudget {
    pub(crate) fn claim_package_candidate(&mut self) -> Result<(), CatalogLimit> {
        if self.package_candidates == MAX_CATALOG_PACKAGE_CANDIDATES {
            return Err(CatalogLimit::PackageCandidates);
        }
        self.package_candidates += 1;
        Ok(())
    }

    pub(crate) fn claim_published_extension(
        &mut self,
        snapshot_bytes: usize,
        manifest_response_bytes: usize,
    ) -> Result<(), CatalogLimit> {
        let next_snapshot_bytes = self
            .snapshot_bytes
            .checked_add(snapshot_bytes)
            .filter(|total| *total <= MAX_CATALOG_SNAPSHOT_BYTES)
            .ok_or(CatalogLimit::SnapshotBytes)?;
        let next_manifest_response_bytes = self
            .manifest_response_bytes
            .checked_add(manifest_response_bytes)
            .filter(|total| *total <= MAX_CATALOG_MANIFEST_RESPONSE_BYTES)
            .ok_or(CatalogLimit::ManifestResponseBytes)?;
        self.snapshot_bytes = next_snapshot_bytes;
        self.manifest_response_bytes = next_manifest_response_bytes;
        Ok(())
    }

    pub(crate) fn remaining_snapshot_bytes(&self) -> usize {
        MAX_CATALOG_SNAPSHOT_BYTES.saturating_sub(self.snapshot_bytes)
    }

    pub(crate) fn push_diagnostic(
        &mut self,
        diagnostics: &mut Vec<ExtensionDiagnostic>,
        value: ExtensionDiagnostic,
    ) {
        if self.diagnostics_truncated {
            return;
        }
        let value_bytes = diagnostic_bytes(&value);
        if diagnostics.len() + 1 < MAX_CATALOG_DIAGNOSTICS
            && self
                .diagnostic_bytes
                .checked_add(value_bytes)
                .is_some_and(|total| total < MAX_CATALOG_DIAGNOSTIC_BYTES)
        {
            self.diagnostic_bytes += value_bytes;
            diagnostics.push(value);
            return;
        }
        diagnostics.push(ExtensionDiagnostic {
            source: value.source,
            subject: None,
            code: ExtensionDiagnosticCode::ResourceTooLarge,
            message: "extension catalog diagnostic limit reached".into(),
        });
        self.diagnostics_truncated = true;
    }
}

fn diagnostic_bytes(value: &ExtensionDiagnostic) -> usize {
    value.source.len() + value.subject.as_deref().map_or(0, str::len) + value.message.len()
}

#[cfg(test)]
#[path = "catalog_budget_tests.rs"]
mod tests;

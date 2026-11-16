//! Projects Ash's protected metadata and continuous restrictions into SDK host options.
use ash_sandboxing::PROTECTED_DIR_METADATA_NAMES;
use ash_sandboxing::ResolvedFileSystem;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxPathAccess;
use ash_sandboxing::SandboxScope;
use mxc_sdk::v1::FilesystemRestriction;
use mxc_sdk::v1::FilesystemRestrictionAccess;
use std::path::Path;

pub(super) fn restrictions(
    scope: &SandboxScope,
    filesystem: &ResolvedFileSystem,
) -> Result<Vec<FilesystemRestriction>, SandboxError> {
    let mut restrictions = Vec::new();
    for grant in scope.grants() {
        if filesystem
            .readwrite_paths()
            .contains(&grant.dir().canonical_path().to_owned())
        {
            for name in PROTECTED_DIR_METADATA_NAMES {
                restrictions.push(FilesystemRestriction::Subtree {
                    path: text(&grant.dir().canonical_path().join(name))?,
                    access: FilesystemRestrictionAccess::ReadOnly,
                });
            }
        }
    }
    for rule in scope.path_rules() {
        let Some(pattern) = rule.continuous_pattern() else {
            continue;
        };
        let access = match rule.access() {
            SandboxPathAccess::Denied => FilesystemRestrictionAccess::Denied,
            SandboxPathAccess::ReadOnly => FilesystemRestrictionAccess::ReadOnly,
            SandboxPathAccess::ReadWrite => {
                return Err(SandboxError::UnsupportedPolicy(
                    "continuous patterns cannot grant additional write access".into(),
                ));
            }
        };
        restrictions.push(FilesystemRestriction::Pattern {
            root: text(rule.owner().canonical_path())?,
            pattern: pattern.to_owned(),
            access,
        });
    }
    Ok(restrictions)
}

fn text(path: &Path) -> Result<String, SandboxError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| SandboxError::UnsupportedPolicy("Seatbelt requires Unicode paths".into()))
}

#[cfg(test)]
#[path = "seatbelt_tests.rs"]
mod tests;

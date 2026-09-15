use crate::ContentDigest;
use crate::SkillCatalog;
use crate::SkillError;
use crate::SkillErrorKind;
use crate::file_snapshot::FileSnapshotFailure;
use crate::file_snapshot::read_verified_file_snapshot;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillRef;
use ash_protocol::SkillVersionSelector;
use std::fs;

const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;

/// Exact validated Skill instructions bound to durable activation provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivatedSkill {
    activation: FrozenSkillActivation,
    body: String,
}

impl ActivatedSkill {
    pub fn activation(&self) -> &FrozenSkillActivation {
        &self.activation
    }

    pub fn body(&self) -> &str {
        &self.body
    }
}

impl SkillCatalog {
    /// Loads one catalog entry through its controlled source root and freezes its exact digest.
    pub fn activate(
        &self,
        selected: &SkillRef,
        reason: SkillActivationReason,
    ) -> Result<ActivatedSkill, SkillError> {
        let entry = self.snapshot.read(&selected.id).ok_or_else(|| {
            SkillError::new(
                SkillErrorKind::SkillNotFound,
                format!(
                    "Skill '{}' is not present in the current catalog",
                    selected.id.name
                ),
            )
        })?;
        if let SkillVersionSelector::PinnedDigest { digest } = &selected.version
            && digest != entry.content_digest()
        {
            return Err(content_changed(&selected.id.name.to_string()));
        }
        let source = self
            .sources
            .iter()
            .find(|source| source.view().id() == &selected.id.source)
            .ok_or_else(|| {
                SkillError::new(
                    SkillErrorKind::SourceUnavailable,
                    format!("Skill source '{}' is unavailable", selected.id.source),
                )
            })?;
        let directory = source
            .skill_directory(&selected.id.name)
            .ok_or_else(|| content_changed(selected.id.name.as_str()))?;
        let body = load_exact_body_from_directory(
            source.host_root(),
            &directory,
            selected.id.name.as_str(),
            entry.content_digest(),
        )?;
        Ok(ActivatedSkill {
            activation: FrozenSkillActivation {
                id: selected.id.clone(),
                content_digest: entry.content_digest().clone(),
                catalog_generation: self.snapshot.generation().get(),
                reason,
            },
            body,
        })
    }
}

pub(crate) fn load_exact_body_from_directory(
    source_root: &std::path::Path,
    directory: &std::path::Path,
    skill_name: &str,
    expected_digest: &ContentDigest,
) -> Result<String, SkillError> {
    let directory_metadata = fs::symlink_metadata(directory)
        .map_err(|_| unavailable(skill_name, "directory is unavailable"))?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(unavailable(skill_name, "directory is not a real directory"));
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| unavailable(skill_name, "directory cannot be resolved"))?;
    if !canonical_directory.starts_with(source_root) {
        return Err(unavailable(skill_name, "directory escapes its source"));
    }

    let path = directory.join("SKILL.md");
    let canonical_path = path
        .canonicalize()
        .map_err(|_| unavailable(skill_name, "SKILL.md cannot be resolved"))?;
    if !canonical_path.starts_with(&canonical_directory) {
        return Err(unavailable(
            skill_name,
            "SKILL.md escapes its Skill directory",
        ));
    }

    let snapshot =
        read_verified_file_snapshot(&path, MAX_SKILL_FILE_BYTES).map_err(
            |failure| match failure {
                FileSnapshotFailure::Unavailable => unavailable(
                    skill_name,
                    "SKILL.md is unavailable or is not an admissible regular file",
                ),
                FileSnapshotFailure::Changed => content_changed(skill_name),
            },
        )?;
    if &snapshot.content_digest != expected_digest {
        return Err(content_changed(skill_name));
    }
    String::from_utf8(snapshot.bytes).map_err(|_| {
        SkillError::new(
            SkillErrorKind::InvalidContent,
            format!("Skill '{skill_name}' SKILL.md is not valid UTF-8"),
        )
    })
}

fn unavailable(skill_name: &str, detail: &str) -> SkillError {
    SkillError::new(
        SkillErrorKind::SourceUnavailable,
        format!("Skill '{skill_name}' {detail}"),
    )
}

fn content_changed(skill_name: &str) -> SkillError {
    SkillError::new(
        SkillErrorKind::ContentChanged,
        format!("Skill '{skill_name}' content changed after selection"),
    )
}

#[cfg(test)]
#[path = "activation_tests.rs"]
mod tests;

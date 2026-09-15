//! Bounded discovery and metadata-only catalogs for Agent Skills.
//!
//! This crate owns controlled Skill source roots, Agent Skills frontmatter validation, exact
//! `SKILL.md` digests, isolated diagnostics, immutable catalog generations, exact activation, and
//! bounded package resources. It does not execute scripts or own configuration.

mod activation;
mod catalog;
mod compatibility;
mod diagnostic;
mod error;
mod file_snapshot;
mod format;
mod identity;
mod resource;
mod source;

pub use activation::ActivatedSkill;
pub use ash_protocol::{
    ContentDigest, InvalidContentDigest, InvalidSkillName, InvalidSkillSourceId, SkillId,
    SkillName, SkillSourceId,
};
pub use catalog::{
    SkillAvailability, SkillCatalog, SkillCatalogEntry, SkillCatalogSnapshot, SkillMetadata,
};
pub use compatibility::SkillCompatibility;
pub use diagnostic::{SkillDiagnostic, SkillDiagnosticCode};
pub use error::{SkillError, SkillErrorKind};
pub use identity::SkillCatalogGeneration;
pub use resource::SkillResource;
pub use resource::SkillResourceKind;
pub use resource::SkillResourcePath;
pub use source::{SkillSourceKind, SkillSourceRoot, SkillSourceView};

#[cfg(test)]
#[path = "built_in_assets_tests.rs"]
mod built_in_assets_tests;

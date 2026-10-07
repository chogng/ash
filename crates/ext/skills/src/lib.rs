//! Skill discovery and context orchestration as a shared agent runtime extension.

mod catalog_prompt;
mod extension;
mod runtime;
mod selector;
mod tool;
mod watcher;

pub use ash_skills::SkillCompatibility;
pub use ash_skills::SkillDiagnosticCode;
pub use ash_skills::SkillSourceKind;
pub use extension::install;
pub use runtime::BuiltInSkillSource;
pub use runtime::DynamicSkillSourceProvider;
pub use runtime::DynamicSkillSourceSnapshot;
pub use runtime::SessionSkillSourceProvider;
pub use runtime::SkillCatalogReload;
pub use runtime::SkillConfigSnapshotProvider;
pub use runtime::SkillRuntime;
pub use runtime::SkillRuntimeDiagnostic;
pub use runtime::SkillRuntimeEntry;
pub use runtime::SkillRuntimeEventSink;
pub use runtime::SkillRuntimeSnapshot;
pub use tool::SKILLS_READ_TOOL_NAME;
pub use watcher::SkillWatcher;

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

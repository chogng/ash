#[path = "config/patch.rs"]
mod patch;
#[path = "config/values.rs"]
mod values;

pub use patch::Patch;
pub use values::ApprovalMode;
pub use values::Personality;
pub use values::SandboxMode;
pub use values::Theme;
pub use values::WebSearchMode;

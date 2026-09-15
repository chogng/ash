//! Durable task notes and bounded model access to its authorized Thread history.
mod store;
mod tool;
use ash_core::ThreadController;
use extension_api::CapabilityToolContribution;
use extension_api::CapabilityToolContributor;
use extension_api::ExtensionError;
use extension_api::ExtensionRegistryBuilder;
use extension_api::ExtensionToolAuthority;
use extension_api::ReadOnlyToolContributor;
use std::sync::Arc;
use std::sync::Weak;
pub use store::Note;
pub use store::NotesStore;
use tools::ToolExecutor;

struct HistoryNotes {
    threads: Weak<ThreadController>,
    notes: Arc<NotesStore>,
}
/// Installs tools over the supplied durable notes and existing Thread store.
pub fn install(
    builder: &mut ExtensionRegistryBuilder,
    threads: &Arc<ThreadController>,
    notes: Arc<NotesStore>,
) {
    let extension = Arc::new(HistoryNotes {
        threads: Arc::downgrade(threads),
        notes,
    });
    builder
        .read_only_tool_contributor("history-notes", extension.clone())
        .capability_tool_contributor("history-notes", extension);
}
impl ReadOnlyToolContributor for HistoryNotes {
    fn contribute(&self) -> Result<Vec<Arc<dyn ToolExecutor>>, ExtensionError> {
        Ok([
            "history_list",
            "history_read",
            "history_search",
            "notes_list",
            "notes_read",
            "notes_search",
        ]
        .into_iter()
        .map(|name| {
            Arc::new(tool::HistoryTool::new(
                name,
                self.threads.clone(),
                self.notes.clone(),
            )) as Arc<dyn ToolExecutor>
        })
        .collect())
    }
}
impl CapabilityToolContributor for HistoryNotes {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        Ok(vec![CapabilityToolContribution::new(
            Arc::new(tool::HistoryTool::new(
                "notes_write",
                self.threads.clone(),
                self.notes.clone(),
            )),
            ExtensionToolAuthority::ManagedStateWrite {
                resource: "thread-task-notes".into(),
            },
        )])
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

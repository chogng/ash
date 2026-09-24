//! Application event-loop adapter for editor-owned language-service events.

use ash_editor_host::FileEditorLanguageEvent;
use ash_editor_host::FileEditorLanguageEventSink;
use zui::app::AppProxy;

use crate::workbench_event::WorkbenchEvent;

pub(crate) struct WorkbenchLanguageEventSink {
    events: AppProxy<WorkbenchEvent>,
}

impl WorkbenchLanguageEventSink {
    pub(crate) const fn new(events: AppProxy<WorkbenchEvent>) -> Self {
        Self { events }
    }
}

impl FileEditorLanguageEventSink for WorkbenchLanguageEventSink {
    fn send(&self, event: FileEditorLanguageEvent) -> std::result::Result<(), String> {
        self.events
            .send_event(WorkbenchEvent::EditorLanguage(event))
            .map_err(|_| "desktop event loop is unavailable".to_owned())
    }
}

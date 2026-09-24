use crate::TuiStartupContext;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use std::path::Path;

pub(crate) fn choices(context: &TuiStartupContext) -> ListSelectionModel {
    let mut items = vec![
        detail(
            "Mode",
            if context.recovery.is_some() {
                "Resume"
            } else {
                "New"
            },
        ),
        detail("Workspace", context.workspace.display().to_string()),
        detail("Profile", profile_label(context.profile_root.as_deref())),
        detail("Connection", context.connection.label()),
    ];
    if let Some(recovery) = &context.recovery {
        items.extend([
            detail("Session", recovery.session_id().to_string()),
            detail("Thread", recovery.thread_id().to_string()),
        ]);
    }

    ListSelectionModel::new("Startup", vec![ListSelectionGroup::new("Startup", items)])
        .without_tab_bar()
}

fn profile_label(profile_root: Option<&Path>) -> String {
    profile_root
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "default".into())
}

fn detail(label: &str, value: impl Into<String>) -> ListSelectionItem {
    ListSelectionItem::new(label).with_description(value)
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;

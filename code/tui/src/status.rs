mod model;
mod panel;
mod panel_request;
mod resources;
mod settings;
mod settings_request;
mod setup;
mod view;

/// A completed status operation delivered to the TUI state owner.
pub(crate) enum Event {
    LineSettingsReceived(StatusLineSettings),
    LineEditorOpened(StatusLineEditorUpdate),
    LineEditorUpdated(StatusLineEditorUpdate),
    PanelOpened(StatusPanel),
    MemoryDiagnosticsChanged(crate::memory::Status),
    GitStatusReceived(ash_app_server_protocol::protocol::git::GitStatusResult),
    GitTextDiffReceived {
        status: ash_app_server_protocol::protocol::git::GitStatusResult,
        statistics: ash_app_server_protocol::protocol::git::GitDiffStatisticsDto,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenPanel,
    OpenLineEditor,
    EditLine(StatusLineEdit),
}

pub(crate) use model::StatusLineModel;
pub(crate) use model::StatusLineRuntime;
pub(crate) use panel::RemainingContextWindow;
pub(crate) use panel::StatusPanel;
pub(crate) use panel::StatusPanelOutcome;
pub(crate) use panel::StatusViewData;
pub(crate) use panel::status_panel;
pub(crate) use panel_request::StatusRequestScope;
pub(crate) use panel_request::load_status_panel;
#[cfg(test)]
pub(crate) use resources::AppServerProcessResourcesView;
pub(crate) use resources::AppServerResourcesView;
#[cfg(test)]
pub(crate) use resources::ObservedProcessResourcesView;
#[cfg(test)]
pub(crate) use resources::ProcessCpuCurrent;
#[cfg(test)]
pub(crate) use resources::ProcessMemoryCurrent;
pub(crate) use resources::ProcessResourcesModel;
pub(crate) use resources::ProcessResourcesView;
#[cfg(test)]
pub(crate) use resources::ProcessUsageView;
pub(crate) use resources::format_compact_process_cpu;
pub(crate) use resources::format_compact_process_memory;
pub(crate) use resources::format_process_cpu;
pub(crate) use resources::format_process_memory;
pub(crate) use resources::format_process_usage;
pub(crate) use settings::StatusLineItem;
pub(crate) use settings::StatusLineSettings;
pub(crate) use settings::StatusLineStyle;
pub(crate) use settings_request::StatusLineEdit;
pub(crate) use settings_request::StatusLineEditorUpdate;
pub(crate) use settings_request::execute;
#[cfg(test)]
pub(crate) use settings_request::set_status_line;
pub(crate) use setup::StatusLineChoices;
pub(crate) use setup::StatusLineSelectionAction;
#[cfg(test)]
pub(crate) use setup::list_selection as status_line_choices;
pub(crate) use view::context_header_line;
pub(crate) use view::draw;
pub(crate) use view::header_line;
pub(crate) use view::policy_line;

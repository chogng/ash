mod completion;
mod request;
mod settings;
mod warnings;

/// A completed skill operation delivered to the TUI state owner.
pub(crate) enum Event {
    SettingsOpened(SkillChoices),
    SettingsUpdated(SkillChoices),
    DiagnosticsReceived(Vec<ash_app_server_protocol::protocol::skills::SkillDiagnosticDto>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    SetEnablement {
        skill_id: ash_protocol::SkillId,
        enablement: ash_app_server_protocol::protocol::skills::SkillEnablementDto,
    },
}

pub(crate) use completion::SkillRefreshCompletion;
pub(crate) use completion::finish_refresh;
pub(crate) use completion::refresh;
pub(crate) use request::execute;
pub(crate) use request::load_selection;
#[cfg(test)]
pub(crate) use request::set_enablement;
pub(crate) use settings::SkillChoices;
pub(crate) use settings::SkillSelectionAction;
pub(crate) use settings::skill_choices;
pub(crate) use warnings::SkillDiagnosticWarnings;

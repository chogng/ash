use super::{TuiSlashCommandAction, built_in_slash_command_definitions};
use ash_slash_commands::SlashCommandArgumentMode;

#[test]
fn builtins_follow_enum_presentation_order() {
    let definitions = built_in_slash_command_definitions();
    assert_eq!(
        definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "status",
            "statusline",
            "skills",
            "memories",
            "mcp",
            "resume",
            "archive",
            "connectors",
            "rewind",
            "config",
            "startup",
            "home",
            "add-dir",
            "cd",
            "branch",
            "fork",
            "help",
            "shortcuts",
            "export",
            "model",
            "theme",
            "new",
            "quit",
            "dashboard",
            "subagents",
            "issue",
            "pr",
        ]
    );
    assert_eq!(definitions.len(), 27);
}

#[test]
fn builtins_declare_argument_support() {
    assert_eq!(TuiSlashCommandAction::Branch.argument_mode(), SlashCommandArgumentMode::Optional);
    assert_eq!(
        TuiSlashCommandAction::Cd.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Model.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Fork.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Rewind.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::AddDir.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Theme.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Export.argument_mode(),
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Quit.argument_mode(),
        SlashCommandArgumentMode::None
    );
    assert_eq!(
        TuiSlashCommandAction::Archive.argument_mode(),
        SlashCommandArgumentMode::None
    );
}

#[test]
fn builtins_declare_argument_hints() {
    assert_eq!(TuiSlashCommandAction::Branch.argument_hint(), Some("<name>"));
    assert_eq!(TuiSlashCommandAction::Cd.argument_hint(), Some("<path>"));
    assert_eq!(TuiSlashCommandAction::AddDir.argument_hint(), Some("<path>"));
    assert_eq!(TuiSlashCommandAction::Export.argument_hint(), Some("<path>"));
    assert_eq!(
        TuiSlashCommandAction::Model.argument_hint(),
        Some("<model> [effort]")
    );
    assert_eq!(TuiSlashCommandAction::Theme.argument_hint(), Some("<theme>"));
    assert_eq!(TuiSlashCommandAction::Resume.argument_hint(), Some("<session-id>"));
    assert_eq!(TuiSlashCommandAction::Rewind.argument_hint(), Some("<checkpoint>"));
    assert_eq!(TuiSlashCommandAction::Fork.argument_hint(), Some("<prompt>"));
    assert_eq!(TuiSlashCommandAction::New.argument_hint(), Some("<prompt>"));
    assert_eq!(TuiSlashCommandAction::Status.argument_hint(), None);
    assert_eq!(TuiSlashCommandAction::Quit.argument_hint(), None);
}

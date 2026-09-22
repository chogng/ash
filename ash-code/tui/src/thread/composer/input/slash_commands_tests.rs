use super::{TuiSlashCommandAction, built_in_slash_command_definitions};
use ash_slash_commands::ProductSlashCommand;
use ash_slash_commands::SlashCommandArgumentMode;
use ash_slash_commands::SlashCommandCatalog;
use ash_slash_commands::SlashCommandInput;
use ash_slash_commands::SlashCommandOrigin;

#[test]
fn product_commands_share_definitions_and_bind_to_local_actions() {
    let catalog =
        SlashCommandCatalog::with_local_and_server(built_in_slash_command_definitions(), [])
            .unwrap();
    for shared in ProductSlashCommand::ALL {
        let definition = shared.definition();
        assert_eq!(catalog.command_named(&definition.name), Some(&definition));
    }
    for (shared, action, argument) in [
        (
            ProductSlashCommand::Marketplace,
            TuiSlashCommandAction::Marketplace,
            "rust tools",
        ),
        (
            ProductSlashCommand::Plugins,
            TuiSlashCommandAction::Plugins,
            "",
        ),
        (
            ProductSlashCommand::Skills,
            TuiSlashCommandAction::Skills,
            "",
        ),
        (ProductSlashCommand::Lsp, TuiSlashCommandAction::Lsp, "rust"),
    ] {
        let definition = shared.definition();
        assert_eq!(catalog.command_named(&definition.name), Some(&definition));
        for arguments in ["", argument] {
            let text = format!("/{} {arguments}", definition.name);
            let invocation = SlashCommandInput::for_submission(&text, &catalog)
                .invocation()
                .unwrap();
            assert_eq!(invocation.origin, SlashCommandOrigin::Local);
            assert_eq!(
                invocation.command.name.parse::<TuiSlashCommandAction>(),
                Ok(action)
            );
            assert_eq!(&text[invocation.arguments_range], arguments);
        }
        if definition.argument_mode == SlashCommandArgumentMode::None {
            let text = format!("/{} extra", definition.name);
            assert!(
                SlashCommandInput::for_submission(&text, &catalog)
                    .invocation()
                    .is_none()
            );
        }
    }
}

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
            "usage",
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
            "marketplace",
            "plugins",
            "lsp",
        ]
    );
    assert_eq!(definitions.len(), 31);
}

#[test]
fn builtins_declare_argument_support() {
    assert_eq!(
        TuiSlashCommandAction::Branch.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Cd.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Model.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Fork.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Rewind.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::AddDir.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Theme.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Export.definition().argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(
        TuiSlashCommandAction::Quit.definition().argument_mode,
        SlashCommandArgumentMode::None
    );
    assert_eq!(
        TuiSlashCommandAction::Archive.definition().argument_mode,
        SlashCommandArgumentMode::None
    );
}

#[test]
fn builtins_declare_argument_hints() {
    assert_eq!(
        TuiSlashCommandAction::Branch
            .definition()
            .argument_hint
            .as_deref(),
        Some("<name>")
    );
    assert_eq!(
        TuiSlashCommandAction::Cd
            .definition()
            .argument_hint
            .as_deref(),
        Some("<path>")
    );
    assert_eq!(
        TuiSlashCommandAction::AddDir
            .definition()
            .argument_hint
            .as_deref(),
        Some("<path>")
    );
    assert_eq!(
        TuiSlashCommandAction::Export
            .definition()
            .argument_hint
            .as_deref(),
        Some("<path>")
    );
    assert_eq!(
        TuiSlashCommandAction::Model
            .definition()
            .argument_hint
            .as_deref(),
        Some("<model> [effort]")
    );
    assert_eq!(
        TuiSlashCommandAction::Theme
            .definition()
            .argument_hint
            .as_deref(),
        Some("<theme>")
    );
    assert_eq!(
        TuiSlashCommandAction::Resume
            .definition()
            .argument_hint
            .as_deref(),
        Some("<session-id>")
    );
    assert_eq!(
        TuiSlashCommandAction::Rewind
            .definition()
            .argument_hint
            .as_deref(),
        Some("<checkpoint>")
    );
    assert_eq!(
        TuiSlashCommandAction::Fork
            .definition()
            .argument_hint
            .as_deref(),
        Some("<prompt>")
    );
    assert_eq!(
        TuiSlashCommandAction::New
            .definition()
            .argument_hint
            .as_deref(),
        Some("<prompt>")
    );
    assert_eq!(
        TuiSlashCommandAction::Status
            .definition()
            .argument_hint
            .as_deref(),
        None
    );
    assert_eq!(
        TuiSlashCommandAction::Quit
            .definition()
            .argument_hint
            .as_deref(),
        None
    );
}

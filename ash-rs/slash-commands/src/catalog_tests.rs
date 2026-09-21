use crate::{
    SlashCommandArgumentMode, SlashCommandCatalog, SlashCommandDefinition, SlashCommandOrigin,
};

fn command(name: &str) -> SlashCommandDefinition {
    SlashCommandDefinition {
        name: name.into(),
        description: "inspect the dir".into(),
        argument_mode: SlashCommandArgumentMode::Optional,
        argument_hint: None,
    }
}

#[test]
fn default_catalog_advertises_product_commands() {
    let catalog = SlashCommandCatalog::default();

    assert_eq!(catalog.commands().len(), 3);
    assert_eq!(catalog.commands()[0].name, "advisor");
    assert_eq!(
        catalog.commands()[0].argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(catalog.origin("compact"), Some(SlashCommandOrigin::Server));
    assert_eq!(catalog.commands()[1].name, "compact");
    assert_eq!(catalog.commands()[2].name, "init");
    assert_eq!(catalog.origin("advisor"), Some(SlashCommandOrigin::Server));
    assert!(catalog.command_named("create-instructions").is_none());
    assert_eq!(catalog.origin("init"), Some(SlashCommandOrigin::Server));
}

#[test]
fn catalog_preserves_local_then_server_order_and_origin() {
    let catalog = SlashCommandCatalog::with_local_and_server(
        [command("model")],
        [command("diagnose"), command("check-tests")],
    )
    .unwrap();

    assert_eq!(
        catalog
            .commands()
            .iter()
            .map(|command| (
                command.name.as_str(),
                catalog.origin(&command.name).unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("model", SlashCommandOrigin::Local),
            ("diagnose", SlashCommandOrigin::Server),
            ("check-tests", SlashCommandOrigin::Server),
        ]
    );
}

#[test]
fn catalog_rejects_invalid_duplicate_and_blank_definitions() {
    assert!(
        SlashCommandCatalog::new([command("Diagnose")])
            .unwrap_err()
            .0
            .contains("invalid slash command name")
    );
    assert_eq!(
        SlashCommandCatalog::with_local_and_server([command("diagnose")], [command("diagnose")])
            .unwrap_err()
            .0,
        "duplicate slash command name 'diagnose'"
    );
    let mut blank = command("blank");
    blank.description = "  ".into();
    assert_eq!(
        SlashCommandCatalog::new([blank]).unwrap_err().0,
        "slash command 'blank' must have a description"
    );
}

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

    assert_eq!(catalog.commands().len(), 5);
    assert_eq!(catalog.origin("team"), Some(SlashCommandOrigin::Server));
    assert_eq!(catalog.origin("develop"), Some(SlashCommandOrigin::Server));
    assert_eq!(catalog.commands()[0].name, "advisor");
    assert_eq!(
        catalog.commands()[0].argument_hint.as_deref(),
        Some("<question|provider/model|off|clear>")
    );
    assert_eq!(
        catalog.commands()[0].description,
        "Configure or ask the advisor for a second opinion"
    );
    assert_eq!(
        catalog.commands()[0].argument_mode,
        SlashCommandArgumentMode::Optional
    );
    assert_eq!(catalog.origin("compact"), Some(SlashCommandOrigin::Server));
    assert!(catalog.command_named("ask-advisor").is_none());
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
fn matching_ranks_exact_prefix_word_and_missing_character_candidates() {
    let catalog = SlashCommandCatalog::new([
        command("update-config"),
        command("compact"),
        command("config"),
        command("diagnose"),
    ])
    .unwrap();
    let names = |query: &str| {
        catalog
            .matching(query)
            .into_iter()
            .map(|command| command.name)
            .collect::<Vec<_>>()
    };

    assert_eq!(
        names(""),
        ["update-config", "compact", "config", "diagnose"]
    );
    assert_eq!(names("config"), ["config", "update-config"]);
    assert_eq!(names("co"), ["compact", "config", "update-config"]);
    assert_eq!(names("cofig"), ["config", "update-config"]);
    assert_eq!(names("D"), ["diagnose"]);
    assert!(names("zz").is_empty());
}

#[test]
fn description_matches_follow_name_matches_and_expose_character_positions() {
    let catalog = SlashCommandCatalog::new([
        SlashCommandDefinition {
            description: "Open settings".into(),
            ..command("config")
        },
        SlashCommandDefinition {
            description: "Inspect configuration".into(),
            ..command("doctor")
        },
        command("settings"),
    ])
    .unwrap();
    assert_eq!(
        catalog
            .matching("settings")
            .into_iter()
            .map(|item| item.name)
            .collect::<Vec<_>>(),
        ["settings", "config"]
    );
    assert_eq!(
        catalog
            .matching("config")
            .into_iter()
            .map(|item| item.name)
            .collect::<Vec<_>>(),
        ["config", "doctor"]
    );
    assert_eq!(
        crate::matched_character_indices("config", "cofig"),
        [0, 1, 3, 4, 5]
    );
    assert_eq!(
        crate::matched_character_indices("Open settings", "settings"),
        [5, 6, 7, 8, 9, 10, 11, 12]
    );
    let localized = SlashCommandCatalog::new([SlashCommandDefinition {
        description: "检查设置".into(),
        ..command("config")
    }])
    .unwrap();
    assert!(localized.matching("设").is_empty());
    assert_eq!(localized.matching("设置")[0].name, "config");
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

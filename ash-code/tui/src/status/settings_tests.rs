use std::collections::BTreeMap;

use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use serde_json::json;

use super::StatusLineItem;
use super::StatusLineSettings;

#[test]
fn missing_status_line_keeps_accounting_items_opt_in() {
    let settings = StatusLineSettings::from_tui(&FrontendConfigDto::default()).unwrap();

    assert_eq!(
        settings.items().collect::<Vec<_>>(),
        vec![
            StatusLineItem::Permissions,
            StatusLineItem::Model,
            StatusLineItem::GitBranch,
            StatusLineItem::GitChanges,
        ]
    );
}

#[test]
fn configured_order_controls_status_line_order() {
    let settings = StatusLineSettings::from_tui(&FrontendConfigDto(BTreeMap::from([(
        "statusLine".into(),
        json!(["model", "permissions"]),
    )])))
    .unwrap();

    assert_eq!(
        settings.items().collect::<Vec<_>>(),
        vec![StatusLineItem::Model, StatusLineItem::Permissions]
    );
}

#[test]
fn writing_status_line_preserves_other_tui_values() {
    let section = FrontendConfigDto(BTreeMap::from([("theme".into(), json!("system"))]));
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::GitChanges, false);

    let written = settings.write_to_tui(&section);

    assert_eq!(written.0.get("theme"), Some(&json!("system")));
    assert_eq!(
        written.0.get("statusLine"),
        Some(&json!(["permissions", "model", "git-branch"]))
    );
    assert_eq!(written.0.get("showGitChangesAsDiff"), Some(&json!(false)));
}

#[test]
fn showing_git_changes_as_diff_defaults_off_and_round_trips() {
    let defaults = StatusLineSettings::from_tui(&FrontendConfigDto::default()).unwrap();
    assert!(!defaults.show_git_changes_as_diff());

    let section = FrontendConfigDto(BTreeMap::from([(
        "showGitChangesAsDiff".into(),
        json!(true),
    )]));
    let settings = StatusLineSettings::from_tui(&section).unwrap();
    assert!(settings.show_git_changes_as_diff());

    let written = settings.write_to_tui(&FrontendConfigDto::default());
    assert_eq!(written.0.get("showGitChangesAsDiff"), Some(&json!(true)));
}

#[test]
fn accounting_items_round_trip_when_enabled() {
    let section = FrontendConfigDto(BTreeMap::from([
        (
            "statusLine".into(),
            json!(["cache-hit-rate", "reference-cost"]),
        ),
        ("showGitChangesAsDiff".into(), json!(false)),
        ("statusLineStyle".into(), json!("compact")),
    ]));

    let settings = StatusLineSettings::from_tui(&section).unwrap();

    assert_eq!(
        settings.items().collect::<Vec<_>>(),
        vec![StatusLineItem::CacheHitRate, StatusLineItem::ReferenceCost]
    );
    assert_eq!(
        settings.write_to_tui(&FrontendConfigDto::default()),
        section
    );
}

#[test]
fn process_status_items_round_trip_without_becoming_defaults() {
    let section = FrontendConfigDto(BTreeMap::from([(
        "statusLine".into(),
        json!(["memory", "cpu"]),
    )]));

    let settings = StatusLineSettings::from_tui(&section).unwrap();

    assert_eq!(
        settings.items().collect::<Vec<_>>(),
        vec![StatusLineItem::Memory, StatusLineItem::Cpu]
    );
    assert_eq!(
        settings.write_to_tui(&FrontendConfigDto::default()).0["statusLine"],
        json!(["memory", "cpu"])
    );
}

#[test]
fn unknown_and_duplicate_items_are_rejected() {
    for status_line in [json!(["future"]), json!(["model", "model"])] {
        let section = FrontendConfigDto(BTreeMap::from([("statusLine".into(), status_line)]));
        assert!(StatusLineSettings::from_tui(&section).is_err());
    }
    let section = FrontendConfigDto(BTreeMap::from([(
        "showGitChangesAsDiff".into(),
        json!("yes"),
    )]));
    assert!(StatusLineSettings::from_tui(&section).is_err());
}

#[test]
fn status_line_style_is_strict_and_preserves_composition() {
    use super::super::StatusLineStyle;
    let section = FrontendConfigDto(BTreeMap::from([
        ("statusLine".into(), json!(["context", "model"])),
        ("futureSetting".into(), json!(42)),
    ]));
    let mut settings = StatusLineSettings::from_tui(&section).unwrap();
    assert_eq!(settings.style(), StatusLineStyle::Compact);
    settings.set_style(StatusLineStyle::Rich);
    let written = settings.write_to_tui(&section);
    assert_eq!(written.0["statusLine"], section.0["statusLine"]);
    assert_eq!(written.0["futureSetting"], json!(42));
    assert_eq!(written.0["statusLineStyle"], json!("rich"));
    assert_eq!(StatusLineSettings::from_tui(&written).unwrap(), settings);
    for value in [json!(true), json!(null), json!("colorful"), json!(1)] {
        let mut invalid = written.clone();
        invalid.0.insert("statusLineStyle".into(), value);
        assert!(
            StatusLineSettings::from_tui(&invalid)
                .unwrap_err()
                .contains("statusLineStyle")
        );
    }
}

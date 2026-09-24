use super::MenuAboutMetadata;
use super::MenuAccelerator;
use super::MenuAction;
use super::MenuEntry;
use super::MenuGroup;
use super::MenuItemId;
use super::MenuModel;
use super::MenuModelError;
use super::MenuRole;
use super::MenuRoleItem;

fn id(value: &str) -> MenuItemId {
    MenuItemId::new(value).unwrap()
}

#[test]
fn actions_retain_checkbox_and_accelerator_semantics() {
    let accelerator = MenuAccelerator::parse("CommandOrControl+Shift+KeyP").unwrap();
    let action = MenuAction::new(id("view.palette"), "Command Palette")
        .with_checked(true)
        .with_accelerator(accelerator.clone());

    assert_eq!(action.checked, Some(true));
    assert_eq!(action.accelerator, Some(accelerator));
    assert!(MenuAccelerator::parse("Shift+KeyP+Alt").is_err());
}

#[test]
fn model_rejects_duplicate_identities_across_nested_groups() {
    let duplicate = id("file.open");
    let model = MenuModel::new([MenuGroup::new(
        id("file"),
        "File",
        [
            MenuEntry::Action(MenuAction::new(duplicate.clone(), "Open")),
            MenuEntry::Submenu(MenuGroup::new(
                id("file.recent"),
                "Recent",
                [MenuEntry::Action(MenuAction::new(
                    duplicate.clone(),
                    "Again",
                ))],
            )),
        ],
    )]);

    assert_eq!(
        model.validate(),
        Err(MenuModelError::DuplicateId(duplicate))
    );
}

#[test]
fn native_roles_need_no_application_action_identity() {
    let model = MenuModel::new([MenuGroup::new(
        id("edit"),
        "Edit",
        [
            MenuEntry::Role(MenuRoleItem::new(MenuRole::Copy)),
            MenuEntry::Role(MenuRoleItem::new(MenuRole::Paste).with_label("Paste Value")),
        ],
    )]);

    assert_eq!(model.validate(), Ok(()));
    assert!(matches!(
        MenuRole::about(MenuAboutMetadata::new().with_name("Ash")),
        MenuRole::About(metadata) if metadata.name.as_deref() == Some("Ash")
    ));
}

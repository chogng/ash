use std::cell::Cell;
use std::rc::Rc;

use super::MenuAction;
use super::MenuEntry;
use super::MenuEventHandler;
use super::MenuGroup;
use super::MenuHandle;
use super::MenuItemId;
use super::MenuModel;
use super::MenuService;
use super::SystemServiceError;
use crate::services::SystemServiceErrorCode;

struct RecordingMenu {
    calls: Rc<Cell<usize>>,
}

impl MenuService for RecordingMenu {
    fn set_application_menu(&mut self, _model: MenuModel) -> Result<(), SystemServiceError> {
        self.calls.set(self.calls.get() + 1);
        Ok(())
    }

    fn set_event_handler(&mut self, _handler: Option<MenuEventHandler>) {}
}

fn id(value: &str) -> MenuItemId {
    MenuItemId::new(value).unwrap()
}

#[test]
fn handle_rejects_ambiguous_models_before_calling_injected_backend() {
    let calls = Rc::new(Cell::new(0));
    let handle = MenuHandle::new(RecordingMenu {
        calls: calls.clone(),
    });
    let duplicate = id("file.open");
    let model = MenuModel::new([MenuGroup::new(
        id("file"),
        "File",
        [
            MenuEntry::Action(MenuAction::new(duplicate.clone(), "Open")),
            MenuEntry::Action(MenuAction::new(duplicate, "Open Again")),
        ],
    )]);

    let error = handle.set_application_menu(model).unwrap_err();

    assert_eq!(error.code(), SystemServiceErrorCode::InvalidInput);
    assert!(error.is_invalid_input());
    assert_eq!(calls.get(), 0);
}

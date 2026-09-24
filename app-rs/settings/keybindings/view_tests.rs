use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::ElementId;
use zui::ui::InteractionFrame;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextInput;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use super::KeyboardShortcutRow;
use super::KeyboardShortcuts;
use crate::KeyboardShortcutsState;
use ash_commands::AppCommandId;
use ash_keybinding::HostPlatform;
use ash_keybinding::parse_key_sequence;
use ash_ui_components::QuickInputIds;

const PARENT: ElementId = ElementId::scoped(90, 1);
const ROOT: ElementId = ElementId::scoped(90, 2);
const CLOSE: ElementId = ElementId::scoped(90, 3);
const COPY: ElementId = ElementId::scoped(90, 4);
const SEARCH: ElementId = ElementId::scoped(90, 5);

#[test]
fn visible_settings_are_modal_and_paint_keycaps() {
    let state = KeyboardShortcutsState::default();
    let search = TextInput::default();
    let copy = parse_key_sequence("primary+c").expect("copy shortcut");
    let rows = [KeyboardShortcutRow::new(
        AppCommandId::Copy,
        COPY,
        "Copy",
        Some(&copy),
    )];
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::default();
    let shortcuts = KeyboardShortcuts::new(
        Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
        &state,
        &search,
        &rows,
        &[],
        QuickInputIds::new(PARENT, ROOT, CLOSE, SEARCH),
        HostPlatform::MacOs,
        CaretVisibility::Visible,
        &mut text_layout,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&shortcuts);
    let scene = frame.scene();

    assert!(
        frame
            .interaction()
            .target_at(Point::new(0.0, 0.0))
            .is_none()
    );
    assert!(frame.interaction().node(COPY).is_some());
    assert!(scene.text_blocks().iter().any(|text| text.text() == "⌘"));
    assert!(scene.text_blocks().iter().any(|text| text.text() == "C"));
}

use super::*;
use zui::ui::AccessibilityRole;
use zui::ui::CaretVisibility;
use zui::ui::InteractionFrame;
use zui::ui::Rect;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

#[test]
fn memory_manager_exposes_editing_permissions_and_modal_keyboard_targets() {
    let mut state = State {
        open: true,
        ..State::default()
    };
    state.scopes.push(MemoryScopeDescriptor {
        label: "Personal memories".into(),
        policy: MemoryPolicy::disabled(MemoryScope::Profile),
    });
    state.set_record(Memory {
        memory_id: memories::MemoryId::new("fixture").unwrap(),
        scope: MemoryScope::Profile,
        revision: 2,
        title: "Fixture".into(),
        body: "Rust\n保留正文".into(),
        source: memories::MemorySource::User,
        created_at_unix_ms: 1,
        updated_at_unix_ms: 2,
    });
    let theme = ash_ui_theme::DEFAULT_UI_THEME;
    let mut frame = UiFrame::<InteractionFrame>::new(theme.workbench_background);
    let viewport = Rect::from_xywh(0.0, 0.0, 900.0, 720.0);
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    frame.with_context(|context| {
        draw(
            context,
            viewport,
            &state,
            theme,
            &dispatch,
            CaretVisibility::Visible,
            &mut text_layout,
            &ash_editor::CodeEditorStyle::light(),
        )
    });
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    for (id, label) in [
        (TITLE, "Memory title"),
        (BODY, "Memory content"),
        (SAVE, "Save memory"),
        (READING, "Reading: off"),
        (SAVING, "Model saving: off"),
    ] {
        let node = nodes.iter().find(|node| node.id == id).expect(label);
        assert_eq!(node.label, label);
        assert!(node.focusable);
        assert!(node.bounds.origin.x >= 0.0 && node.bounds.right() <= viewport.right());
        assert!(node.bounds.origin.y >= 0.0 && node.bounds.bottom() <= viewport.bottom());
    }
    let body = nodes.iter().find(|node| node.id == BODY).unwrap();
    assert_eq!(body.role, AccessibilityRole::TextInput);
    assert_eq!(body.value.as_deref(), Some("Rust\n保留正文"));
    assert_eq!(state.selected.as_ref().unwrap().revision, 2);
    assert!(!state.dirty);
}

#[test]
fn showing_a_new_memory_clears_old_editor_state() {
    let mut state = State::default();
    state.title.apply(TextInputCommand::Insert("old".into()));
    state.body.replace_text("old body");
    state.dirty = true;
    state.clear_draft();
    assert!(state.title.text().is_empty());
    assert!(state.body.text().is_empty());
    assert!(!state.dirty);
    assert!(!state.read_only);
}

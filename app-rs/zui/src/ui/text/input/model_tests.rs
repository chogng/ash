use super::{
    TextInput, TextInputCommand, TextInputCompositionCursor, TextInputCompositionEvent,
    TextInputSelectionMode,
};

#[test]
fn editing_moves_and_deletes_at_grapheme_boundaries() {
    let mut model = TextInput::default();
    model.apply(super::TextInputCommand::Insert("a👨‍👩‍👧‍👦b".to_owned()));
    model.apply(super::TextInputCommand::MoveLeft(
        TextInputSelectionMode::Move,
    ));
    model.apply(super::TextInputCommand::Backspace);

    assert_eq!(model.text(), "ab");
    assert_eq!(model.cursor(), 1);
}

#[test]
fn replacing_a_selection_is_atomic() {
    let mut model = TextInput::default();
    model.apply(super::TextInputCommand::Insert("hello".to_owned()));
    model.apply(super::TextInputCommand::MoveToStart(
        TextInputSelectionMode::Move,
    ));
    model.apply(super::TextInputCommand::MoveRight(
        TextInputSelectionMode::Extend,
    ));
    model.apply(super::TextInputCommand::Insert("H".to_owned()));

    assert_eq!(model.text(), "Hello");
    assert_eq!(model.anchor(), 1);
    assert_eq!(model.cursor(), 1);
}

#[test]
fn selected_text_exposes_only_a_non_empty_selection() {
    let mut input = TextInput::new();
    input.apply(TextInputCommand::Insert("hello".into()));
    assert_eq!(input.selected_text(), None);

    input.apply(TextInputCommand::MoveLeft(TextInputSelectionMode::Extend));
    input.apply(TextInputCommand::MoveLeft(TextInputSelectionMode::Extend));

    assert_eq!(input.selected_text(), Some("lo"));
}

#[test]
fn preedit_remains_separate_until_commit() {
    let mut model = TextInput::default();
    model.apply(super::TextInputCommand::Insert("ask ".to_owned()));
    model.apply_composition(TextInputCompositionEvent::Preedit {
        text: "ni".to_owned(),
        cursor: TextInputCompositionCursor::Visible(2..2),
    });

    assert_eq!(model.text(), "ask ");
    assert_eq!(
        model.composition(),
        Some(("ni", &TextInputCompositionCursor::Visible(2..2)))
    );

    model.apply_composition(TextInputCompositionEvent::Preedit {
        text: "你".to_owned(),
        cursor: TextInputCompositionCursor::Visible(3..3),
    });
    model.apply_composition(TextInputCompositionEvent::Commit("你".to_owned()));

    assert_eq!(model.text(), "ask 你");
    assert_eq!(model.composition(), None);
}

#[test]
fn composition_replaces_the_active_selection_only_on_commit() {
    let mut model = TextInput::default();
    model.apply(super::TextInputCommand::Insert("hello".to_owned()));
    model.apply(super::TextInputCommand::SelectAll);
    model.apply_composition(TextInputCompositionEvent::Preedit {
        text: "世".to_owned(),
        cursor: TextInputCompositionCursor::Hidden,
    });
    model.apply_composition(TextInputCompositionEvent::Preedit {
        text: "世界".to_owned(),
        cursor: TextInputCompositionCursor::Hidden,
    });

    assert_eq!(model.text(), "hello");
    assert_eq!(
        model.composition(),
        Some(("世界", &TextInputCompositionCursor::Hidden))
    );

    model.apply_composition(TextInputCompositionEvent::Commit("世界".to_owned()));
    assert_eq!(model.text(), "世界");
}

#[test]
fn taking_text_resets_editing_and_composition_state() {
    let mut model = TextInput::new();
    model.apply(super::TextInputCommand::Insert("echo hello".to_string()));
    model.apply_composition(TextInputCompositionEvent::Preedit {
        text: " pending".to_string(),
        cursor: TextInputCompositionCursor::Hidden,
    });

    assert_eq!(model.take_text(), "echo hello");
    assert_eq!(model.text(), "");
    assert_eq!(model.cursor(), 0);
    assert_eq!(model.anchor(), 0);
    assert_eq!(model.composition(), None);
}

#[test]
fn cancelling_composition_restores_the_unchanged_selection() {
    let mut model = TextInput::default();
    model.apply(super::TextInputCommand::Insert("hello".to_owned()));
    model.apply(super::TextInputCommand::SelectAll);
    model.apply_composition(TextInputCompositionEvent::Preedit {
        text: "世".to_owned(),
        cursor: TextInputCompositionCursor::Visible(3..3),
    });

    model.cancel_composition();

    assert_eq!(model.text(), "hello");
    assert_eq!(model.anchor(), 0);
    assert_eq!(model.cursor(), 5);
}

#[test]
fn single_line_model_rejects_line_breaks_and_control_characters() {
    let mut model = TextInput::default();
    model.apply(super::TextInputCommand::Insert("a\nb\r\u{7}c".to_owned()));

    assert_eq!(model.text(), "abc");
}

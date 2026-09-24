use super::ListSelectionAdjustment;
use super::ListSelectionGroup;
use super::ListSelectionInputOutcome;
use super::ListSelectionItem;
use super::ListSelectionItemId;
use super::ListSelectionModel;
use super::ListSelectionState;
use crate::keymap::bindings;
use crate::widgets::search_box::SearchBoxModel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

fn state() -> ListSelectionState {
    ListSelectionState::new(
        ListSelectionModel::new(
            "Help",
            vec![
                ListSelectionGroup::new(
                    "Commands",
                    vec![
                        ListSelectionItem::new("/status").with_description("show status"),
                        ListSelectionItem::new("/model").with_description("show model"),
                    ],
                ),
                ListSelectionGroup::new(
                    "Keys",
                    vec![
                        ListSelectionItem::new("↑ / ↓").with_description("move selection"),
                        ListSelectionItem::new("Esc").with_description("close"),
                    ],
                ),
            ],
        )
        .with_search(SearchBoxModel::new("Search help")),
    )
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn active_tab_label(state: &ListSelectionState) -> &str {
    state.active_tab().label()
}

#[test]
fn keyboard_activation_returns_the_selected_action() {
    let first_id = ListSelectionItemId::new("first");
    let second_id = ListSelectionItemId::new("second");
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Items",
            vec![ListSelectionGroup::new(
                "All",
                vec![
                    ListSelectionItem::new("First").with_id(first_id),
                    ListSelectionItem::new("Second").with_id(second_id.clone()),
                ],
            )],
        )
        .without_tab_bar(),
    );

    state.handle_key(key(KeyCode::Down));
    assert_eq!(
        state.handle_key(key(KeyCode::Enter)),
        ListSelectionInputOutcome::Activate(second_id)
    );
    assert_eq!(state.selected_visible_index(), Some(1));
}

#[test]
fn read_only_rows_cannot_be_activated() {
    let mut state = ListSelectionState::new(ListSelectionModel::new(
        "Status",
        vec![ListSelectionGroup::new(
            "Details",
            vec![ListSelectionItem::new("Read only")],
        )],
    ));

    assert!(!state.select_visible_item(0));
    assert_eq!(
        state.handle_key(key(KeyCode::Enter)),
        ListSelectionInputOutcome::Consumed
    );
}

#[test]
fn explicit_search_focus_routes_text_to_the_query() {
    let mut state = state();

    assert!(state.focus_search());
    state.handle_key(key(KeyCode::Char('m')));

    assert_eq!(state.query(), "m");
}

#[test]
fn tab_keys_switch_tabs_and_wrap() {
    let mut state = state();
    state.handle_key(key(KeyCode::Up));
    state.handle_key(key(KeyCode::Up));

    state.handle_key(key(KeyCode::Tab));
    assert_eq!(active_tab_label(&state), "Keys");
    state.handle_key(key(KeyCode::Tab));
    assert_eq!(active_tab_label(&state), "Commands");
    state.handle_key(key(KeyCode::BackTab));
    assert_eq!(active_tab_label(&state), "Keys");
}

#[test]
fn list_without_its_own_header_reports_upward_focus_boundary() {
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Nested",
            vec![ListSelectionGroup::new(
                "Items",
                vec![ListSelectionItem::new("First")],
            )],
        )
        .without_tab_bar(),
    );

    assert_eq!(
        state.handle_key(key(KeyCode::Up)),
        ListSelectionInputOutcome::FocusPrevious
    );
}

#[test]
fn arrow_keys_adjust_the_selected_actionable_item() {
    let item_id = ListSelectionItemId::new("follow-up-mode");
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Config",
            vec![ListSelectionGroup::new(
                "Config",
                vec![ListSelectionItem::new("Follow-up messages").with_id(item_id.clone())],
            )],
        )
        .without_tab_bar(),
    );

    assert_eq!(
        state.handle_key(key(KeyCode::Left)),
        ListSelectionInputOutcome::Adjust(item_id.clone(), ListSelectionAdjustment::Previous)
    );
    assert_eq!(
        state.handle_key(key(KeyCode::Right)),
        ListSelectionInputOutcome::Adjust(item_id, ListSelectionAdjustment::Next)
    );
}

#[test]
fn tab_switching_preserves_the_search_query() {
    let mut state = state();

    state.handle_key(key(KeyCode::Char('/')));
    for character in "esc".chars() {
        state.handle_key(key(KeyCode::Char(character)));
    }
    state.handle_key(key(KeyCode::Tab));
    assert!(state.tabs_focused());
    assert!(!state.search().unwrap().input_active());
    assert_eq!(active_tab_label(&state), "Keys");
    state.handle_key(key(KeyCode::BackTab));
    assert!(state.tabs_focused());
    assert!(!state.search().unwrap().input_active());
    assert_eq!(active_tab_label(&state), "Commands");
    state.handle_key(key(KeyCode::Tab));
    assert_eq!(state.query(), "esc");
    assert_eq!(state.visible_items().len(), 2);
    assert_eq!(state.visible_items()[0].label(), "Esc");
    assert_eq!(state.visible_items()[1].label(), "↑ / ↓");
}

#[test]
fn filtering_and_navigation_keep_selection_in_visible_range() {
    let mut state = state();

    state.handle_key(key(KeyCode::Down));
    assert_eq!(state.selected_visible_index(), Some(1));
    state.handle_key(key(KeyCode::Home));
    state.handle_key(key(KeyCode::Char('/')));
    for character in "status".chars() {
        state.handle_key(key(KeyCode::Char(character)));
    }

    assert_eq!(state.visible_items().len(), 1);
    assert_eq!(state.selected_visible_index(), Some(0));
    for _ in 0.."status".len() {
        state.handle_key(key(KeyCode::Backspace));
    }
    state.handle_key(key(KeyCode::Down));
    state.handle_key(key(KeyCode::Down));
    assert_eq!(state.selected_visible_index(), Some(1));
}

#[test]
fn candidate_ranking_uses_match_quality_and_preserves_equal_model_order() {
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Help",
            vec![ListSelectionGroup::new(
                "Commands",
                vec![
                    ListSelectionItem::new("show status"),
                    ListSelectionItem::new("s-t-a-t-u-s"),
                    ListSelectionItem::new("status"),
                    ListSelectionItem::new("status line"),
                    ListSelectionItem::new("appstatus"),
                    ListSelectionItem::new("second description").with_description("status"),
                    ListSelectionItem::new("first description").with_description("status"),
                ],
            )],
        )
        .with_search(SearchBoxModel::new("Search commands"))
        .with_initial_selected(4),
    );

    state.handle_key(key(KeyCode::Home));
    state.handle_key(key(KeyCode::Char('/')));
    for character in "status".chars() {
        state.handle_key(key(KeyCode::Char(character)));
    }

    assert_eq!(
        state
            .visible_items()
            .into_iter()
            .map(ListSelectionItem::label)
            .collect::<Vec<_>>(),
        vec![
            "status",
            "status line",
            "show status",
            "appstatus",
            "s-t-a-t-u-s",
            "second description",
            "first description",
        ]
    );
    assert_eq!(state.selected_visible_index(), Some(0));
    assert_eq!(state.selected_item().unwrap().label(), "status");
}

#[test]
fn escape_requests_view_dismissal() {
    let mut state = state();

    assert_eq!(
        state.handle_key(key(KeyCode::Esc)),
        ListSelectionInputOutcome::Dismiss
    );
}

#[test]
fn control_c_also_dismisses_the_active_view() {
    let mut state = state();

    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        ListSelectionInputOutcome::Dismiss
    );
}

#[test]
fn enter_and_space_activate_actionable_items() {
    let item_id = ListSelectionItemId::new("toggle-skill");
    let mut actionable = ListSelectionState::new(
        ListSelectionModel::new(
            "Skills",
            vec![ListSelectionGroup::new(
                "All",
                vec![ListSelectionItem::new("review").with_id(item_id.clone())],
            )],
        )
        .with_activation(bindings::CONFIG_CHANGE),
    );

    assert_eq!(
        actionable.handle_key(key(KeyCode::Enter)),
        ListSelectionInputOutcome::Activate(item_id.clone())
    );
    assert_eq!(
        actionable.handle_key(key(KeyCode::Char(' '))),
        ListSelectionInputOutcome::Activate(item_id)
    );
}

#[test]
fn arrows_follow_items_search_and_tabs_in_visual_order() {
    let mut view = state();
    view.handle_key(key(KeyCode::Down));
    view.handle_key(key(KeyCode::Up));
    assert!(view.items_focused());
    view.handle_key(key(KeyCode::Up));
    assert!(view.search_focused());
    assert!(view.search().unwrap().input_active());
    view.handle_key(key(KeyCode::Char('m')));
    assert_eq!(view.query(), "m");
    view.handle_key(key(KeyCode::Up));
    assert!(view.tabs_focused());
    assert!(!view.search().unwrap().input_active());
    view.handle_key(key(KeyCode::Right));
    assert_eq!(active_tab_label(&view), "Keys");
    view.handle_key(key(KeyCode::Left));
    assert_eq!(active_tab_label(&view), "Commands");
    view.handle_key(key(KeyCode::Down));
    assert!(view.search_focused());
    view.handle_key(key(KeyCode::Down));
    assert!(view.items_focused());
}

#[test]
fn empty_results_still_allow_returning_to_search() {
    let mut view = state();
    view.handle_key(key(KeyCode::Up));
    view.handle_paste("no matching entry".into());
    view.handle_key(key(KeyCode::Down));
    assert_eq!(view.selected_visible_index(), None);
    view.handle_key(key(KeyCode::Up));
    assert!(view.search_focused());
}

#[test]
fn repeated_arrows_do_not_cross_focus_regions() {
    let mut view = state();
    let repeat = |code| {
        KeyEvent::new_with_kind(
            code,
            KeyModifiers::NONE,
            crossterm::event::KeyEventKind::Repeat,
        )
    };
    view.handle_key(repeat(KeyCode::Up));
    assert!(view.items_focused());
    view.handle_key(key(KeyCode::Up));
    view.handle_key(repeat(KeyCode::Up));
    view.handle_key(repeat(KeyCode::Down));
    assert!(view.search_focused());
}

#[test]
fn vertical_focus_skips_missing_regions() {
    let mut view = ListSelectionState::new(ListSelectionModel::new(
        "Items",
        vec![ListSelectionGroup::new(
            "All",
            vec![ListSelectionItem::new("One")],
        )],
    ));
    view.handle_key(key(KeyCode::Up));
    assert!(view.tabs_focused());
    view.handle_key(key(KeyCode::Down));
    assert!(view.items_focused());

    let mut view = ListSelectionState::new(
        ListSelectionModel::new(
            "Items",
            vec![ListSelectionGroup::new(
                "All",
                vec![ListSelectionItem::new("One")],
            )],
        )
        .without_tab_bar()
        .with_search(SearchBoxModel::new("Search")),
    );
    view.handle_key(key(KeyCode::Up));
    view.handle_key(key(KeyCode::Up));
    assert!(view.search_focused());
    view.handle_key(key(KeyCode::Down));
    assert!(view.items_focused());
}

#[test]
fn enter_only_actions_keep_space_available_for_search() {
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Themes",
            vec![ListSelectionGroup::new(
                "All",
                vec![
                    ListSelectionItem::new("Ash Code Dark")
                        .with_id(ListSelectionItemId::new("theme")),
                ],
            )],
        )
        .with_search(SearchBoxModel::new("Search themes")),
    );

    state.handle_key(key(KeyCode::Char('/')));
    for character in "ash code".chars() {
        state.handle_key(key(KeyCode::Char(character)));
    }

    assert_eq!(state.query(), "ash code");
    assert_eq!(state.visible_items()[0].label(), "Ash Code Dark");
}

#[test]
fn selection_without_search_ignores_text_and_space() {
    let mut state = ListSelectionState::new(ListSelectionModel::new(
        "Themes",
        vec![ListSelectionGroup::new(
            "Themes",
            vec![ListSelectionItem::new("Dark mode")],
        )],
    ));

    state.handle_key(key(KeyCode::Char(' ')));
    state.handle_key(key(KeyCode::Char('d')));

    assert!(state.search().is_none());
    assert_eq!(state.query(), "");
}

#[test]
fn escape_returns_from_search_before_dismissing_the_view() {
    let mut state = state();
    state.handle_key(key(KeyCode::Char('/')));
    for character in "jk/i p".chars() {
        state.handle_key(key(KeyCode::Char(character)));
    }
    assert_eq!(state.query(), "jk/i p");
    assert!(state.search_focused());
    assert_eq!(
        state.handle_key(key(KeyCode::Esc)),
        ListSelectionInputOutcome::Consumed
    );
    assert!(!state.search_focused());
    assert_eq!(state.query(), "jk/i p");
    assert_eq!(
        state.handle_key(key(KeyCode::Esc)),
        ListSelectionInputOutcome::Dismiss
    );
}

#[test]
fn paste_only_filters_while_search_is_focused() {
    let mut state = state();

    state.handle_paste("status".into());
    assert_eq!(state.query(), "");
    state.handle_key(key(KeyCode::Char('/')));
    state.handle_paste("status".into());

    assert_eq!(state.query(), "status");
    assert_eq!(state.visible_items()[0].label(), "/status");
}

#[test]
fn view_model_can_name_its_empty_state() {
    let state = ListSelectionState::new(
        ListSelectionModel::new("Skills", vec![ListSelectionGroup::new("All", Vec::new())])
            .with_empty_message("No configured skill sources"),
    );

    assert_eq!(state.empty_message(), "No configured skill sources");
    assert!(state.visible_items().is_empty());
}

#[test]
fn navigation_clamps_at_list_boundaries_and_only_press_activates() {
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Items",
            vec![ListSelectionGroup::new(
                "All",
                (0..20)
                    .map(|i| {
                        ListSelectionItem::new(format!("Item {i}"))
                            .with_id(ListSelectionItemId::new(i.to_string()))
                    })
                    .collect(),
            )],
        )
        .with_search(SearchBoxModel::new("Search")),
    );
    state.handle_key(key(KeyCode::Char('k')));
    assert!(!state.search_focused());
    state.handle_key(KeyEvent::new_with_kind(
        KeyCode::Char('j'),
        KeyModifiers::NONE,
        crossterm::event::KeyEventKind::Repeat,
    ));
    assert_eq!(state.selected_visible_index(), Some(1));
    state.handle_key(key(KeyCode::PageDown));
    assert_eq!(state.selected_visible_index(), Some(13));
    state.handle_key(key(KeyCode::End));
    state.handle_key(key(KeyCode::Char('j')));
    assert_eq!(state.selected_visible_index(), Some(19));
    for kind in [
        crossterm::event::KeyEventKind::Repeat,
        crossterm::event::KeyEventKind::Release,
    ] {
        for code in [
            KeyCode::Enter,
            KeyCode::Char(' '),
            KeyCode::Right,
            KeyCode::Esc,
            KeyCode::Char('/'),
        ] {
            assert_eq!(
                state.handle_key(KeyEvent::new_with_kind(code, KeyModifiers::NONE, kind)),
                ListSelectionInputOutcome::Consumed
            );
        }
    }
    assert!(matches!(
        state.handle_key(key(KeyCode::Enter)),
        ListSelectionInputOutcome::Activate(_)
    ));
}

#[test]
fn tab_from_items_focuses_empty_pages_and_repeat_does_not_switch() {
    use crossterm::event::KeyEventKind;
    let mut state = ListSelectionState::new(ListSelectionModel::new(
        "Config",
        vec![
            ListSelectionGroup::new(
                "First",
                vec![ListSelectionItem::new("Toggle").with_id(ListSelectionItemId::new("toggle"))],
            ),
            ListSelectionGroup::new("Empty", vec![]),
        ],
    ));
    assert_eq!(
        state.handle_key(key(KeyCode::Tab)),
        ListSelectionInputOutcome::Consumed
    );
    assert_eq!(active_tab_label(&state), "Empty");
    assert!(state.tabs_focused());
    assert_eq!(state.selected_visible_index(), None);
    for kind in [KeyEventKind::Repeat, KeyEventKind::Release] {
        state.handle_key(KeyEvent::new_with_kind(
            KeyCode::Tab,
            KeyModifiers::NONE,
            kind,
        ));
        assert_eq!(active_tab_label(&state), "Empty");
    }
    state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT));
    assert_eq!(active_tab_label(&state), "First");
    assert_eq!(state.selected_visible_index(), Some(0));
}

#[test]
fn hidden_tab_list_neither_switches_nor_adjusts_values_on_tab() {
    let mut state = ListSelectionState::new(
        ListSelectionModel::new(
            "Nested",
            vec![ListSelectionGroup::new(
                "Items",
                vec![ListSelectionItem::new("Toggle").with_id(ListSelectionItemId::new("toggle"))],
            )],
        )
        .without_tab_bar(),
    );
    for code in [KeyCode::Tab, KeyCode::BackTab] {
        assert_eq!(
            state.handle_key(key(code)),
            ListSelectionInputOutcome::Consumed
        );
        assert!(state.items_focused());
        assert_eq!(active_tab_label(&state), "Items");
    }
}

#[test]
fn tab_from_items_focuses_tabs_and_arrows_follow_the_visual_regions() {
    let mut view = state();
    assert!(view.items_focused());
    view.handle_key(key(KeyCode::Tab));
    assert!(view.tabs_focused());
    assert_eq!(view.active_tab().label(), "Keys");
    view.handle_key(key(KeyCode::Left));
    assert_eq!(view.active_tab().label(), "Commands");
    assert!(view.tabs_focused());
    view.handle_key(key(KeyCode::Down));
    assert!(view.search_focused());
    view.handle_key(key(KeyCode::Down));
    assert!(view.items_focused());
    view.handle_key(key(KeyCode::BackTab));
    assert!(view.tabs_focused());
    assert_eq!(view.active_tab().label(), "Keys");
}

#[test]
fn repeated_tab_does_not_move_focus_and_a_single_tab_still_receives_focus() {
    let mut view = ListSelectionState::new(ListSelectionModel::new(
        "One",
        vec![ListSelectionGroup::new(
            "Only",
            vec![ListSelectionItem::new("Item")],
        )],
    ));
    view.handle_key(KeyEvent::new_with_kind(
        KeyCode::Tab,
        KeyModifiers::NONE,
        crossterm::event::KeyEventKind::Repeat,
    ));
    assert!(view.items_focused());
    view.handle_key(key(KeyCode::Tab));
    assert!(view.tabs_focused());
    view.handle_key(key(KeyCode::Down));
    assert!(view.items_focused());
    view.handle_key(key(KeyCode::Up));
    assert!(view.tabs_focused());
}

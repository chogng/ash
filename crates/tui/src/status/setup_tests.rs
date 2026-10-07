use super::list_selection;
use crate::render::test_context;
use crate::status::StatusLineItem;
use crate::status::StatusLineSelectionAction;
use crate::status::StatusLineSettings;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionState;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use unicode_width::UnicodeWidthStr;

#[test]
fn setup_lists_each_item_with_a_searchable_description_and_toggle_action() {
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::GitChanges, false);
    let view = list_selection(&settings, 7);
    let list = ListSelection::new(view.model, view.actions.clone());
    assert_eq!(list.key_hints().text(), "Enter/Space toggle · Esc close");
    let state = list.state();

    assert_eq!(state.title(), "Status line");
    assert!(!state.show_tabs());
    assert_eq!(
        state
            .visible_items()
            .iter()
            .map(|item| (item.label(), item.description().unwrap().trim()))
            .collect::<Vec<_>>(),
        vec![
            ("Permissions", "Current permission mode on"),
            ("Model", "Configured model on"),
            ("Mode", "Mode for the next task off"),
            (
                "Cache hit rate",
                "Cached input as a share of total input off"
            ),
            (
                "Reference cost",
                "Current Thread accumulated reference cost off"
            ),
            (
                "Memory",
                "Local TUI, App Server, and child-process resident memory off",
            ),
            (
                "CPU",
                "Local TUI, App Server, and child-process CPU share off",
            ),
            ("Git branch", "Current Git branch on"),
            ("Git changes", "Working tree changes off"),
            ("Context", "Current Thread context usage off"),
        ]
    );
    assert!(matches!(
        view.actions
            .get(state.visible_items()[8].id().unwrap())
            .unwrap(),
        StatusLineSelectionAction::SetEnabled(edit)
            if edit.expected_revision == 7
                && edit.item == StatusLineItem::GitChanges
                && edit.enabled
    ));
}

#[test]
fn setup_aligns_items_and_switches_without_details() {
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::GitChanges, false);
    let view = list_selection(&settings, 1);
    let mut state = ListSelectionState::new(view.model);
    let backend = TestBackend::new(100, 10);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal
        .draw(|frame| {
            crate::widgets::list_selection::draw_body_with_pointer(
                frame,
                crate::render::horizontal_margin(frame.area(), 2),
                &state,
                None,
                None,
                test_context(),
            )
        })
        .unwrap();

    let buffer = terminal.backend().buffer();
    let rows = (0..10)
        .map(|row| {
            (0..100)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let permissions = rows.iter().find(|row| row.contains("Permissions")).unwrap();
    let model = rows.iter().find(|row| row.contains("Model")).unwrap();
    let git_branch = rows.iter().find(|row| row.contains("Git branch")).unwrap();
    let git_changes = rows.iter().find(|row| row.contains("Git changes")).unwrap();
    let cache_hit_rate = rows
        .iter()
        .find(|row| row.contains("Cache hit rate"))
        .unwrap();
    let reference_cost = rows
        .iter()
        .find(|row| row.contains("Reference cost"))
        .unwrap();
    let memory = rows.iter().find(|row| row.contains("Memory")).unwrap();
    let cpu = rows.iter().find(|row| row.contains("CPU")).unwrap();

    assert_eq!(column_of(permissions, "Permissions"), 2);
    assert_eq!(column_of(model, "Model"), 2);
    assert_eq!(column_of(cache_hit_rate, "Cache hit rate"), 2);
    assert_eq!(column_of(reference_cost, "Reference cost"), 2);
    assert_eq!(column_of(memory, "Memory"), 2);
    assert_eq!(column_of(cpu, "CPU"), 2);
    assert!(permissions.starts_with("> Permissions"));
    assert!(model.starts_with("  Model"));
    for row in [&permissions, &model, &git_branch, &git_changes] {
        assert_eq!(row.chars().nth(97), Some(' '));
    }

    let right_boundary = 96;
    assert_eq!(
        trailing_column_of(permissions, "on") + "on".len(),
        right_boundary
    );
    assert_eq!(trailing_column_of(model, "on") + "on".len(), right_boundary);
    assert_eq!(
        trailing_column_of(git_branch, "on") + "on".len(),
        right_boundary
    );
    assert_eq!(
        trailing_column_of(cache_hit_rate, "off") + "off".len(),
        right_boundary
    );
    assert_eq!(
        trailing_column_of(reference_cost, "off") + "off".len(),
        right_boundary
    );
    assert_eq!(
        trailing_column_of(memory, "off") + "off".len(),
        right_boundary
    );
    assert_eq!(trailing_column_of(cpu, "off") + "off".len(), right_boundary);
    assert_eq!(
        trailing_column_of(git_changes, "off") + "off".len(),
        right_boundary
    );

    let collapsed_rows = state.body_rows(100);
    state.handle_key(crate::keymap::KeyEvent::new(
        crossterm::event::KeyCode::Right,
        crossterm::event::KeyModifiers::NONE,
    ));
    assert_eq!(state.body_rows(100), collapsed_rows);

    crate::tui_assert_snapshot!("status_line_settings_with_accounting", rows.join("\n"));
}

fn column_of(row: &str, text: &str) -> usize {
    row[..row.find(text).unwrap()].width()
}

fn trailing_column_of(row: &str, text: &str) -> usize {
    row[..row.rfind(text).unwrap()].width()
}

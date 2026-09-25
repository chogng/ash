use super::draw_body_with_pointer;
use super::draw_tabs;
use crate::render::horizontal_margin;
use crate::render::test_context;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;

#[test]
fn overflowing_lists_keep_selection_visible_and_notices_inside_the_area() {
    use ratatui::layout::Rect;
    let mut view = ListSelectionState::new(
        ListSelectionModel::new(
            "Items",
            vec![ListSelectionGroup::new(
                "All",
                (0..30)
                    .map(|index| {
                        ListSelectionItem::new(format!("Item {index}")).with_id(
                            crate::widgets::list_selection::ListSelectionItemId::new(
                                index.to_string(),
                            ),
                        )
                    })
                    .collect(),
            )],
        )
        .without_tab_bar(),
    );
    assert_eq!(view.body_rows(80), 30);
    for height in 1..35 {
        for selected in 0..30 {
            assert!(view.select_visible_item(selected));
            let area = Rect::new(2, 0, 38, height);
            let viewport = super::ListViewport::new(area, 30, Some(selected));
            assert!(viewport.start <= selected && selected < viewport.end);
            assert!(viewport.below.bottom() <= area.bottom());
        }
    }
    view.select_visible_item(14);
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(
                frame,
                frame.area(),
                &view,
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let rendered = terminal.backend().to_string();
    assert!(rendered.contains("9 more above"));
    assert!(rendered.contains("15 more below"));
    let mut terminal = Terminal::new(TestBackend::new(40, 30)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(
                frame,
                frame.area(),
                &view,
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    assert!(!terminal.backend().to_string().contains("more"));
}

fn state() -> ListSelectionState {
    ListSelectionState::new(
        ListSelectionModel::new(
            "Skills",
            vec![ListSelectionGroup::new(
                "All (1)",
                vec![ListSelectionItem::new("skill-creator")],
            )],
        )
        .with_search(SearchBoxModel::new("Search available skills")),
    )
}

fn render(state: &ListSelectionState) -> Buffer {
    render_with_pointer(state, None)
}

fn render_with_item_hover(state: &ListSelectionState, hovered_item: usize) -> Buffer {
    render_with_pointer(state, Some(hovered_item))
}

fn render_with_pointer(state: &ListSelectionState, hovered_item: Option<usize>) -> Buffer {
    let backend = TestBackend::new(40, 10);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            let content = horizontal_margin(frame.area(), 2);
            let tab_rows = state.tab_rows(content.width);
            let tabs = ratatui::layout::Rect::new(content.x, content.y, content.width, tab_rows);
            let body = ratatui::layout::Rect::new(
                content.x,
                content.y.saturating_add(tab_rows),
                content.width,
                content.height.saturating_sub(tab_rows),
            );
            draw_tabs(frame, tabs, state, None, None, test_context());
            draw_body_with_pointer(
                frame,
                body,
                state,
                hovered_item
                    .and_then(|index| {
                        state
                            .visible_items()
                            .get(index)
                            .and_then(|item| item.id())
                            .cloned()
                    })
                    .map(super::ListSelectionPointerTarget::Item)
                    .as_ref(),
                None,
                test_context(),
            );
        })
        .unwrap();
    terminal.backend().buffer().clone()
}

#[test]
fn ruled_sections_have_one_blank_row_and_no_pointer_target_on_the_divider() {
    let state = ListSelectionState::new(
        ListSelectionModel::new(
            "Providers",
            vec![ListSelectionGroup::new(
                "All",
                vec![
                    ListSelectionItem::new("Subscriptions").as_section_divider(),
                    ListSelectionItem::new("ChatGPT").with_id(ListSelectionItemId::new("chatgpt")),
                    ListSelectionItem::new("API").as_section_divider(),
                    ListSelectionItem::new("OpenAI").with_id(ListSelectionItemId::new("openai")),
                ],
            )],
        )
        .without_tab_bar(),
    );
    let buffer = render(&state);

    assert_eq!(
        state.item_rows(36),
        vec![(0, 0), (1, 0), (2, 1), (2, 0), (3, 0)]
    );
    assert_eq!(buffer[(2, 0)].symbol(), "S");
    assert_eq!(buffer[(16, 0)].symbol(), "─");
    assert_eq!(buffer[(2, 1)].symbol(), "C");
    assert_eq!(buffer[(2, 2)].symbol(), " ");
    assert_eq!(buffer[(2, 3)].symbol(), "A");
    assert_eq!(buffer[(6, 3)].symbol(), "─");

    let body = ratatui::layout::Rect::new(2, 0, 36, 10);
    assert_eq!(
        super::pointer_target_at(
            &state,
            ratatui::layout::Rect::default(),
            body,
            ratatui::layout::Position::new(2, 2),
        ),
        None
    );

    let mut narrow = Terminal::new(TestBackend::new(12, 6)).unwrap();
    narrow
        .draw(|frame| {
            draw_body_with_pointer(frame, frame.area(), &state, None, None, test_context());
        })
        .unwrap();
    let narrow = narrow.backend().buffer();
    assert_eq!(narrow[(2, 0)].symbol(), "S");
    assert_eq!(narrow[(6, 3)].symbol(), "─");
}

#[test]
fn tabs_search_and_items_share_the_same_state_column() {
    let state = state();
    let buffer = render(&state);

    assert_eq!(
        buffer[(2, 0)].bg,
        test_context().accent_surface_background()
    );
    assert_eq!(buffer[(2, 1)].symbol(), "╭");
    assert_eq!(buffer[(0, 4)].symbol(), ">");
    assert_eq!(buffer[(2, 4)].symbol(), "s");
}

#[test]
fn item_marker_is_visible_only_while_the_list_has_focus() {
    let mut state = state();

    let items = render(&state);
    assert_eq!(items[(0, 4)].symbol(), ">");

    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    let search = render(&state);
    assert_eq!(search[(0, 2)].symbol(), " ");
    assert_eq!(search[(0, 4)].symbol(), " ");
    assert_eq!(state.selected_visible_index(), Some(0));

    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    let tabs = render(&state);
    assert_eq!(tabs[(0, 0)].symbol(), " ");
    assert_eq!(tabs[(0, 4)].symbol(), " ");
    assert_eq!(state.selected_visible_index(), Some(0));

    state.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let items = render(&state);
    assert_eq!(items[(0, 4)].symbol(), ">");
}

#[test]
fn keyboard_selection_and_a_different_hovered_row_remain_visible_together() {
    let state = ListSelectionState::new(
        ListSelectionModel::new(
            "Items",
            vec![ListSelectionGroup::new(
                "All",
                vec![
                    ListSelectionItem::new("First").with_id(ListSelectionItemId::new("first")),
                    ListSelectionItem::new("Second").with_id(ListSelectionItemId::new("second")),
                ],
            )],
        )
        .without_tab_bar(),
    );

    let buffer = render_with_item_hover(&state, 1);

    assert_eq!(buffer[(0, 0)].symbol(), ">");
    assert_eq!(buffer[(2, 0)].fg, test_context().selection_foreground());
    assert_eq!(buffer[(2, 0)].bg, test_context().selection_background());
    assert_eq!(buffer[(0, 1)].symbol(), " ");
    assert_eq!(buffer[(2, 1)].fg, test_context().hover_foreground());
    assert_eq!(buffer[(2, 1)].bg, test_context().hover_background());
}

#[test]
fn expanded_descriptions_wrap_and_follow_items_after_filtering_and_refresh() {
    use ratatui::layout::Rect;
    let model = ListSelectionModel::new(
        "Config",
        vec![ListSelectionGroup::new(
            "General",
            vec![
                ListSelectionItem::new("First")
                    .with_id(ListSelectionItemId::new("first"))
                    .with_columns(
                        "First",
                        "A long description that wraps across several narrow terminal lines.",
                        "off",
                    ),
                ListSelectionItem::new("Second")
                    .with_id(ListSelectionItemId::new("second"))
                    .with_columns("Second", "Another explanation", "on"),
            ],
        )],
    )
    .without_tab_bar()
    .with_expandable_descriptions()
    .with_search(SearchBoxModel::new("Search"));
    let mut view = ListSelectionState::new(model.clone());
    view.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    assert!(view.expanded(view.selected_item().unwrap()));
    view.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    view.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    view.replace_model(model);
    assert!(view.visible_items().iter().all(|item| view.expanded(item)));
    let mut terminal = Terminal::new(TestBackend::new(32, 12)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(
                frame,
                Rect::new(2, 0, 30, 12),
                &view,
                None,
                None,
                test_context(),
            )
        })
        .unwrap();
    crate::tui_assert_snapshot!(
        "narrow_expanded_descriptions",
        terminal.backend().to_string()
    );
    view.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    view.handle_paste("explanation".into());
    assert_eq!(view.visible_items().len(), 1);
    assert_eq!(view.visible_items()[0].label(), "Second");
    assert!(view.expanded(view.visible_items()[0]));
    view.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    view.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    assert!(!view.expanded(view.visible_items()[0]));
}

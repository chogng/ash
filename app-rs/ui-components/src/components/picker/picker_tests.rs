use super::Picker;
use super::PickerIds;
use super::PickerItem;
use super::PickerStyle;
use crate::ButtonBackgrounds;
use crate::ButtonStyle;
use crate::CaretVisibility;
use crate::Color;
use crate::InputBoxStateColors;
use crate::InputBoxStyle;
use crate::Rect;
use crate::ScrollState;
use crate::ScrollViewStyle;
use crate::ScrollbarStyle;
use crate::SearchBoxStyle;
use crate::Size;
use crate::TextInput;
use crate::TextInputLayoutEngine;
use crate::TextStyle;
use crate::UiDispatch;
use ash_icons::icons;

const PARENT: crate::ElementId = crate::ElementId::scoped(30, 1);
const ROOT: crate::ElementId = crate::ElementId::scoped(30, 2);
const SEARCH: crate::ElementId = crate::ElementId::scoped(30, 3);

#[test]
fn picker_limits_visible_rows_and_keeps_search_separate() {
    let mut text_layout = TextInputLayoutEngine::default();
    let dispatch = UiDispatch::default();
    let items = (0..10)
        .map(|index| {
            PickerItem::new(
                crate::ElementId::scoped(30, 10 + index),
                format!("Item {index}"),
            )
        })
        .collect();
    let picker = Picker::new(
        Rect::from_xywh(0.0, 0.0, 800.0, 600.0),
        Rect::from_xywh(40.0, 500.0, 120.0, 24.0),
        "items",
        "Search items...",
        &TextInput::default(),
        CaretVisibility::Hidden,
        items,
        ScrollState::default(),
        PickerIds::new(PARENT, ROOT, SEARCH),
        style(),
        &mut text_layout,
        &dispatch,
    );

    assert_eq!(picker.item_viewport_bounds().size.height, 4.0 * 30.0);
    assert_eq!(picker.bounds().size.height, 36.0 + 4.0 * 30.0 + 8.0);
    assert!(picker.scroll_metrics().is_some());
}

fn style() -> PickerStyle {
    let black = Color::rgb(0, 0, 0);
    let input = InputBoxStyle::new(
        InputBoxStateColors::new(Color::WHITE, Color::WHITE, Color::WHITE),
        InputBoxStateColors::new(black, black, black),
        TextStyle::new(13.0, black),
        TextStyle::new(13.0, black),
    );
    PickerStyle::new(
        Color::WHITE,
        ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            TextStyle::new(13.0, black),
        ),
        SearchBoxStyle::new(input, icons::SEARCH, black),
        ScrollViewStyle::new(ScrollbarStyle::new(Color::TRANSPARENT, black)),
        Size::new(320.0, 30.0),
        4,
    )
}

use super::{ListItem, ListItemBackgrounds, ListItemSelection, ListItemState, ListItemStyle};
use crate::{Color, CornerRadii, Rect, UiScene};

#[test]
fn selected_list_item_uses_selected_surface_style() {
    let selected = Color::rgb(235, 235, 237);
    let item = ListItem::new(
        Rect::from_xywh(10.0, 20.0, 180.0, 52.0),
        ListItemState::Resting,
        ListItemStyle::new(ListItemBackgrounds::new(Color::TRANSPARENT))
            .with_selected_backgrounds(ListItemBackgrounds::new(selected))
            .with_corner_radii(CornerRadii::uniform(4.0)),
    )
    .with_selection(ListItemSelection::Selected);
    let mut scene = UiScene::new(Color::WHITE);

    scene.draw_component(&item);

    assert_eq!(scene.rects()[0].fill(), selected);
    assert_eq!(scene.rects()[0].bounds(), item.bounds());
    assert_eq!(scene.rects()[0].corner_radii(), CornerRadii::uniform(4.0));
}

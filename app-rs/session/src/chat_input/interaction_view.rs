use ash_ui_components::ListView;
use ash_ui_components::ScrollState;
use zui::ui::AccessibilityRole;
use zui::ui::AccessibilitySelection;
use zui::ui::Border;
use zui::ui::ComponentContext;
use zui::ui::CornerRadii;
use zui::ui::CursorFeedback;
use zui::ui::FontFamily;
use zui::ui::FontWeight;
use zui::ui::NodeAction;
use zui::ui::PaintRect;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextBlock;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;

use crate::SessionPaneStyle;
use crate::interaction::COMPOSER_INTERACTION;
use crate::interaction::COMPOSER_PANEL;
use crate::interaction::composer_interaction_item_id;

use super::ChatInputInteractionView;
use super::INTERACTION_ROW_HEIGHT;
use super::interaction_list_bounds;

const INTERACTION_TEXT_INSET: f32 = 10.0;

pub(crate) fn draw_chat_input_interaction(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    view: ChatInputInteractionView<'_>,
    scroll_state: ScrollState,
    dispatch: &UiDispatch,
    style: SessionPaneStyle,
) {
    let interaction = ash_ui_components::InteractionRegion::new(
        "ComposerInteraction",
        COMPOSER_INTERACTION,
        bounds,
        AccessibilityRole::List,
        view.title(),
    )
    .with_parent(COMPOSER_PANEL);
    context.with_component(&interaction, |context, _| {
        context.scene_mut().draw_rect(
            PaintRect::new(bounds, style.surface_raised)
                .with_border(Border::uniform(1.0, style.border))
                .with_corner_radii(CornerRadii::uniform(6.0)),
        );
        let title = if view.can_go_back() {
            format!("← {}", view.title())
        } else {
            view.title().to_owned()
        };
        context.scene_mut().draw_text(TextBlock::new(
            title,
            Point::new(
                bounds.origin.x + INTERACTION_TEXT_INSET,
                bounds.origin.y + 5.0,
            ),
            Size::new(
                (bounds.size.width - INTERACTION_TEXT_INSET * 2.0).max(1.0),
                20.0,
            ),
            TextStyle::new(12.0, style.text)
                .with_family(FontFamily::Monospace)
                .with_weight(FontWeight::Bold)
                .with_line_height(20.0),
        ));
        let list_bounds = interaction_list_bounds(bounds);
        if view.items().is_empty() {
            context.scene_mut().draw_text(TextBlock::new(
                "No matching items",
                Point::new(
                    list_bounds.origin.x + INTERACTION_TEXT_INSET,
                    list_bounds.origin.y + 7.0,
                ),
                Size::new(
                    (list_bounds.size.width - INTERACTION_TEXT_INSET * 2.0).max(1.0),
                    INTERACTION_ROW_HEIGHT,
                ),
                TextStyle::new(12.0, style.text_muted)
                    .with_family(FontFamily::Monospace)
                    .with_line_height(20.0),
            ));
            return;
        }
        let list = ListView::new(
            list_bounds,
            view.items().len(),
            INTERACTION_ROW_HEIGHT,
            scroll_state,
            style.scroll_view,
        );
        for index in list.visible_range() {
            let item_bounds = list
                .item_bounds(index)
                .expect("visible interaction item")
                .intersection(list_bounds);
            let id = composer_interaction_item_id(index);
            context.draw_component(
                &ash_ui_components::InteractionRegion::new(
                    "ComposerInteractionItem",
                    id,
                    item_bounds,
                    AccessibilityRole::ListItem,
                    format!(
                        "{}, {}",
                        view.items()[index].label(),
                        view.items()[index].description()
                    ),
                )
                .with_parent(COMPOSER_INTERACTION)
                .with_cursor(CursorFeedback::Pointer)
                .with_action(NodeAction::Activate)
                .with_selection(if index == view.selected() {
                    AccessibilitySelection::Selected
                } else {
                    AccessibilitySelection::Unselected
                }),
            );
        }
        list.draw(context.scene_mut(), |scene, layout| {
            let index = layout.index();
            let item = &view.items()[index];
            let item_bounds = layout.bounds();
            let y = item_bounds.origin.y;
            let id = composer_interaction_item_id(index);
            let selected = index == view.selected();
            if selected || dispatch.is_hovered(id) || dispatch.is_pressed(id) {
                scene.draw_rect(PaintRect::new(
                    item_bounds,
                    if selected {
                        style.selected
                    } else {
                        style.surface_hovered
                    },
                ));
            }
            let label_width = (item_bounds.size.width * 0.34).max(100.0);
            scene.draw_text(TextBlock::new(
                item.label(),
                Point::new(item_bounds.origin.x + INTERACTION_TEXT_INSET, y + 7.0),
                Size::new(label_width, 20.0),
                TextStyle::new(12.0, style.text)
                    .with_family(FontFamily::Monospace)
                    .with_line_height(20.0),
            ));
            scene.draw_text(TextBlock::new(
                item.description(),
                Point::new(
                    item_bounds.origin.x + INTERACTION_TEXT_INSET + label_width,
                    y + 7.0,
                ),
                Size::new(
                    (item_bounds.size.width - INTERACTION_TEXT_INSET * 3.0 - label_width).max(1.0),
                    20.0,
                ),
                TextStyle::new(12.0, style.text_muted)
                    .with_family(FontFamily::Monospace)
                    .with_line_height(20.0),
            ));
        });
    });
}

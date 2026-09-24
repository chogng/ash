//! Hover details for the directories attached to one Sidebar Session item.

use crate::AccessibilityRole;
use crate::ActionList;
use crate::ActionListStyle;
use crate::ActionViewItem;
use crate::Border;
use crate::BoxShadow;
use crate::ButtonBackgrounds;
use crate::ButtonState;
use crate::ButtonStyle;
use crate::Color;
use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::ContextView;
use crate::ContextViewAnchorAxis;
use crate::ContextViewAnchorPosition;
use crate::ContextViewPlacement;
use crate::ContextViewStyle;
use crate::CornerRadii;
use crate::Edges;
use crate::Element;
use crate::InteractionRegion;
use crate::PaintRect;
use crate::Point;
use crate::Rect;
use crate::Size;
use crate::TextBlock;
use crate::TextSpan;
use crate::UiScene;
use ash_icons::icons;
use zui::ui::CursorFeedback;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::NodeAction;

use super::WorkbenchUiStyle;
use super::session_items::SessionListItem;

const WIDTH: f32 = 360.0;
const HEADER_HEIGHT: f32 = 22.0;
const ROW_HEIGHT: f32 = 24.0;
const SECTION_GAP: f32 = 8.0;
const PREVIEW_SCOPE: u32 = 31;
const NAME_SCOPE: u32 = 32;
const DIRS_SCOPE: u32 = 33;

pub(super) fn dirs_preview_id(item: ElementId) -> ElementId {
    ElementId::scoped(PREVIEW_SCOPE, mounted_element_local_id(item))
}

pub(super) fn dirs_preview_name_id(item: ElementId) -> ElementId {
    ElementId::scoped(NAME_SCOPE, mounted_element_local_id(item))
}

fn mounted_element_local_id(element: ElementId) -> u32 {
    (element.into_raw() & u64::from(u32::MAX)) as u32
}

pub(super) struct ItemDirsPreview<'a> {
    viewport: Rect,
    anchor: Rect,
    item: &'a SessionListItem<'a>,
    style: WorkbenchUiStyle,
}

impl<'a> ItemDirsPreview<'a> {
    pub(super) const fn new(
        viewport: Rect,
        anchor: Rect,
        item: &'a SessionListItem<'a>,
        style: WorkbenchUiStyle,
    ) -> Self {
        Self {
            viewport,
            anchor,
            item,
            style,
        }
    }

    fn header(&self, bounds: Rect) -> TextBlock {
        let name = self
            .style
            .control_text
            .clone()
            .with_color(self.style.colors.hover_foreground)
            .with_line_height(20.0);
        let status_color = self.style.session_status_color(self.item.status.kind());
        let status = self
            .style
            .metadata_text
            .clone()
            .with_color(status_color)
            .with_line_height(20.0);
        TextBlock::from_spans(
            [
                TextSpan::new(format!("{}  ", self.item.name), name.clone()),
                TextSpan::new(self.item.status.label(), status),
            ],
            bounds.origin,
            Size::new(bounds.size.width, 20.0),
            name,
        )
    }

    fn action_list(&self, bounds: Rect) -> ActionList {
        let button_style = ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            self.style
                .label_text
                .clone()
                .with_color(self.style.colors.hover_foreground),
        )
        .with_corner_radii(CornerRadii::uniform(0.0))
        .with_padding(Edges::new(3.0, 0.0, 3.0, 0.0))
        .with_icon_size(14.0)
        .with_content_gap(8.0);
        let items = self
            .item
            .dirs
            .iter()
            .map(|dir| {
                ActionViewItem::icon_and_label(
                    icons::FOLDERS,
                    dir.to_string_lossy(),
                    ButtonState::Resting,
                )
            })
            .collect();
        ActionList::new(
            bounds,
            items,
            ActionListStyle::new(button_style, ROW_HEIGHT),
        )
    }
}

impl Component for ItemDirsPreview<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("ItemDirsPreviewHost").in_bounds(self.anchor)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        let list_height = self.item.dirs.len() as f32 * ROW_HEIGHT;
        let section_gap = if self.item.dirs.is_empty() {
            0.0
        } else {
            SECTION_GAP
        };
        let preview = ContextView::new(
            self.viewport,
            self.anchor,
            Size::new(WIDTH, HEADER_HEIGHT + section_gap + list_height),
            ContextViewPlacement::new()
                .with_axis(ContextViewAnchorAxis::Horizontal)
                .with_position(ContextViewAnchorPosition::After)
                .with_gap(8.0)
                .with_viewport_margin(8.0),
            ContextViewStyle::new(self.style.colors.hover_background)
                .with_corner_radii(CornerRadii::uniform(6.0))
                .with_padding(Edges::uniform(12.0))
                .with_shadow(
                    BoxShadow::new(self.style.colors.hover_shadow)
                        .with_offset(Point::new(0.0, 4.0))
                        .with_blur_radius(12.0),
                ),
        );
        preview.draw_components(context, |context, content_bounds| {
            let preview_id = dirs_preview_id(self.item.id);
            context.draw_component(
                &InteractionRegion::new(
                    "ItemDirsPreview",
                    preview_id,
                    preview.bounds(),
                    AccessibilityRole::Group,
                    format!("Session details for {}", self.item.name),
                )
                .with_parent(self.item.id),
            );
            context.scene_mut().draw_rect(
                PaintRect::new(preview.bounds(), Color::TRANSPARENT)
                    .with_border(Border::uniform(1.0, self.style.colors.hover_border))
                    .with_corner_radii(CornerRadii::uniform(6.0)),
            );
            let header_bounds = Rect::from_xywh(
                content_bounds.origin.x,
                content_bounds.origin.y,
                content_bounds.size.width,
                HEADER_HEIGHT,
            );
            context.draw_component(
                &InteractionRegion::new(
                    "SessionName",
                    dirs_preview_name_id(self.item.id),
                    header_bounds,
                    AccessibilityRole::Button,
                    format!("Rename {}", self.item.name),
                )
                .with_parent(preview_id)
                .with_cursor(CursorFeedback::Pointer)
                .with_focus(FocusBehavior::TabStop)
                .with_action(NodeAction::Activate),
            );
            context.scene_mut().draw_text(self.header(header_bounds));
            if self.item.dirs.is_empty() {
                return;
            }
            let list_bounds = Rect::from_xywh(
                content_bounds.origin.x,
                header_bounds.bottom() + SECTION_GAP,
                content_bounds.size.width,
                list_height,
            );
            context.draw_component(
                &InteractionRegion::new(
                    "SessionDirectories",
                    ElementId::scoped(DIRS_SCOPE, mounted_element_local_id(self.item.id)),
                    list_bounds,
                    AccessibilityRole::List,
                    "Directories",
                )
                .with_parent(preview_id),
            );
            context.draw_component(&self.action_list(list_bounds));
        });
    }

    fn paint(&self, _scene: &mut UiScene) {}
}

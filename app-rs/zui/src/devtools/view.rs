use crate::ui::Border;
use crate::ui::Color;
use crate::ui::FontWeight;
use crate::ui::InspectionFrame;
use crate::ui::PaintIcon;
use crate::ui::PaintRect;
use crate::ui::Point;
use crate::ui::Rect;
use crate::ui::Size;
use crate::ui::TextStyle;
use crate::ui::UiScene;

use super::DevToolsHandle;
use super::assets;
use super::view_text::paint_computed;
use super::view_text::paint_message;
use super::view_text::paint_text;
pub(crate) use super::view_tree::ROW_HEIGHT;
use super::view_tree::TOOLBAR_HEIGHT;
pub(crate) use super::view_tree::TreeHit;
use super::view_tree::clamped_scroll;
use super::view_tree::computed_bounds;
use super::view_tree::tree_bounds;
pub(crate) use super::view_tree::tree_hit_at;
pub(crate) use super::view_tree::tree_rows;

const BACKGROUND: Color = Color::rgb(248, 248, 250);
const BORDER: Color = Color::rgb(218, 218, 224);
const FOREGROUND: Color = Color::rgb(35, 35, 42);
const MUTED: Color = Color::rgb(105, 105, 116);
const ACCENT: Color = Color::rgb(35, 131, 226);
const ROW_BACKGROUND: Color = Color::rgba(35, 131, 226, 24);
const HOVER_ROW_BACKGROUND: Color = Color::rgb(237, 237, 241);
const CONTENT_PADDING: f32 = 16.0;
const ACTION_WIDTH: f32 = 74.0;
const ACTION_HEIGHT: f32 = 28.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ToolbarAction {
    Pick,
    Close,
}

pub(crate) fn toolbar_action_at(bounds: Rect, point: Point) -> Option<ToolbarAction> {
    let toolbar = toolbar_bounds(bounds);
    [ToolbarAction::Pick, ToolbarAction::Close]
        .into_iter()
        .find(|action| action_bounds(toolbar, *action).contains(point))
}

pub(crate) fn compose(
    size: Size,
    frame: Option<&InspectionFrame>,
    devtools: &DevToolsHandle,
) -> UiScene {
    let bounds = Rect::from_xywh(0.0, 0.0, size.width.max(0.0), size.height.max(0.0));
    let mut scene = UiScene::new(BACKGROUND);
    if bounds.is_empty() {
        return scene;
    }

    scene.draw_rect(PaintRect::new(bounds, BACKGROUND).with_border(Border::uniform(1.0, BORDER)));
    let toolbar = toolbar_bounds(bounds);
    scene.draw_rect(
        PaintRect::new(toolbar, Color::WHITE).with_border(Border::new(
            crate::ui::Edges::new(0.0, 0.0, 1.0, 0.0),
            BORDER,
        )),
    );
    paint_button(
        &mut scene,
        action_bounds(toolbar, ToolbarAction::Pick),
        assets::PICK,
        if devtools.is_picking() {
            "Stop"
        } else {
            "Pick"
        },
        devtools.is_picking(),
    );
    paint_toolbar_tab(&mut scene, elements_tab_bounds(toolbar), "Elements", true);
    paint_button(
        &mut scene,
        action_bounds(toolbar, ToolbarAction::Close),
        assets::CLOSE,
        "Close",
        false,
    );

    let content = content_bounds(bounds);
    scene.with_clip(content, |scene| {
        let Some(frame) = frame else {
            paint_message(
                scene,
                "Waiting for the application to present an inspectable scene.",
                content,
                CONTENT_PADDING,
                MUTED,
            );
            return;
        };
        let tree = tree_bounds(content);
        let computed = computed_bounds(content);
        if !computed.is_empty() {
            scene.draw_rect(PaintRect::new(computed, Color::WHITE));
        }
        if computed.origin.x > tree.right() {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(tree.right(), content.origin.y, 1.0, content.size.height),
                BORDER,
            ));
        }
        let rows = tree_rows(frame, devtools);
        let selection = devtools.selection();
        let selected_id = selection
            .as_ref()
            .and_then(|selection| selection.target().map(|node| node.id()));
        let hovered_id = devtools.hovered_tree_node();
        if let Some(index) =
            selected_id.and_then(|id| rows.iter().position(|tree_row| tree_row.id == id))
        {
            devtools.ensure_row_visible(index, ROW_HEIGHT, tree.size.height);
        }
        let scroll = clamped_scroll(devtools.scroll_offset(), rows.len(), tree.size.height);
        devtools.set_scroll_offset(scroll);
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(tree.origin.x, tree.origin.y, tree.size.width, 1.0),
            BORDER,
        ));
        for (index, tree_row) in rows.iter().enumerate() {
            let y = tree.origin.y + index as f32 * ROW_HEIGHT - scroll;
            if y + ROW_HEIGHT <= tree.origin.y {
                continue;
            }
            if y >= tree.bottom() {
                break;
            }
            let row = Rect::from_xywh(tree.origin.x, y, tree.size.width, ROW_HEIGHT);
            let selected = selected_id == Some(tree_row.id);
            if hovered_id == Some(tree_row.id) && !selected {
                scene.draw_rect(PaintRect::new(row, HOVER_ROW_BACKGROUND));
            }
            if selected {
                scene.draw_rect(PaintRect::new(row, ROW_BACKGROUND));
                scene.draw_rect(PaintRect::new(
                    Rect::from_xywh(row.origin.x, row.origin.y, 3.0, row.size.height),
                    ACCENT,
                ));
            }
            let Some(node) = frame.node(tree_row.id) else {
                continue;
            };
            paint_row(
                scene,
                row,
                node,
                tree_row.depth,
                tree_row.has_children,
                devtools.is_collapsed(tree_row.id),
                selected,
            );
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(
                    row.origin.x + CONTENT_PADDING,
                    row.bottom() - 1.0,
                    (row.size.width - CONTENT_PADDING).max(0.0),
                    1.0,
                ),
                BORDER,
            ));
        }
        paint_computed(
            scene,
            computed,
            selection.as_ref().and_then(|selection| selection.target()),
        );
    });
    scene
}

pub(crate) fn decorate_product_scene(
    scene: &UiScene,
    devtools: &DevToolsHandle,
) -> Option<UiScene> {
    let selection = devtools
        .hovered_tree_selection()
        .or_else(|| devtools.selection())?;
    let mut decorated = scene.clone();
    decorated.with_overlay(|scene| paint_selection(scene, &selection));
    Some(decorated)
}

fn toolbar_bounds(bounds: Rect) -> Rect {
    Rect::from_xywh(
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        TOOLBAR_HEIGHT.min(bounds.size.height),
    )
}

fn content_bounds(bounds: Rect) -> Rect {
    let toolbar = toolbar_bounds(bounds);
    Rect::from_xywh(
        bounds.origin.x,
        toolbar.bottom(),
        bounds.size.width,
        (bounds.size.height - toolbar.size.height).max(0.0),
    )
}

fn action_bounds(toolbar: Rect, action: ToolbarAction) -> Rect {
    let x = match action {
        ToolbarAction::Pick => toolbar.origin.x + CONTENT_PADDING,
        ToolbarAction::Close => toolbar.right() - ACTION_WIDTH - CONTENT_PADDING,
    };
    Rect::from_xywh(
        x.max(toolbar.origin.x + CONTENT_PADDING),
        toolbar.origin.y + (toolbar.size.height - ACTION_HEIGHT) * 0.5,
        ACTION_WIDTH - 6.0,
        ACTION_HEIGHT,
    )
}

fn elements_tab_bounds(toolbar: Rect) -> Rect {
    let pick = action_bounds(toolbar, ToolbarAction::Pick);
    Rect::from_xywh(
        pick.right() + CONTENT_PADDING,
        toolbar.origin.y,
        88.0,
        toolbar.size.height,
    )
}

fn paint_button(
    scene: &mut UiScene,
    bounds: Rect,
    icon: crate::ui::Icon,
    label: &str,
    selected: bool,
) {
    let icon_color = if selected { ACCENT } else { FOREGROUND };
    scene.draw_rect(
        PaintRect::new(
            bounds,
            if selected {
                Color::rgba(35, 131, 226, 40)
            } else {
                Color::TRANSPARENT
            },
        )
        .with_border(Border::uniform(1.0, if selected { ACCENT } else { BORDER })),
    );
    scene.draw_icon(PaintIcon::new(
        icon,
        Rect::from_xywh(
            bounds.origin.x + 8.0,
            bounds.origin.y + (bounds.size.height - 14.0) * 0.5,
            14.0,
            14.0,
        ),
        icon_color,
    ));
    paint_text(
        scene,
        label,
        Point::new(bounds.origin.x + 28.0, bounds.origin.y + 6.0),
        (bounds.size.width - 34.0).max(0.0),
        TextStyle::new(11.0, icon_color)
            .with_weight(FontWeight::Bold)
            .with_line_height(15.0),
    );
}

fn paint_toolbar_tab(scene: &mut UiScene, bounds: Rect, label: &str, selected: bool) {
    let color = if selected { ACCENT } else { MUTED };
    paint_text(
        scene,
        label,
        Point::new(bounds.origin.x + 12.0, bounds.origin.y + 14.0),
        (bounds.size.width - 24.0).max(0.0),
        TextStyle::new(12.0, color)
            .with_weight(FontWeight::Bold)
            .with_line_height(18.0),
    );
    if selected {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(
                bounds.origin.x,
                bounds.bottom() - 2.0,
                bounds.size.width,
                2.0,
            ),
            ACCENT,
        ));
    }
}

fn paint_row(
    scene: &mut UiScene,
    row: Rect,
    node: &crate::ui::InspectionNode,
    depth: usize,
    has_children: bool,
    collapsed: bool,
    selected: bool,
) {
    let x = row.origin.x + CONTENT_PADDING + depth as f32 * 12.0;
    let width = (row.size.width - (x - row.origin.x) - CONTENT_PADDING).max(0.0);
    let title = node
        .label()
        .map(|label| format!("{}  {label}", node.name()))
        .unwrap_or_else(|| node.name().to_owned());
    if has_children {
        scene.draw_icon(PaintIcon::new(
            if collapsed {
                assets::ANCESTOR
            } else {
                assets::EXPANDED
            },
            Rect::from_xywh(x, row.origin.y + 8.0, 12.0, 12.0),
            if selected { ACCENT } else { MUTED },
        ));
    }
    let label_origin = Point::new(x + 18.0, row.origin.y + 8.0);
    paint_text(
        scene,
        &title,
        label_origin,
        (width - 18.0).max(0.0),
        TextStyle::new(12.0, if selected { ACCENT } else { FOREGROUND })
            .with_weight(FontWeight::Bold)
            .with_line_height(16.0),
    );
}

fn paint_selection(scene: &mut UiScene, selection: &super::InspectionSelection) {
    let Some(target) = selection.target() else {
        return;
    };
    paint_padding(scene, target);
    for gap in target.gap_regions() {
        let bounds = target.bounds().intersection(*gap);
        if !bounds.is_empty() {
            scene.draw_rect(PaintRect::new(bounds, Color::rgba(45, 184, 164, 112)));
        }
    }
    for (index, node) in selection
        .path()
        .iter()
        .take(selection.selected_index() + 1)
        .enumerate()
    {
        scene.draw_rect(
            PaintRect::new(node.bounds(), Color::TRANSPARENT).with_border(Border::uniform(
                if index == selection.selected_index() {
                    2.0
                } else {
                    1.0
                },
                if index == selection.selected_index() {
                    ACCENT
                } else {
                    Color::rgba(116, 92, 217, 150)
                },
            )),
        );
    }
}

fn paint_padding(scene: &mut UiScene, node: &crate::ui::InspectionNode) {
    let Some(padding) = node.padding() else {
        return;
    };
    let bounds = node.bounds();
    let top = padding.top.max(0.0).min(bounds.size.height);
    let bottom = padding
        .bottom
        .max(0.0)
        .min((bounds.size.height - top).max(0.0));
    let middle_height = (bounds.size.height - top - bottom).max(0.0);
    let left = padding.left.max(0.0).min(bounds.size.width);
    let right = padding
        .right
        .max(0.0)
        .min((bounds.size.width - left).max(0.0));
    for bounds in [
        Rect::from_xywh(bounds.origin.x, bounds.origin.y, bounds.size.width, top),
        Rect::from_xywh(
            bounds.origin.x,
            bounds.bottom() - bottom,
            bounds.size.width,
            bottom,
        ),
        Rect::from_xywh(bounds.origin.x, bounds.origin.y + top, left, middle_height),
        Rect::from_xywh(
            bounds.right() - right,
            bounds.origin.y + top,
            right,
            middle_height,
        ),
    ] {
        if !bounds.is_empty() {
            scene.draw_rect(PaintRect::new(bounds, Color::rgba(238, 147, 54, 92)));
        }
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;

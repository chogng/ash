use crate::ui::Border;
use crate::ui::Color;
use crate::ui::Edges;
use crate::ui::FontFamily;
use crate::ui::FontWeight;
use crate::ui::InspectionNode;
use crate::ui::PaintRect;
use crate::ui::Point;
use crate::ui::Rect;
use crate::ui::Size;
use crate::ui::TextBlock;
use crate::ui::TextBlockWrap;
use crate::ui::TextStyle;
use crate::ui::UiScene;

use super::computed_contract::COMPUTED_SECTIONS;
use super::computed_contract::computed_values;

const DETAIL_FOREGROUND: Color = Color::rgb(35, 35, 42);
const DETAIL_MUTED: Color = Color::rgb(105, 105, 116);
const DETAIL_BORDER: Color = Color::rgb(218, 218, 224);
const DETAIL_ACCENT: Color = Color::rgb(35, 131, 226);
const DETAIL_PADDING: f32 = 16.0;
const DETAIL_VALUE_OFFSET: f32 = 126.0;
const BOX_MODEL_HEIGHT: f32 = 136.0;
const BOX_MODEL_MAX_WIDTH: f32 = 220.0;
const BOX_MODEL_STROKE_WIDTH: f32 = 1.0;
const BOX_MODEL_STROKE: Color = Color::rgb(70, 70, 76);
const BOX_MODEL_TEXT: Color = Color::rgb(45, 45, 52);
const BOX_MODEL_MARGIN_FILL: Color = Color::rgb(250, 213, 174);
const BOX_MODEL_BORDER_FILL: Color = Color::rgb(255, 232, 184);
const BOX_MODEL_PADDING_FILL: Color = Color::rgb(204, 213, 158);
const BOX_MODEL_CONTENT_FILL: Color = Color::rgb(166, 207, 224);

pub(crate) fn metrics(node: &crate::ui::InspectionNode) -> String {
    let bounds = node.bounds();
    let mut value = format!(
        "size {:.0} × {:.0}   position {:.0}, {:.0}",
        bounds.size.width, bounds.size.height, bounds.origin.x, bounds.origin.y
    );
    if let Some(padding) = node.padding() {
        value.push_str(&format!(
            "   padding {:.0} {:.0} {:.0} {:.0}",
            padding.top, padding.right, padding.bottom, padding.left
        ));
    }
    if let Some(gap) = node.gap() {
        value.push_str(&format!("   gap {gap:.0}"));
    }
    if let Some(radii) = node.corner_radii() {
        value.push_str(&format!("   radius {:.0}", radii.top_left));
    }
    value
}

pub(crate) fn paint_computed(scene: &mut UiScene, bounds: Rect, node: Option<&InspectionNode>) {
    if bounds.is_empty() {
        return;
    }
    let content_width = (bounds.size.width - DETAIL_PADDING * 2.0).max(0.0);
    let origin_x = bounds.origin.x + DETAIL_PADDING;
    let mut y = bounds.origin.y + DETAIL_PADDING;
    paint_text(
        scene,
        "Styles",
        Point::new(origin_x, y),
        60.0,
        TextStyle::new(12.0, DETAIL_MUTED)
            .with_weight(FontWeight::Bold)
            .with_line_height(18.0),
    );
    paint_text(
        scene,
        "Computed",
        Point::new(origin_x + 72.0, y),
        (content_width - 72.0).max(0.0),
        TextStyle::new(12.0, DETAIL_ACCENT)
            .with_weight(FontWeight::Bold)
            .with_line_height(18.0),
    );
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(origin_x + 64.0, y + 28.0, 96.0, 2.0),
        DETAIL_ACCENT,
    ));
    y += 44.0;

    let Some(node) = node else {
        paint_text(
            scene,
            "Select an element to inspect its layout.",
            Point::new(origin_x, y),
            content_width,
            TextStyle::new(11.0, DETAIL_MUTED).with_line_height(16.0),
        );
        return;
    };

    let title = node
        .label()
        .map(|label| format!("{}  {label}", node.name()))
        .unwrap_or_else(|| node.name().to_owned());
    paint_text(
        scene,
        &title,
        Point::new(origin_x, y),
        content_width,
        TextStyle::new(13.0, DETAIL_ACCENT)
            .with_weight(FontWeight::Bold)
            .with_line_height(17.0),
    );
    y += 20.0;
    paint_text(
        scene,
        &metrics(node),
        Point::new(origin_x, y),
        content_width,
        TextStyle::new(11.0, DETAIL_MUTED)
            .with_family(FontFamily::Monospace)
            .with_line_height(15.0),
    );
    y += 24.0;
    paint_rule(scene, bounds, y);
    y += 12.0;
    paint_box_model(scene, origin_x, content_width, y, node);
    y += BOX_MODEL_HEIGHT + 8.0;
    paint_rule(scene, bounds, y);
    y += 12.0;

    let values = computed_values(node);
    for section in COMPUTED_SECTIONS {
        paint_section(scene, origin_x, content_width, &mut y, section.label);
        for field in section.fields {
            let value = values
                .iter()
                .find(|value| value.id == field.id)
                .map(|value| value.text.as_str())
                .unwrap_or("—");
            paint_detail_row(scene, bounds, y, field.label, value);
            y += 20.0;
        }
        y += 8.0;
        paint_rule(scene, bounds, y - 8.0);
    }
}

fn paint_box_model(
    scene: &mut UiScene,
    origin_x: f32,
    available_width: f32,
    y: f32,
    node: &InspectionNode,
) {
    let width = available_width.min(BOX_MODEL_MAX_WIDTH);
    if width <= 0.0 {
        return;
    }
    let origin = Point::new(origin_x + (available_width - width) * 0.5, y);
    let margin = Rect::from_xywh(origin.x, origin.y, width, BOX_MODEL_HEIGHT);
    let layer_inset = (width.min(BOX_MODEL_HEIGHT) * 0.12).clamp(8.0, 16.0);
    let border = inset_box(margin, layer_inset);
    let padding_box = inset_box(border, layer_inset);
    let content = inset_box(padding_box, layer_inset);

    paint_box_layer(scene, margin, BOX_MODEL_MARGIN_FILL, true);
    paint_box_label(scene, margin, "margin");
    paint_box_edges(scene, margin, Edges::default());

    paint_box_layer(scene, border, BOX_MODEL_BORDER_FILL, false);
    paint_box_label(scene, border, "border");
    paint_box_edges(scene, border, Edges::default());

    let padding = node.padding().unwrap_or_default();
    paint_box_layer(scene, padding_box, BOX_MODEL_PADDING_FILL, true);
    paint_box_label(scene, padding_box, "padding");
    paint_box_edges(scene, padding_box, padding);

    paint_box_layer(scene, content, BOX_MODEL_CONTENT_FILL, false);
    paint_box_label(scene, content, "content");
    let node_bounds = node.bounds();
    let content_size = format!(
        "{:.0} × {:.0}",
        (node_bounds.size.width - padding.left - padding.right).max(0.0),
        (node_bounds.size.height - padding.top - padding.bottom).max(0.0),
    );
    paint_text(
        scene,
        &content_size,
        Point::new(
            content.origin.x + 6.0,
            content.origin.y + ((content.size.height - 12.0).max(0.0) * 0.5),
        ),
        (content.size.width - 12.0).max(0.0),
        TextStyle::new(10.0, BOX_MODEL_TEXT)
            .with_family(FontFamily::Monospace)
            .with_line_height(13.0),
    );
}

fn inset_box(bounds: Rect, inset: f32) -> Rect {
    Rect::from_xywh(
        bounds.origin.x + inset,
        bounds.origin.y + inset,
        (bounds.size.width - inset * 2.0).max(0.0),
        (bounds.size.height - inset * 2.0).max(0.0),
    )
}

fn paint_box_layer(scene: &mut UiScene, bounds: Rect, fill: Color, dashed: bool) {
    if bounds.is_empty() {
        return;
    }
    if dashed {
        scene.draw_rect(PaintRect::new(bounds, fill));
        paint_dashed_border(scene, bounds, BOX_MODEL_STROKE);
    } else {
        scene.draw_rect(
            PaintRect::new(bounds, fill)
                .with_border(Border::uniform(BOX_MODEL_STROKE_WIDTH, BOX_MODEL_STROKE)),
        );
    }
}

fn paint_box_label(scene: &mut UiScene, bounds: Rect, label: &str) {
    paint_text(
        scene,
        label,
        Point::new(bounds.origin.x + 5.0, bounds.origin.y + 3.0),
        (bounds.size.width - 10.0).max(0.0),
        TextStyle::new(10.0, BOX_MODEL_TEXT).with_line_height(12.0),
    );
}

fn paint_box_edges(scene: &mut UiScene, bounds: Rect, edges: Edges) {
    paint_box_edge(scene, bounds, edges.top, BoxEdge::Top);
    paint_box_edge(scene, bounds, edges.right, BoxEdge::Right);
    paint_box_edge(scene, bounds, edges.bottom, BoxEdge::Bottom);
    paint_box_edge(scene, bounds, edges.left, BoxEdge::Left);
}

#[derive(Clone, Copy)]
enum BoxEdge {
    Top,
    Right,
    Bottom,
    Left,
}

fn paint_box_edge(scene: &mut UiScene, bounds: Rect, value: f32, edge: BoxEdge) {
    let text = format!("{value:.0}");
    let text_width = (text.chars().count() as f32 * 6.0).max(7.0);
    let (x, y) = match edge {
        BoxEdge::Top => (
            bounds.origin.x + (bounds.size.width - text_width) * 0.5,
            bounds.origin.y + 1.0,
        ),
        BoxEdge::Right => (
            bounds.right() - text_width - 3.0,
            bounds.origin.y + (bounds.size.height - 13.0) * 0.5,
        ),
        BoxEdge::Bottom => (
            bounds.origin.x + (bounds.size.width - text_width) * 0.5,
            bounds.bottom() - 13.0,
        ),
        BoxEdge::Left => (
            bounds.origin.x + 3.0,
            bounds.origin.y + (bounds.size.height - 13.0) * 0.5,
        ),
    };
    paint_text(
        scene,
        &text,
        Point::new(x, y),
        text_width + 2.0,
        TextStyle::new(10.0, BOX_MODEL_TEXT)
            .with_family(FontFamily::Monospace)
            .with_line_height(13.0),
    );
}

fn paint_dashed_border(scene: &mut UiScene, bounds: Rect, color: Color) {
    const DASH_LENGTH: f32 = 6.0;
    const DASH_GAP: f32 = 4.0;

    let mut x = bounds.origin.x;
    while x < bounds.right() {
        let width = DASH_LENGTH.min(bounds.right() - x);
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(x, bounds.origin.y, width, BOX_MODEL_STROKE_WIDTH),
            color,
        ));
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(
                x,
                bounds.bottom() - BOX_MODEL_STROKE_WIDTH,
                width,
                BOX_MODEL_STROKE_WIDTH,
            ),
            color,
        ));
        x += DASH_LENGTH + DASH_GAP;
    }

    let mut y = bounds.origin.y;
    while y < bounds.bottom() {
        let height = DASH_LENGTH.min(bounds.bottom() - y);
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(bounds.origin.x, y, BOX_MODEL_STROKE_WIDTH, height),
            color,
        ));
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(
                bounds.right() - BOX_MODEL_STROKE_WIDTH,
                y,
                BOX_MODEL_STROKE_WIDTH,
                height,
            ),
            color,
        ));
        y += DASH_LENGTH + DASH_GAP;
    }
}

fn paint_section(scene: &mut UiScene, origin_x: f32, width: f32, y: &mut f32, label: &str) {
    paint_text(
        scene,
        label,
        Point::new(origin_x, *y),
        width,
        TextStyle::new(12.0, DETAIL_FOREGROUND)
            .with_weight(FontWeight::Bold)
            .with_line_height(17.0),
    );
    *y += 22.0;
}

fn paint_detail_row(scene: &mut UiScene, bounds: Rect, y: f32, label: &str, value: &str) {
    let origin_x = bounds.origin.x + DETAIL_PADDING;
    paint_text(
        scene,
        label,
        Point::new(origin_x, y),
        DETAIL_VALUE_OFFSET,
        TextStyle::new(11.0, DETAIL_MUTED).with_line_height(17.0),
    );
    paint_text(
        scene,
        value,
        Point::new(origin_x + DETAIL_VALUE_OFFSET, y),
        (bounds.size.width - DETAIL_PADDING * 2.0 - DETAIL_VALUE_OFFSET).max(0.0),
        TextStyle::new(11.0, DETAIL_FOREGROUND)
            .with_family(FontFamily::Monospace)
            .with_line_height(17.0),
    );
}

fn paint_rule(scene: &mut UiScene, bounds: Rect, y: f32) {
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(bounds.origin.x, y, bounds.size.width, 1.0),
        DETAIL_BORDER,
    ));
}

pub(crate) fn paint_message(
    scene: &mut UiScene,
    message: &str,
    bounds: Rect,
    padding: f32,
    color: Color,
) {
    paint_text(
        scene,
        message,
        Point::new(bounds.origin.x + padding, bounds.origin.y + padding),
        (bounds.size.width - padding * 2.0).max(0.0),
        TextStyle::new(12.0, color).with_line_height(18.0),
    );
}

pub(crate) fn paint_text(
    scene: &mut UiScene,
    text: &str,
    origin: Point,
    width: f32,
    style: TextStyle,
) {
    if width <= 0.0 {
        return;
    }
    scene.draw_text(
        TextBlock::new(text, origin, Size::new(width, style.line_height()), style)
            .with_wrap(TextBlockWrap::None),
    );
}

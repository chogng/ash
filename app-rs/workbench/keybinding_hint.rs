use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::keycap_labels;
use ash_ui_components::KeycapSequence;
use ash_ui_components::KeycapStyle;
use zui::ui::BoxShadow;
use zui::ui::Color;
use zui::ui::CornerRadii;
use zui::ui::PaintRect;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextBlock;
use zui::ui::TextStyle;
use zui::ui::UiScene;

/// Paints the workbench-wide prompt shown while a multi-chord binding is pending.
pub fn paint_chord_hint(
    scene: &mut UiScene,
    viewport: Rect,
    keybinding: &KeySequence,
    entered: usize,
    platform: HostPlatform,
) {
    let labels = keycap_labels(keybinding, platform)
        .into_iter()
        .take(entered)
        .collect::<Vec<_>>();
    let measured = KeycapSequence::new(Point::new(0.0, 0.0), labels.clone(), keycap_style());
    let width = measured.bounds().size.width + 150.0;
    let bounds = Rect::from_xywh(
        viewport.origin.x + (viewport.size.width - width) * 0.5,
        viewport.bottom() - 54.0,
        width,
        36.0,
    );
    scene.with_overlay(|scene| {
        scene.draw_rect(
            PaintRect::new(bounds, Color::rgb(45, 46, 51))
                .with_shadow(
                    BoxShadow::new(Color::rgba(0, 0, 0, 48))
                        .with_offset(Point::new(0.0, 4.0))
                        .with_blur_radius(12.0),
                )
                .with_corner_radii(CornerRadii::uniform(6.0)),
        );
        let sequence = KeycapSequence::new(
            Point::new(bounds.origin.x + 8.0, bounds.origin.y + 7.0),
            labels,
            keycap_style(),
        );
        scene.draw_component(&sequence);
        scene.draw_text(TextBlock::new(
            "waiting for next key…".to_owned(),
            Point::new(sequence.bounds().right() + 10.0, bounds.origin.y + 9.0),
            Size::new(132.0, 18.0),
            TextStyle::new(12.0, Color::rgb(220, 220, 224)).with_line_height(18.0),
        ));
    });
}

fn keycap_style() -> KeycapStyle {
    KeycapStyle::new(Color::rgb(62, 63, 69), Color::WHITE)
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_height(22.0)
        .with_minimum_width(22.0)
        .with_horizontal_padding(6.0)
}

#[cfg(test)]
#[path = "keybinding_hint_tests.rs"]
mod tests;

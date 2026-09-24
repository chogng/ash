use super::SceneBatch;
use super::TextBlock;
use super::UiScene;
use crate::ui::foundation::{Icon, IconDefinition, IconId};
use crate::ui::text::FontFamily;
use crate::ui::text::FontWeight;
use crate::ui::text::TextSpan;
use crate::ui::text::TextStyle;
use crate::{
    Border, Color, CornerRadii, Element, ElementId, ElementOverflow, ImageData, ImageId, PaintIcon,
    PaintImage, PaintRect, Point, Rect, Size,
};

const TEST_ICON: Icon = Icon::new(
    IconId::new("test"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>"#,
    ),
);

#[test]
fn scene_retains_text_in_paint_order() {
    let style = TextStyle::new(16.0, Color::WHITE)
        .with_family(FontFamily::Monospace)
        .with_weight(FontWeight::Bold);
    let first = TextBlock::new(
        "first",
        Point::new(8.0, 12.0),
        Size::new(200.0, 24.0),
        style.clone(),
    );
    let second = TextBlock::new(
        "second",
        Point::new(8.0, 40.0),
        Size::new(200.0, 24.0),
        style,
    );
    let mut scene = UiScene::new(Color::rgb(10, 20, 30));

    scene.draw_text(first.clone());
    scene.draw_text(second.clone());

    assert_eq!(scene.text_blocks(), &[first, second]);
    assert!(scene.rects().is_empty());
    assert!(scene.icons().is_empty());
    assert_eq!(scene.background().components(), [10, 20, 30, 255]);
}

#[test]
fn scene_retains_decoded_images_and_applies_active_clip() {
    let image = ImageData::from_rgba8(ImageId::new(7), 1, 1, vec![255, 0, 0, 255]).unwrap();
    let mut scene = UiScene::new(Color::TRANSPARENT);
    let clip = Rect::from_xywh(2.0, 3.0, 8.0, 9.0);

    scene.with_clip(clip, |scene| {
        scene.draw_image(PaintImage::new(
            image,
            Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
        ));
    });

    assert_eq!(scene.images().len(), 1);
    assert_eq!(scene.images()[0].clip_bounds(), Some(clip));
}

#[test]
fn rich_text_block_preserves_span_styles_and_plain_text_projection() {
    let base = TextStyle::new(13.0, Color::rgb(10, 20, 30));
    let rich = TextBlock::from_spans(
        [
            TextSpan::new("normal ", base.clone()),
            TextSpan::new("bold", base.clone().with_weight(FontWeight::Bold)),
        ],
        Point::new(1.0, 2.0),
        Size::new(100.0, 40.0),
        base,
    );

    assert_eq!(rich.text(), "normal bold");
    assert_eq!(rich.spans().len(), 2);
    assert_eq!(rich.spans()[1].style().weight(), FontWeight::Bold);
}

#[test]
fn text_style_defaults_to_readable_line_height() {
    let style = TextStyle::new(20.0, Color::WHITE);

    assert_eq!(style.line_height(), 24.0);
    assert_eq!(style.family(), &FontFamily::SansSerif);
}

#[test]
fn text_block_retains_explicit_center_alignment() {
    let block = TextBlock::new(
        "Centered",
        Point::new(8.0, 12.0),
        Size::new(200.0, 24.0),
        TextStyle::new(16.0, Color::WHITE),
    )
    .with_centered_text();

    assert!(block.is_text_centered());
}

#[test]
fn scene_applies_nested_clip_to_all_primitives() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_clip(Rect::from_xywh(10.0, 10.0, 100.0, 80.0), |scene| {
        scene.with_clip(Rect::from_xywh(50.0, 0.0, 80.0, 60.0), |scene| {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(0.0, 0.0, 200.0, 200.0),
                Color::WHITE,
            ));
            scene.draw_icon(PaintIcon::new(
                TEST_ICON,
                Rect::from_xywh(40.0, 0.0, 20.0, 20.0),
                Color::WHITE,
            ));
            scene.draw_text(TextBlock::new(
                "clipped",
                Point::new(0.0, 0.0),
                Size::new(200.0, 40.0),
                TextStyle::new(14.0, Color::WHITE),
            ));
        });
    });

    let expected = Some(Rect::from_xywh(50.0, 10.0, 60.0, 50.0));
    assert_eq!(scene.rects()[0].clip_bounds(), expected);
    assert_eq!(scene.icons()[0].clip_bounds(), expected);
    assert_eq!(scene.text_blocks()[0].clip_bounds(), expected);
}

#[test]
fn scene_records_nested_rounded_clips_and_their_content_depth() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    let outer = Rect::from_xywh(10.0, 10.0, 100.0, 80.0);
    let inner = Rect::from_xywh(20.0, 20.0, 60.0, 40.0);

    scene.with_rounded_clip(outer, CornerRadii::uniform(10.0), |scene| {
        scene.draw_rect(PaintRect::new(outer, Color::WHITE));
        scene.with_rounded_clip(inner, CornerRadii::uniform(4.0), |scene| {
            scene.draw_text(TextBlock::new(
                "nested",
                inner.origin,
                inner.size,
                TextStyle::new(12.0, Color::WHITE),
            ));
        });
    });

    assert_eq!(scene.clips()[0].bounds(), outer);
    assert_eq!(scene.clips()[0].corner_radii(), CornerRadii::uniform(10.0));
    assert_eq!(scene.clips()[1].bounds(), inner);
    assert_eq!(
        scene.batches().collect::<Vec<_>>(),
        [
            SceneBatch::ClipStart {
                layer: 0,
                index: 0,
                depth: 0,
            },
            SceneBatch::Rects {
                layer: 0,
                range: 0..1,
                clip_depth: 1,
            },
            SceneBatch::ClipStart {
                layer: 0,
                index: 1,
                depth: 1,
            },
            SceneBatch::Text {
                layer: 0,
                range: 0..1,
                clip_depth: 2,
            },
            SceneBatch::ClipEnd {
                layer: 0,
                index: 1,
                depth: 2,
            },
            SceneBatch::ClipEnd {
                layer: 0,
                index: 0,
                depth: 1,
            },
        ]
    );
}

#[test]
fn styled_element_tree_drives_box_paint_clipping_and_inspection_hierarchy() {
    let root_bounds = Rect::from_xywh(10.0, 20.0, 100.0, 60.0);
    let root = Element::column("Panel")
        .background(Color::rgb(20, 30, 40))
        .border(Border::uniform(1.0, Color::WHITE))
        .corner_radii(CornerRadii::uniform(8.0))
        .overflow(ElementOverflow::Clip)
        .child(
            Element::leaf("Row")
                .height(crate::ElementLength::px(24.0))
                .background(Color::rgb(50, 60, 70)),
        )
        .in_bounds(root_bounds);
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.with_element(root, |scene, _computed| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 200.0, 200.0),
            Color::rgb(80, 90, 100),
        ));
    });

    assert_eq!(scene.rects().len(), 3);
    assert_eq!(scene.rects()[0].bounds(), root_bounds);
    assert_eq!(scene.rects()[0].clip_bounds(), None);
    assert_eq!(
        scene.rects()[1].bounds(),
        Rect::from_xywh(10.0, 20.0, 100.0, 24.0)
    );
    assert_eq!(scene.rects()[1].clip_bounds(), None);
    assert_eq!(scene.rects()[2].clip_bounds(), None);
    assert_eq!(scene.clips()[0].bounds(), root_bounds);
    assert_eq!(scene.inspection().nodes().len(), 2);
    let child = &scene.inspection().nodes()[1];
    assert_eq!(child.name(), "Row");
    assert_eq!(
        scene
            .inspection()
            .ancestry(child.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        ["Panel", "Row"]
    );
}

#[test]
fn overlay_escapes_a_rounded_clip() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    let clip = Rect::from_xywh(10.0, 10.0, 40.0, 40.0);

    scene.with_rounded_clip(clip, CornerRadii::uniform(8.0), |scene| {
        scene.with_overlay(|scene| {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(0.0, 0.0, 80.0, 80.0),
                Color::WHITE,
            ));
        });
    });

    assert_eq!(
        scene.batches().last(),
        Some(SceneBatch::Rects {
            layer: 1,
            range: 0..1,
            clip_depth: 0,
        })
    );
}

#[test]
fn scene_restores_outer_clip_after_nested_draw() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_clip(Rect::from_xywh(10.0, 10.0, 100.0, 80.0), |scene| {
        scene.with_clip(Rect::from_xywh(50.0, 0.0, 80.0, 60.0), |_| {});
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 200.0, 200.0),
            Color::WHITE,
        ));
    });

    assert_eq!(
        scene.rects()[0].clip_bounds(),
        Some(Rect::from_xywh(10.0, 10.0, 100.0, 80.0))
    );
}

#[test]
fn scene_discards_primitives_fully_outside_the_active_clip() {
    let image = ImageData::from_rgba8(ImageId::new(8), 1, 1, vec![255, 0, 0, 255]).unwrap();
    let mut scene = UiScene::new(Color::TRANSPARENT);

    scene.with_clip(Rect::from_xywh(0.0, 0.0, 20.0, 20.0), |scene| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(30.0, 30.0, 10.0, 10.0),
            Color::WHITE,
        ));
        scene.draw_icon(PaintIcon::new(
            TEST_ICON,
            Rect::from_xywh(30.0, 30.0, 10.0, 10.0),
            Color::WHITE,
        ));
        scene.draw_image(PaintImage::new(
            image,
            Rect::from_xywh(30.0, 30.0, 10.0, 10.0),
        ));
        scene.draw_text(TextBlock::new(
            "outside",
            Point::new(30.0, 30.0),
            Size::new(10.0, 10.0),
            TextStyle::new(12.0, Color::WHITE),
        ));
    });

    assert!(scene.rects().is_empty());
    assert!(scene.icons().is_empty());
    assert!(scene.images().is_empty());
    assert!(scene.text_blocks().is_empty());
    assert_eq!(scene.batches().count(), 0);
}

#[test]
fn scene_checkpoint_restores_primitives_layers_and_inspection_prefix() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_element(
        Element::leaf("Base").in_bounds(Rect::from_xywh(0.0, 0.0, 40.0, 40.0)),
        |scene, element| {
            scene.draw_rect(PaintRect::new(element.bounds(), Color::WHITE));
        },
    );
    let checkpoint = scene.checkpoint();

    scene.with_overlay(|scene| {
        scene.with_element(
            Element::leaf("Overlay").in_bounds(Rect::from_xywh(10.0, 10.0, 20.0, 20.0)),
            |scene, element| {
                scene.draw_rect(PaintRect::new(element.bounds(), Color::WHITE));
            },
        );
    });
    assert_eq!(scene.layer_count(), 2);
    assert_eq!(scene.inspection().nodes().len(), 2);

    scene.restore(&checkpoint);

    assert_eq!(scene.layer_count(), 1);
    assert_eq!(scene.inspection().nodes().len(), 1);
    assert_eq!(scene.inspection().nodes()[0].name(), "Base");
}

#[test]
fn terminal_fragment_replacement_preserves_the_stable_scene_prefix() {
    let fragment = ElementId::scoped(3, 1);
    let mut scene = UiScene::new(Color::TRANSPARENT);
    let base = PaintRect::new(Rect::from_xywh(0.0, 0.0, 20.0, 20.0), Color::WHITE);
    scene.draw_rect(base);
    scene.with_fragment(fragment, |scene| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(4.0, 4.0, 8.0, 8.0),
            Color::rgb(10, 20, 30),
        ));
    });

    scene
        .replace_fragment(fragment, |scene| {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(12.0, 4.0, 8.0, 8.0),
                Color::rgb(30, 20, 10),
            ));
        })
        .unwrap();

    assert_eq!(scene.rects()[0], base);
    assert_eq!(
        scene.rects()[1].bounds(),
        Rect::from_xywh(12.0, 4.0, 8.0, 8.0)
    );
    assert_eq!(scene.layer_count(), 2);
    assert_eq!(scene.batches().count(), 2);
}

#[test]
fn fragment_replacement_rejects_later_scene_work() {
    let fragment = ElementId::scoped(3, 2);
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_fragment(fragment, |scene| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 8.0, 8.0),
            Color::WHITE,
        ));
    });
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(12.0, 0.0, 8.0, 8.0),
        Color::WHITE,
    ));

    assert!(matches!(
        scene.replace_fragment(fragment, |_| {}),
        Err(super::SceneFragmentError::NotTerminal(_))
    ));
}

#[test]
fn removing_a_terminal_fragment_restores_the_scene_and_inspection_prefix() {
    let fragment = ElementId::scoped(3, 3);
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_element(
        Element::leaf("Base").in_bounds(Rect::from_xywh(0.0, 0.0, 20.0, 20.0)),
        |scene, _| {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
                Color::WHITE,
            ));
        },
    );
    scene.with_fragment(fragment, |scene| {
        scene.with_element(
            Element::leaf("Exiting").in_bounds(Rect::from_xywh(4.0, 4.0, 8.0, 8.0)),
            |scene, _| {
                scene.draw_rect(PaintRect::new(
                    Rect::from_xywh(4.0, 4.0, 8.0, 8.0),
                    Color::rgb(10, 20, 30),
                ));
            },
        );
    });

    scene.remove_fragment(fragment).unwrap();

    assert_eq!(scene.rects().len(), 1);
    assert_eq!(scene.inspection().nodes().len(), 1);
    assert_eq!(scene.inspection().nodes()[0].name(), "Base");
    assert_eq!(scene.layer_count(), 1);
}

#[test]
fn overlays_are_ordered_and_restore_the_callers_layer() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
        Color::WHITE,
    ));
    scene.with_overlay(|scene| {
        scene.draw_text(TextBlock::new(
            "first overlay",
            Point::new(0.0, 0.0),
            Size::new(100.0, 20.0),
            TextStyle::new(14.0, Color::WHITE),
        ));
        scene.with_overlay(|scene| {
            scene.draw_icon(PaintIcon::new(
                TEST_ICON,
                Rect::from_xywh(0.0, 0.0, 16.0, 16.0),
                Color::WHITE,
            ));
        });
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 10.0, 10.0),
            Color::WHITE,
        ));
    });
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(20.0, 20.0, 20.0, 20.0),
        Color::WHITE,
    ));

    assert_eq!(scene.layer_count(), 3);
    assert_eq!(scene.rect_layers(), &[0, 1, 0]);
    assert_eq!(scene.text_layers(), &[1]);
    assert_eq!(scene.icon_layers(), &[2]);
}

#[test]
fn overlay_escapes_and_then_restores_the_callers_clip() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    let host_clip = Rect::from_xywh(10.0, 10.0, 40.0, 40.0);
    scene.with_clip(host_clip, |scene| {
        scene.with_overlay(|scene| {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
                Color::WHITE,
            ));
        });
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
            Color::WHITE,
        ));
    });

    assert_eq!(scene.rects()[0].clip_bounds(), None);
    assert_eq!(scene.rects()[1].clip_bounds(), Some(host_clip));
}

#[test]
fn batches_preserve_cross_kind_paint_order_and_coalesce_adjacent_primitives() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
        Color::WHITE,
    ));
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(2.0, 2.0, 16.0, 16.0),
        Color::rgb(0, 0, 0),
    ));
    scene.draw_text(TextBlock::new(
        "under",
        Point::new(0.0, 0.0),
        Size::new(40.0, 20.0),
        TextStyle::new(12.0, Color::WHITE),
    ));
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(4.0, 4.0, 12.0, 12.0),
        Color::WHITE,
    ));

    assert_eq!(
        scene.batches().collect::<Vec<_>>(),
        [
            SceneBatch::Rects {
                layer: 0,
                range: 0..2,
                clip_depth: 0,
            },
            SceneBatch::Text {
                layer: 0,
                range: 0..1,
                clip_depth: 0,
            },
            SceneBatch::Rects {
                layer: 0,
                range: 2..3,
                clip_depth: 0,
            },
        ]
    );
}

#[test]
fn batches_order_overlays_above_base_primitives_drawn_later() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(0.0, 0.0, 20.0, 20.0),
        Color::WHITE,
    ));
    scene.with_overlay(|scene| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(0.0, 0.0, 10.0, 10.0),
            Color::rgb(0, 0, 0),
        ));
    });
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(2.0, 2.0, 16.0, 16.0),
        Color::WHITE,
    ));

    assert_eq!(
        scene.batches().collect::<Vec<_>>(),
        [
            SceneBatch::Rects {
                layer: 0,
                range: 0..1,
                clip_depth: 0,
            },
            SceneBatch::Rects {
                layer: 0,
                range: 2..3,
                clip_depth: 0,
            },
            SceneBatch::Rects {
                layer: 1,
                range: 1..2,
                clip_depth: 0,
            },
        ]
    );
}

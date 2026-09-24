use crate::{
    BoxShadow, Color, Component, ContextView, ContextViewAnchorAlignment, ContextViewAnchorAxis,
    ContextViewAnchorPosition, ContextViewPlacement, ContextViewStyle, Edges, PaintRect, Point,
    Rect, Size, UiScene,
};

fn context_view(
    viewport: Rect,
    anchor: Rect,
    content_size: Size,
    placement: ContextViewPlacement,
) -> ContextView {
    ContextView::new(
        viewport,
        anchor,
        content_size,
        placement,
        ContextViewStyle::new(Color::rgb(30, 31, 34)),
    )
}

#[test]
fn uses_requested_side_and_alignment_when_they_fit() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 800.0, 600.0),
        Rect::from_xywh(100.0, 100.0, 80.0, 30.0),
        Size::new(200.0, 120.0),
        ContextViewPlacement::new()
            .with_gap(4.0)
            .with_viewport_margin(0.0),
    );

    assert_eq!(view.bounds(), Rect::from_xywh(100.0, 134.0, 200.0, 120.0));
    assert_eq!(
        view.layout().anchor_position(),
        ContextViewAnchorPosition::After
    );
    assert_eq!(
        view.layout().anchor_alignment(),
        ContextViewAnchorAlignment::Start
    );
}

#[test]
fn flips_before_when_requested_side_does_not_fit() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 800.0, 600.0),
        Rect::from_xywh(100.0, 550.0, 80.0, 30.0),
        Size::new(200.0, 120.0),
        ContextViewPlacement::new()
            .with_gap(4.0)
            .with_viewport_margin(0.0),
    );

    assert_eq!(view.bounds().origin.y, 426.0);
    assert_eq!(
        view.layout().anchor_position(),
        ContextViewAnchorPosition::Before
    );
}

#[test]
fn flips_cross_axis_alignment_before_clamping() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 800.0, 600.0),
        Rect::from_xywh(750.0, 100.0, 40.0, 30.0),
        Size::new(200.0, 120.0),
        ContextViewPlacement::new().with_viewport_margin(0.0),
    );

    assert_eq!(view.bounds().origin.x, 590.0);
    assert_eq!(
        view.layout().anchor_alignment(),
        ContextViewAnchorAlignment::End
    );
}

#[test]
fn supports_horizontal_anchor_placement() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 800.0, 600.0),
        Rect::from_xywh(700.0, 200.0, 80.0, 40.0),
        Size::new(160.0, 100.0),
        ContextViewPlacement::new()
            .with_axis(ContextViewAnchorAxis::Horizontal)
            .with_gap(8.0)
            .with_viewport_margin(0.0),
    );

    assert_eq!(view.bounds().origin, crate::Point::new(532.0, 200.0));
    assert_eq!(
        view.layout().anchor_position(),
        ContextViewAnchorPosition::Before
    );
}

#[test]
fn constrains_shell_and_content_to_inset_viewport() {
    let style =
        ContextViewStyle::new(Color::rgb(30, 31, 34)).with_padding(Edges::new(2.0, 3.0, 4.0, 5.0));
    let view = ContextView::new(
        Rect::from_xywh(30.0, 20.0, 300.0, 200.0),
        Rect::from_xywh(100.0, 80.0, 40.0, 20.0),
        Size::new(400.0, 260.0),
        ContextViewPlacement::new().with_viewport_margin(4.0),
        style,
    );

    assert_eq!(view.bounds(), Rect::from_xywh(34.0, 24.0, 292.0, 192.0));
    assert_eq!(
        view.content_bounds(),
        Rect::from_xywh(39.0, 26.0, 284.0, 186.0)
    );
}

#[test]
fn excessive_viewport_margin_collapses_at_the_viewport_center() {
    let view = context_view(
        Rect::from_xywh(20.0, 10.0, 100.0, 60.0),
        Rect::from_xywh(40.0, 30.0, 10.0, 10.0),
        Size::new(40.0, 30.0),
        ContextViewPlacement::new().with_viewport_margin(200.0),
    );

    assert_eq!(view.bounds(), Rect::from_xywh(70.0, 40.0, 0.0, 0.0));
    assert_eq!(view.content_bounds(), view.bounds());
}

#[test]
fn draw_hosts_shell_and_clipped_content_in_one_overlay_layer() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Rect::from_xywh(40.0, 40.0, 20.0, 20.0),
        Size::new(120.0, 80.0),
        ContextViewPlacement::new().with_viewport_margin(0.0),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.draw_rect(PaintRect::new(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Color::WHITE,
    ));

    scene.with_clip(Rect::from_xywh(0.0, 0.0, 30.0, 30.0), |scene| {
        view.draw(scene, |scene, content_bounds| {
            scene.draw_rect(PaintRect::new(
                Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
                Color::rgb(60, 61, 64),
            ));
            assert_eq!(content_bounds, view.content_bounds());
        });
    });

    assert_eq!(scene.layer_count(), 2);
    assert_eq!(scene.rect_layers(), &[0, 1, 1]);
    assert_eq!(scene.rects()[1].clip_bounds(), None);
    assert_eq!(scene.rects()[2].clip_bounds(), Some(view.content_bounds()));
}

#[test]
fn overflow_draw_keeps_component_owned_effects_unclipped() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Rect::from_xywh(40.0, 40.0, 20.0, 20.0),
        Size::new(120.0, 80.0),
        ContextViewPlacement::new().with_viewport_margin(0.0),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    view.draw_overflow(&mut scene, |scene, content_bounds| {
        scene.draw_rect(PaintRect::new(
            Rect::from_xywh(
                content_bounds.origin.x - 8.0,
                content_bounds.origin.y - 8.0,
                content_bounds.size.width + 16.0,
                content_bounds.size.height + 16.0,
            ),
            Color::rgb(60, 61, 64),
        ));
    });

    assert_eq!(scene.layer_count(), 2);
    assert_eq!(scene.rect_layers(), &[1, 1]);
    assert_eq!(scene.rects()[1].clip_bounds(), None);
}

#[test]
fn component_paint_places_the_shell_in_an_overlay_layer() {
    let view = context_view(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Rect::from_xywh(40.0, 40.0, 20.0, 20.0),
        Size::new(120.0, 80.0),
        ContextViewPlacement::new(),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    view.paint(&mut scene);

    assert_eq!(scene.rects().len(), 1);
    assert_eq!(scene.rect_layers(), &[1]);
}

#[test]
fn style_paints_a_shell_shadow_outside_the_content_clip() {
    let shadow = BoxShadow::new(Color::rgba(0, 0, 0, 48))
        .with_offset(Point::new(0.0, 4.0))
        .with_blur_radius(12.0);
    let view = ContextView::new(
        Rect::from_xywh(0.0, 0.0, 400.0, 300.0),
        Rect::from_xywh(40.0, 40.0, 20.0, 20.0),
        Size::new(120.0, 80.0),
        ContextViewPlacement::new(),
        ContextViewStyle::new(Color::rgb(45, 46, 51)).with_shadow(shadow),
    );
    let mut scene = UiScene::new(Color::TRANSPARENT);

    view.draw(&mut scene, |_scene, _content_bounds| {});

    assert_eq!(scene.rects()[0].shadow(), Some(shadow));
    assert_eq!(scene.rects()[0].clip_bounds(), None);
}

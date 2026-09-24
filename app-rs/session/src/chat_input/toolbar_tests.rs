use super::ChatInputToolbar;
use crate::SessionPaneContext;
use crate::SessionPaneStyle;
use crate::interaction::CONTEXT_TOOLBAR;
use crate::interaction::ContextAction;
use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{Component, FontWeight, Point, Rect, TextInputLayoutEngine, UiScene};
use zui::ui::{InteractionFrame, UiDispatch, UiFrame};

fn style() -> SessionPaneStyle {
    SessionPaneStyle::from_theme(DEFAULT_UI_THEME)
}

fn context(path: &str, branch: Option<&str>, change_count: Option<usize>) -> SessionPaneContext {
    SessionPaneContext::new(
        "Local",
        path,
        branch.unwrap_or("No Git"),
        change_count.map_or_else(
            || "Changes —".to_owned(),
            |count| format!("Changes {count} • +{count} -0"),
        ),
    )
}

#[test]
fn toolbar_projects_four_real_context_values_as_action_buttons() {
    let style = style();
    let context = context("~/Desktop/ash", Some("main"), Some(7));
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let toolbar = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 600.0, 952.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );
    let mut scene = UiScene::new(style.surface);

    toolbar.paint(&mut scene);

    assert_eq!(scene.icons().len(), 4);
    assert_eq!(
        scene
            .text_blocks()
            .iter()
            .map(|block| block.text())
            .collect::<Vec<_>>(),
        ["Local", "~/Desktop/ash", "main", "Changes 7 • +7 -0"]
    );
    assert_eq!(scene.rects().len(), 4);
    assert_eq!(toolbar.item_bounds(0).unwrap().origin.x, 24.0);
    assert!(scene.text_blocks().iter().all(|block| {
        block
            .spans()
            .iter()
            .all(|span| span.style().weight() == FontWeight::SemiBold)
    }));
    assert!(toolbar.item_bounds(0).unwrap().right() < toolbar.item_bounds(1).unwrap().origin.x);
    assert_eq!(toolbar.hit_test(Point::new(40.0, 612.0)), Some(0));
    assert!(
        toolbar.item_bounds(1).unwrap().size.width > toolbar.item_bounds(2).unwrap().size.width
    );
}

#[test]
fn changes_label_uses_text_success_and_error_colors() {
    let style = style();
    let context = SessionPaneContext::new("Local", "~/Desktop/ash", "main", "Changes 5 • +84 -39");
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let toolbar = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 600.0, 952.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );
    let mut scene = UiScene::new(style.surface);

    toolbar.paint(&mut scene);

    let changes = scene
        .text_blocks()
        .iter()
        .find(|block| block.text() == "Changes 5 • +84 -39")
        .unwrap();
    assert_eq!(
        changes
            .spans()
            .iter()
            .map(|span| (span.text(), span.style().color()))
            .collect::<Vec<_>>(),
        [
            ("Changes ", style.text),
            ("5 ", style.text),
            ("• ", style.text),
            ("+84 ", style.success),
            ("-39", style.error),
        ]
    );
}

#[test]
fn toolbar_scales_all_items_into_a_narrow_input_surface() {
    let style = style();
    let context = context("/tmp/project", None, None);
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let toolbar = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 200.0, 192.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );

    assert_eq!(toolbar.item_bounds(0).unwrap().origin.x, 24.0);
    assert!(toolbar.item_bounds(3).unwrap().right() <= 216.0);
    assert!(toolbar.item_bounds(4).is_none());
}

#[test]
fn toolbar_registers_the_same_button_bounds_used_for_painting() {
    let style = style();
    let context = context("~/Desktop/ash", Some("main"), Some(7));
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let toolbar = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 600.0, 952.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(style.surface);
    frame.draw_component(&toolbar);

    let location = toolbar.item_bounds(0).unwrap();
    assert_eq!(
        frame
            .interaction()
            .target_at(Point::new(location.origin.x + 1.0, location.origin.y + 1.0)),
        Some(ContextAction::Location.element_id())
    );
}

#[test]
fn toolbar_projects_host_hover_state_back_into_the_hit_button() {
    let style = style();
    let context = context("~/Desktop/ash", Some("main"), Some(7));
    let mut text_layout = TextInputLayoutEngine::new();
    let mut dispatch = UiDispatch::default();
    let resting = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 600.0, 952.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(style.surface);
    frame.draw_component(&resting);
    let first = resting.item_bounds(0).unwrap();
    dispatch.pointer_moved(
        Point::new(first.origin.x + 1.0, first.origin.y + 1.0),
        frame.interaction(),
    );
    let hovered = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 600.0, 952.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );
    let mut scene = UiScene::new(style.surface);

    hovered.paint(&mut scene);

    assert_eq!(scene.rects()[0].fill(), style.surface_hovered);
    assert_eq!(scene.rects()[1].fill(), style.surface_raised);
}

#[test]
fn toolbar_buttons_publish_accessible_labels_and_a_toolbar_parent() {
    let style = style();
    let context = context("~/Desktop/ash", Some("main"), Some(7));
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let toolbar = ChatInputToolbar::new(
        Rect::from_xywh(24.0, 600.0, 952.0, 24.0),
        &context,
        style,
        &mut text_layout,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(style.surface);
    frame.draw_component(&toolbar);

    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    let location = nodes
        .iter()
        .find(|node| node.id == ContextAction::Location.element_id())
        .unwrap();
    assert_eq!(location.parent, Some(CONTEXT_TOOLBAR));
    assert_eq!(location.label, "Environment: Local");
    assert!(location.focusable);
    let changes = nodes
        .iter()
        .find(|node| node.id == ContextAction::Diff.element_id())
        .unwrap();
    assert_eq!(changes.label, "Git Changes 7 • +7 -0");
}

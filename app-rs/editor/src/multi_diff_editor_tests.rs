use super::{
    MultiDiffEditor, MultiDiffEditorItem, MultiDiffEditorItemIdentity, MultiDiffEditorStyle,
};
use crate::{
    CodeEditorLanguage, DiffEditorDocument, DiffEditorLabels, DiffEditorPresentation,
    DiffEditorState,
};
use ash_diff::DiffDocument;
use ash_ui_components::{ScrollAxis, ScrollCommand, ScrollDelta, ScrollState};
use std::time::{Duration, Instant};
use zui::ui::{
    AnimationBinding, AnimationKey, AnimationProperty, AnimationRegistry, Color, Component,
    CornerRadii, ElementId, InteractionFrame, Rect, ScalarAnimationSpec, UiFrame, UiScene,
};

#[derive(Default)]
struct CountingAnimationBindings {
    bound: usize,
}

impl AnimationBinding for CountingAnimationBindings {
    fn bind_scalar(
        &mut self,
        _key: AnimationKey,
        _initial: f32,
        target: f32,
        _spec: ScalarAnimationSpec,
        _now: Instant,
    ) -> f32 {
        self.bound += 1;
        target
    }
}

fn document(original: &str, modified: &str) -> DiffEditorDocument {
    DiffEditorDocument::new(
        DiffDocument::from_text(original, modified).unwrap(),
        CodeEditorLanguage::PlainText,
    )
}

#[test]
fn fold_element_id_preserves_the_legacy_item_region_encoding() {
    assert_eq!(
        MultiDiffEditor::fold_element_id(0, 0),
        Some(ElementId::scoped(4, 1))
    );
    assert_eq!(
        MultiDiffEditor::fold_element_id(1, 0),
        Some(ElementId::scoped(4, 65_537))
    );
    assert_eq!(MultiDiffEditor::fold_element_id(65_536, 0), None);
    assert_eq!(MultiDiffEditor::fold_element_id(0, 65_536), None);
}

#[test]
fn stable_item_identity_derives_nested_ids_and_fold_animation_key() {
    let identity = MultiDiffEditorItemIdentity::from_slot(17);
    let other = MultiDiffEditorItemIdentity::from_slot(18);

    assert_eq!(identity.slot(), 17);
    assert_eq!(identity.section_id(), ElementId::scoped(10, 17));
    assert_eq!(identity.header_id(), ElementId::scoped(11, 17));
    assert_eq!(identity.diff_id(), ElementId::scoped(12, 17));
    assert_eq!(
        identity.header_action_id(2),
        Some(ElementId::scoped(13, 1_114_115))
    );
    assert_eq!(identity.fold_id(3), Some(ElementId::scoped(4, 1_114_116)));
    assert_ne!(identity.fold_id(3), other.fold_id(3));
    assert_eq!(
        MultiDiffEditorItemIdentity::from_header_id(identity.header_id()),
        Some(identity)
    );
    assert_eq!(
        MultiDiffEditorItemIdentity::from_header_action_id(identity.header_action_id(2).unwrap()),
        Some((identity, 2))
    );
    assert_eq!(
        MultiDiffEditorItemIdentity::from_fold_id(identity.fold_id(3).unwrap()),
        Some((identity, 3))
    );

    let animation = identity.fold_animation_key();
    assert_eq!(animation.element(), identity.section_id());
    assert_eq!(animation.property(), AnimationProperty::Height);
}

#[test]
fn fold_height_animation_updates_component_bounds_from_the_retained_key() {
    let original = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = (1..=20)
        .map(|line| {
            if line == 11 {
                "changed 11".to_string()
            } else {
                format!("line {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let document = document(&original, &modified);
    let identity = MultiDiffEditorItemIdentity::from_slot(17);
    let labels = DiffEditorLabels::new("HEAD", "Working Tree");
    let collapsed_item =
        [
            MultiDiffEditorItem::new("src/lib.rs", &document, DiffEditorState::default(), labels)
                .with_identity(identity),
        ];
    let mut expanded_state = DiffEditorState::default();
    expanded_state.expand_unchanged_region(0);
    let expanded_item = [
        MultiDiffEditorItem::new("src/lib.rs", &document, expanded_state, labels)
            .with_identity(identity),
    ];
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, 400.0);
    let collapsed_layout = MultiDiffEditor::new(
        bounds,
        &collapsed_item,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .measure_layout();
    let expanded_layout = MultiDiffEditor::new(
        bounds,
        &expanded_item,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .measure_layout();
    let collapsed_height = collapsed_layout.content_height();
    let expanded_height = expanded_layout.content_height();
    let now = Instant::now();
    let mut registry = AnimationRegistry::default();
    let collapsed_editor = MultiDiffEditor::new(
        bounds,
        &collapsed_item,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .with_measured_layout(&collapsed_layout);
    let mut initial_frame = UiFrame::<InteractionFrame>::at(Color::WHITE, now);
    initial_frame.with_animation_bindings(&mut registry, |context| {
        context.draw_component(&collapsed_editor);
    });
    assert_eq!(
        registry.value(identity.fold_animation_key()),
        Some(collapsed_height)
    );
    assert_eq!(section_height(&initial_frame), collapsed_height);

    let expanded_editor = MultiDiffEditor::new(
        bounds,
        &expanded_item,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .with_measured_layout(&expanded_layout);
    let mut transition_start_frame = UiFrame::<InteractionFrame>::at(Color::WHITE, now);
    transition_start_frame.with_animation_bindings(&mut registry, |context| {
        context.draw_component(&expanded_editor);
    });
    assert_eq!(section_height(&transition_start_frame), collapsed_height);

    let halfway = now + Duration::from_millis(70);
    registry.advance(halfway);
    let mut halfway_frame = UiFrame::<InteractionFrame>::at(Color::WHITE, halfway);
    halfway_frame.with_animation_bindings(&mut registry, |context| {
        context.draw_component(&expanded_editor);
    });
    let halfway_height = section_height(&halfway_frame);
    assert!(halfway_height > collapsed_height);
    assert!(halfway_height < expanded_height);
    assert_eq!(
        registry.value(identity.fold_animation_key()),
        Some(halfway_height)
    );
}

#[test]
fn large_multi_diff_binds_height_animation_only_for_visible_sections() {
    let item_count = 10_000;
    let document = document("old", "new");
    let names = (0..item_count)
        .map(|index| format!("file-{index}.rs"))
        .collect::<Vec<_>>();
    let items = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            MultiDiffEditorItem::new(
                name,
                &document,
                DiffEditorState::default(),
                DiffEditorLabels::new("base", "working"),
            )
            .with_identity(MultiDiffEditorItemIdentity::from_slot(index as u32 + 1))
        })
        .collect::<Vec<_>>();
    let layout = super::MultiDiffEditorLayout {
        sections: ash_ui_components::VirtualListLayout::variable(vec![100.0; item_count]),
        presentation: DiffEditorPresentation::Unified,
    };
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 120.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .with_measured_layout(&layout);
    let mut bindings = CountingAnimationBindings::default();
    let mut frame = UiFrame::<InteractionFrame>::at(Color::WHITE, Instant::now());

    frame.with_animation_bindings(&mut bindings, |context| {
        context.draw_component(&editor);
    });

    assert_eq!(bindings.bound, 2);
}

fn section_height(frame: &UiFrame<InteractionFrame>) -> f32 {
    frame
        .scene()
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "MultiDiffSection")
        .expect("multi-diff section should be inspectable")
        .height()
}

#[test]
fn paints_every_visible_file_as_its_own_diff_section() {
    let alpha = document("old alpha\n", "new alpha\n");
    let beta = document("old beta\n", "new beta\n");
    let items = [
        MultiDiffEditorItem::new(
            "alpha.rs",
            &alpha,
            DiffEditorState::default(),
            DiffEditorLabels::new("alpha base", "alpha working"),
        ),
        MultiDiffEditorItem::new(
            "beta.rs",
            &beta,
            DiffEditorState::default(),
            DiffEditorLabels::new("beta base", "beta working"),
        ),
    ];
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 640.0, 568.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    assert_eq!(editor.content_height(), 176.0);
    let text = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(text.contains(&"alpha.rs"));
    assert!(text.contains(&"alpha base"));
    assert!(text.contains(&"alpha working"));
    assert!(text.contains(&"beta.rs"));
    assert!(text.contains(&"beta base"));
    assert!(text.contains(&"beta working"));
}

#[test]
fn exposes_shared_scroll_metrics_for_the_multi_file_content() {
    let alpha = document("a", "b");
    let items = [MultiDiffEditorItem::new(
        "alpha.rs",
        &alpha,
        DiffEditorState::default(),
        DiffEditorLabels::new("base", "working"),
    )];
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 640.0, 80.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    );

    assert_eq!(editor.scroll_metrics().viewport().height, 80.0);
    assert_eq!(editor.scroll_metrics().content().height, 84.0);
}

#[test]
fn unified_sections_use_one_readable_column_without_revision_headers() {
    let alpha = document("same\nold\n", "same\nnew\n");
    let items = [MultiDiffEditorItem::new(
        "alpha.rs",
        &alpha,
        DiffEditorState::default(),
        DiffEditorLabels::new("HEAD", "Working Tree"),
    )];
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 120.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light_cards(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified);
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let text = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert_eq!(editor.content_height(), 110.0);
    assert!(text.contains(&"alpha.rs"));
    assert_eq!(text.iter().filter(|value| **value == "same").count(), 1);
    assert!(text.contains(&"old"));
    assert!(text.contains(&"new"));
    assert!(!text.contains(&"HEAD"));
    assert!(!text.contains(&"Working Tree"));
    assert!(scene.rects().iter().any(|rect| {
        rect.bounds() == Rect::from_xywh(8.0, 8.0, 304.0, 94.0)
            && rect.corner_radii() == CornerRadii::uniform(6.0)
    }));
}

#[test]
fn offscreen_sections_are_not_projected_into_the_scene() {
    let alpha = document("a", "b");
    let beta = document("c", "d");
    let items = [
        MultiDiffEditorItem::new(
            "alpha.rs",
            &alpha,
            DiffEditorState::default(),
            DiffEditorLabels::new("alpha base", "alpha working"),
        ),
        MultiDiffEditorItem::new(
            "beta.rs",
            &beta,
            DiffEditorState::default(),
            DiffEditorLabels::new("beta base", "beta working"),
        ),
    ];
    let mut state = ScrollState::default();
    let unscrolled = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 640.0, 80.0),
        &items,
        state,
        MultiDiffEditorStyle::light(),
    );
    state.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(92.0)),
        unscrolled.scroll_metrics(),
        ScrollAxis::Vertical,
    );
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 640.0, 80.0),
        &items,
        state,
        MultiDiffEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let text = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(!text.contains(&"alpha.rs"));
    assert!(text.contains(&"beta.rs"));
}

#[test]
fn large_visible_section_only_projects_rows_inside_the_outer_viewport() {
    let original = (0..1_000)
        .map(|line| format!("old line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let document = document(&original, &original);
    let items = [MultiDiffEditorItem::new(
        "large.rs",
        &document,
        DiffEditorState::default(),
        DiffEditorLabels::new("base", "working"),
    )];
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 640.0, 80.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    editor.paint(&mut scene);

    let text = scene
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(text.contains(&"large.rs"));
    assert!(!text.contains(&"old line 999"));
    assert!(text.len() < 20);
}

#[test]
fn exposes_visible_fold_controls_with_per_file_identity_and_card_geometry() {
    let original = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = original.replace("line 11", "changed 11");
    let document = document(&original, &modified);
    let items = [MultiDiffEditorItem::new(
        "alpha.rs",
        &document,
        DiffEditorState::default(),
        DiffEditorLabels::new("base", "working"),
    )];
    let editor = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 300.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light_cards(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified);

    let controls = editor.fold_controls();

    assert_eq!(controls.len(), 2);
    assert_eq!(controls[0].item_index(), 0);
    assert_eq!(controls[0].region_index(), 0);
    assert_eq!(controls[0].line_count(), 7);
    assert_eq!(
        controls[0].bounds(),
        Rect::from_xywh(9.0, 41.0, 302.0, 20.0)
    );
}

#[test]
fn measured_layout_reuses_section_metrics_for_scrolling_and_paint() {
    let original = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let modified = original.replace("line 11", "changed 11");
    let document = document(&original, &modified);
    let items = [MultiDiffEditorItem::new(
        "alpha.rs",
        &document,
        DiffEditorState::default(),
        DiffEditorLabels::new("base", "working"),
    )];
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, 120.0);
    let measured = MultiDiffEditor::new(
        bounds,
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light_cards(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .measure_layout();
    let reused = MultiDiffEditor::new(
        bounds,
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light_cards(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .with_measured_layout(&measured);
    let mut scene = UiScene::new(Color::WHITE);

    reused.paint(&mut scene);

    assert_eq!(reused.content_height(), measured.content_height());
    assert_eq!(
        reused.scroll_metrics().content().height,
        measured.content_height()
    );
    assert_eq!(reused.fold_controls().len(), 1);
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "line 8")
    );
}

#[test]
fn multi_diff_style_distinguishes_paint_changes_from_layout_changes() {
    let mut text_layout = zui::ui::TextInputLayoutEngine::new();
    let original_editor =
        crate::CodeEditorStyle::from_theme(ash_ui_theme::DEFAULT_UI_THEME, &mut text_layout)
            .unwrap();
    let original =
        MultiDiffEditorStyle::from_theme(ash_ui_theme::DEFAULT_UI_THEME, original_editor);
    let mut recolored_theme = ash_ui_theme::DEFAULT_UI_THEME;
    recolored_theme.diff_inserted_line = Color::rgb(10, 80, 30);
    recolored_theme.content_background = Color::rgb(20, 20, 20);
    let recolored_editor =
        crate::CodeEditorStyle::from_theme(recolored_theme, &mut text_layout).unwrap();
    let recolored = MultiDiffEditorStyle::from_theme(recolored_theme, recolored_editor);
    let larger_text =
        zui::ui::TextStyle::new(18.0, ash_ui_theme::DEFAULT_UI_THEME.editor_foreground)
            .with_family(zui::ui::FontFamily::Monospace)
            .with_line_height(28.0);
    let larger_editor = crate::CodeEditorStyle::from_theme_and_text_style(
        ash_ui_theme::DEFAULT_UI_THEME,
        larger_text,
        &mut text_layout,
    )
    .unwrap();
    let larger = MultiDiffEditorStyle::from_theme(ash_ui_theme::DEFAULT_UI_THEME, larger_editor);

    assert!(original.same_layout_as(&recolored));
    assert!(!original.same_layout_as(&larger));
}

#[test]
fn measured_layout_indexes_variable_section_heights_and_spacing() {
    let small = document("old", "new");
    let large_original = (0..40)
        .map(|line| format!("old line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let large_modified = (0..40)
        .map(|line| format!("new line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let large = document(&large_original, &large_modified);
    let items = [
        MultiDiffEditorItem::new(
            "small.rs",
            &small,
            DiffEditorState::default(),
            DiffEditorLabels::new("base", "working"),
        ),
        MultiDiffEditorItem::new(
            "large.rs",
            &large,
            DiffEditorState::default(),
            DiffEditorLabels::new("base", "working"),
        ),
    ];

    let measured = MultiDiffEditor::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 120.0),
        &items,
        ScrollState::default(),
        MultiDiffEditorStyle::light_cards(),
    )
    .with_diff_presentation(DiffEditorPresentation::Unified)
    .measure_layout();

    let small_height = measured.sections.item_extent(0).unwrap();
    let large_height = measured.sections.item_extent(1).unwrap();
    assert!(large_height > small_height);
    assert_eq!(
        measured.content_height(),
        8.0 + small_height + 8.0 + large_height + 8.0
    );
}

#[test]
fn measured_layout_splices_changed_file_sections_without_mutating_retained_clones() {
    let mut layout = super::MultiDiffEditorLayout {
        sections: ash_ui_components::VirtualListLayout::variable([40.0, 60.0, 80.0])
            .with_item_gap(8.0)
            .with_content_padding(ash_ui_components::ListContentPadding::symmetric(8.0)),
        presentation: DiffEditorPresentation::Unified,
    };
    let retained_clone = layout.clone();

    layout.splice_section_extents(1..2, [120.0, 140.0]);

    assert_eq!(layout.section_count(), 4);
    assert_eq!(layout.section_extent(0), Some(40.0));
    assert_eq!(layout.section_extent(1), Some(120.0));
    assert_eq!(layout.section_extent(2), Some(140.0));
    assert_eq!(layout.section_extent(3), Some(80.0));
    assert_eq!(retained_clone.section_count(), 3);
    assert_eq!(retained_clone.section_extent(1), Some(60.0));
}

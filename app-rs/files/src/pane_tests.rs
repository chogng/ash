use super::{EXPLORER_PANE, FilesPane, FilesPaneStyle};
use crate::{DirectoryEntry, FilesState};
use ash_ui_components::{ScrollViewStyle, ScrollbarStyle};
use zui::ui::{AccessibilityRole, DispatchInvalidation, InteractionFrame, UiDispatch, UiFrame};
use zui::ui::{Color, Component, Point, Rect, UiScene};

fn style() -> FilesPaneStyle {
    FilesPaneStyle {
        surface: Color::WHITE,
        selected_background: Color::rgb(232, 232, 232),
        hovered_background: Color::rgb(242, 242, 242),
        text: Color::rgb(38, 38, 41),
        text_muted: Color::rgb(126, 126, 132),
        scroll_view: ScrollViewStyle::new(ScrollbarStyle::new(
            Color::TRANSPARENT,
            Color::rgb(126, 126, 132),
        )),
    }
}

#[test]
fn large_file_tree_only_paints_and_registers_visible_rows() {
    let mut files = FilesState::default();
    files.refresh(
        (0..50)
            .map(|index| DirectoryEntry::file(format!("file-{index:03}.txt")))
            .collect(),
    );
    let dispatch = UiDispatch::default();
    let style = style();
    let pane = FilesPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 100.0),
        &files,
        zui::ui::ElementId::scoped(1, 23),
        &style,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);
    let scene = frame.scene();

    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    let list = nodes.iter().find(|node| node.id == EXPLORER_PANE).unwrap();
    let items = nodes
        .iter()
        .filter(|node| node.role == AccessibilityRole::TreeItem)
        .collect::<Vec<_>>();
    assert_eq!(list.parent, Some(zui::ui::ElementId::scoped(1, 23)));
    assert_eq!(list.role, AccessibilityRole::Tree);
    assert_eq!(items.len(), 5);
    assert!(items.iter().all(|item| item.parent == Some(EXPLORER_PANE)));
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "file-000.txt")
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .all(|block| block.text() != "file-049.txt")
    );
}

#[test]
fn expanded_directory_paints_an_indented_child_as_a_tree_item() {
    let mut files = FilesState::default();
    files.refresh(vec![DirectoryEntry::directory("src")]);
    let directory_id = files.tree_row(0).unwrap().entry().element_id();
    assert!(files.activate(directory_id).is_some());
    assert!(files.complete_directory_load(directory_id, vec![DirectoryEntry::file("lib.rs")]));

    let dispatch = UiDispatch::default();
    let style = style();
    let pane = FilesPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 100.0),
        &files,
        zui::ui::ElementId::scoped(1, 23),
        &style,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);
    let scene = frame.scene();
    let nodes = frame.interaction().accessibility_nodes(&dispatch);
    let child = nodes.iter().find(|node| node.label == "lib.rs").unwrap();

    assert_eq!(child.role, AccessibilityRole::TreeItem);
    assert_eq!(child.level, Some(2));
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "lib.rs")
    );
}

#[test]
fn file_tree_exposes_nested_component_inspection_nodes() {
    let mut files = FilesState::default();
    files.refresh(vec![DirectoryEntry::directory("src")]);
    let dispatch = UiDispatch::default();
    let style = style();
    let pane = FilesPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 100.0),
        &files,
        zui::ui::ElementId::scoped(1, 23),
        &style,
        &dispatch,
    );
    let mut scene = UiScene::new(Color::WHITE);

    scene.draw_component(&pane);

    let names = scene
        .inspection()
        .nodes()
        .iter()
        .map(|node| node.name())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "FilesPane",
            "FilesTree",
            "ScrollView",
            "FilesTreeItem",
            "FilesTreeDisclosure",
            "IconLabel",
        ]
    );

    let row = scene
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "FilesTreeItem")
        .expect("tree item inspection node");
    assert_eq!(row.label(), Some("src"));
    let ancestry = scene
        .inspection()
        .ancestry(row.id())
        .into_iter()
        .map(|node| node.name())
        .collect::<Vec<_>>();
    assert_eq!(
        ancestry,
        vec!["FilesPane", "FilesTree", "ScrollView", "FilesTreeItem"]
    );

    let label = scene
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "IconLabel")
        .expect("file icon label inspection node");
    assert_eq!(label.label(), Some("src"));
}

#[test]
fn shared_file_tree_composition_joins_inspection_and_interaction_by_element_id() {
    let mut files = FilesState::default();
    files.refresh(vec![DirectoryEntry::directory("src")]);
    let dispatch = UiDispatch::default();
    let style = style();
    let pane = FilesPane::new(
        Rect::from_xywh(0.0, 0.0, 320.0, 100.0),
        &files,
        zui::ui::ElementId::scoped(1, 23),
        &style,
        &dispatch,
    );
    let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
    frame.draw_component(&pane);
    let scene = frame.scene();

    let row = scene
        .inspection()
        .nodes()
        .iter()
        .find(|node| node.name() == "FilesTreeItem")
        .expect("tree item inspection node");
    let row_id = row.element_id().expect("tree item element identity");
    let interaction = frame
        .interaction()
        .accessibility_nodes(&dispatch)
        .into_iter()
        .find(|node| node.id == row_id)
        .expect("tree item interaction node");

    assert_eq!(row.bounds(), interaction.bounds);
    assert_eq!(row.label(), Some(interaction.label.as_str()));
    assert_eq!(row.element_id(), Some(row_id));
    assert_eq!(frame.interaction().ancestry(row_id).last(), Some(&row_id));
    assert_eq!(
        scene
            .inspection()
            .ancestry(row.id())
            .first()
            .and_then(|node| node.element_id()),
        Some(EXPLORER_PANE)
    );
}

#[test]
fn hovering_an_unselected_file_row_paints_the_hover_background() {
    let mut files = FilesState::default();
    files.refresh(vec![
        DirectoryEntry::file("alpha.txt"),
        DirectoryEntry::file("beta.txt"),
    ]);
    let style = style();
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, 100.0);
    let mut dispatch = UiDispatch::default();
    let (row_id, row_bounds, point, frame) = {
        let pane = FilesPane::new(
            bounds,
            &files,
            zui::ui::ElementId::scoped(1, 23),
            &style,
            &dispatch,
        );
        let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
        frame.draw_component(&pane);
        let row = frame
            .interaction()
            .accessibility_nodes(&dispatch)
            .into_iter()
            .find(|node| node.label == "beta.txt")
            .expect("file row should be registered");
        let point = Point::new(
            row.bounds.origin.x + row.bounds.size.width * 0.5,
            row.bounds.origin.y + row.bounds.size.height * 0.5,
        );
        (row.id, row.bounds, point, frame)
    };

    let outcome = dispatch.pointer_moved(point, frame.interaction());

    assert_eq!(outcome.invalidation, DispatchInvalidation::Paint);
    assert!(dispatch.is_hovered(row_id));
    let pane = FilesPane::new(
        bounds,
        &files,
        zui::ui::ElementId::scoped(1, 23),
        &style,
        &dispatch,
    );
    let mut scene = UiScene::new(Color::WHITE);
    pane.paint(&mut scene);

    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| { rect.bounds() == row_bounds && rect.fill() == style.hovered_background })
    );
}

#[test]
fn hovering_a_selected_file_row_keeps_the_selected_background() {
    let mut files = FilesState::default();
    files.refresh(vec![DirectoryEntry::file("alpha.txt")]);
    let selected = files.tree_row(0).unwrap().entry().element_id();
    assert!(files.activate(selected).is_some());
    let style = style();
    let bounds = Rect::from_xywh(0.0, 0.0, 320.0, 100.0);
    let mut dispatch = UiDispatch::default();
    let (row_bounds, point, frame) = {
        let pane = FilesPane::new(
            bounds,
            &files,
            zui::ui::ElementId::scoped(1, 23),
            &style,
            &dispatch,
        );
        let mut frame = UiFrame::<InteractionFrame>::new(Color::WHITE);
        frame.draw_component(&pane);
        let row = frame
            .interaction()
            .accessibility_nodes(&dispatch)
            .into_iter()
            .find(|node| node.id == selected)
            .expect("selected file row should be registered");
        let point = Point::new(
            row.bounds.origin.x + row.bounds.size.width * 0.5,
            row.bounds.origin.y + row.bounds.size.height * 0.5,
        );
        (row.bounds, point, frame)
    };

    dispatch.pointer_moved(point, frame.interaction());
    let pane = FilesPane::new(
        bounds,
        &files,
        zui::ui::ElementId::scoped(1, 23),
        &style,
        &dispatch,
    );
    let mut scene = UiScene::new(Color::WHITE);
    pane.paint(&mut scene);

    assert!(
        scene.rects().iter().any(|rect| {
            rect.bounds() == row_bounds && rect.fill() == style.selected_background
        })
    );
    assert!(
        !scene
            .rects()
            .iter()
            .any(|rect| { rect.bounds() == row_bounds && rect.fill() == style.hovered_background })
    );
}

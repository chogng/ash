use super::AlignItems;
use super::Element;
use super::ElementLength;
use super::ElementStyleErrorKind;
use super::ElementStyleProperty;
use super::JustifyContent;
use crate::CornerRadii;
use crate::Edges;
use crate::Rect;
use crate::Size;

#[test]
fn row_resolves_padding_fixed_fill_children_and_exact_gap_regions() {
    let layout = Element::row("Toolbar")
        .padding(Edges::new(2.0, 3.0, 4.0, 5.0))
        .gap(6.0)
        .corner_radii(CornerRadii::uniform(8.0))
        .child(
            Element::row("Fixed")
                .width(ElementLength::px(20.0))
                .height(ElementLength::px(10.0)),
        )
        .child(Element::row("Fill").height(ElementLength::px(12.0)))
        .in_bounds(Rect::from_xywh(10.0, 20.0, 100.0, 30.0))
        .compute();

    assert_eq!(
        layout.children()[0].bounds(),
        Rect::from_xywh(15.0, 22.0, 20.0, 10.0)
    );
    assert_eq!(
        layout.children()[1].bounds(),
        Rect::from_xywh(41.0, 22.0, 66.0, 12.0)
    );
    assert_eq!(
        layout.gap_regions(),
        &[Rect::from_xywh(35.0, 22.0, 6.0, 24.0)]
    );
}

#[test]
fn column_clips_children_and_gap_regions_to_the_available_bounds() {
    let layout = Element::column("List")
        .gap(6.0)
        .children([
            Element::row("One").height(ElementLength::px(20.0)),
            Element::row("Two").height(ElementLength::px(20.0)),
            Element::row("Three").height(ElementLength::px(20.0)),
        ])
        .in_bounds(Rect::from_xywh(0.0, 0.0, 40.0, 45.0))
        .compute();

    assert_eq!(
        layout.children()[0].bounds(),
        Rect::from_xywh(0.0, 0.0, 40.0, 20.0)
    );
    assert_eq!(
        layout.children()[1].bounds(),
        Rect::from_xywh(0.0, 26.0, 40.0, 19.0)
    );
    assert!(layout.children()[2].bounds().is_empty());
    assert_eq!(
        layout.gap_regions(),
        &[Rect::from_xywh(0.0, 20.0, 40.0, 6.0)]
    );
}

#[test]
fn row_centers_content_sized_children_on_both_axes() {
    let layout = Element::row("ButtonContent")
        .gap(6.0)
        .justify_content(JustifyContent::Center)
        .align_items(AlignItems::Center)
        .child(
            Element::leaf("Icon")
                .width(ElementLength::px(14.0))
                .height(ElementLength::px(14.0)),
        )
        .child(
            Element::leaf("Label")
                .width(ElementLength::Content)
                .height(ElementLength::Content)
                .content_size(Size::new(30.0, 18.0)),
        )
        .in_bounds(Rect::from_xywh(10.0, 5.0, 100.0, 30.0))
        .compute();

    assert_eq!(
        layout.children()[0].bounds(),
        Rect::from_xywh(35.0, 13.0, 14.0, 14.0)
    );
    assert_eq!(
        layout.children()[1].bounds(),
        Rect::from_xywh(55.0, 11.0, 30.0, 18.0)
    );
    assert_eq!(
        layout.gap_regions(),
        &[Rect::from_xywh(49.0, 5.0, 6.0, 30.0)]
    );
}

#[test]
fn content_sized_container_derives_its_natural_size_from_children() {
    let layout = Element::row("Outer")
        .justify_content(JustifyContent::Center)
        .align_items(AlignItems::Center)
        .child(
            Element::row("Content")
                .width(ElementLength::Content)
                .height(ElementLength::Content)
                .gap(4.0)
                .child(
                    Element::leaf("Icon")
                        .width(ElementLength::px(10.0))
                        .height(ElementLength::px(8.0)),
                )
                .child(
                    Element::leaf("Label")
                        .width(ElementLength::Content)
                        .height(ElementLength::Content)
                        .content_size(Size::new(20.0, 12.0)),
                ),
        )
        .in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 30.0))
        .compute();

    let content = layout.children()[0].bounds();
    assert_eq!(content, Rect::from_xywh(33.0, 9.0, 34.0, 12.0));
    assert_eq!(
        layout.children()[0].children()[1].bounds(),
        Rect::from_xywh(47.0, 9.0, 20.0, 12.0)
    );
}

#[test]
fn space_between_distributes_free_space_and_cross_axis_end_alignment() {
    let layout = Element::row("Actions")
        .gap(4.0)
        .justify_content(JustifyContent::SpaceBetween)
        .align_items(AlignItems::End)
        .children([
            Element::leaf("First")
                .width(ElementLength::px(10.0))
                .height(ElementLength::px(8.0)),
            Element::leaf("Second")
                .width(ElementLength::px(10.0))
                .height(ElementLength::px(12.0)),
        ])
        .in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 30.0))
        .compute();

    assert_eq!(
        layout.children()[0].bounds(),
        Rect::from_xywh(0.0, 22.0, 10.0, 8.0)
    );
    assert_eq!(
        layout.children()[1].bounds(),
        Rect::from_xywh(90.0, 18.0, 10.0, 12.0)
    );
    assert_eq!(
        layout.gap_regions(),
        &[Rect::from_xywh(10.0, 0.0, 80.0, 30.0)]
    );
}

#[test]
fn validation_reports_nested_path_property_and_source_before_layout() {
    let element = Element::column("Settings")
        .child(Element::row("Search").gap(-1.0))
        .in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 80.0));

    let error = element.try_compute().unwrap_err();

    assert_eq!(error.path(), &["Settings", "Search"]);
    assert_eq!(error.property(), ElementStyleProperty::Gap);
    assert_eq!(error.kind(), ElementStyleErrorKind::Negative);
    assert!(error.source_file().ends_with("element_tests.rs"));
    assert!(error.to_string().contains("Settings/Search.gap"));
}

#[test]
fn validation_rejects_non_finite_root_bounds() {
    let element = Element::leaf("Panel").in_bounds(Rect::from_xywh(f32::NAN, 0.0, 100.0, 80.0));

    let error = element.try_compute().unwrap_err();

    assert_eq!(error.path(), &["Panel"]);
    assert_eq!(error.property(), ElementStyleProperty::Bounds);
    assert_eq!(error.kind(), ElementStyleErrorKind::NonFinite);
}

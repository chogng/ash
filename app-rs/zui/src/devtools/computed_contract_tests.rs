use super::COMPUTED_SECTIONS;
use super::ComputedFieldId;
use super::computed_values;
use crate::ui::CornerRadii;
use crate::ui::Edges;
use crate::ui::InspectionNode;
use crate::ui::Rect;

#[test]
fn computed_sections_define_a_stable_field_table() {
    assert_eq!(
        COMPUTED_SECTIONS
            .iter()
            .map(|section| section.label)
            .collect::<Vec<_>>(),
        vec!["Layout", "Box model", "Flow", "Appearance", "Source"]
    );
    assert_eq!(
        COMPUTED_SECTIONS
            .iter()
            .flat_map(|section| section.fields.iter().map(|field| field.label))
            .collect::<Vec<_>>(),
        vec![
            "size",
            "position",
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
            "gap",
            "radius-top-left",
            "radius-top-right",
            "radius-bottom-right",
            "radius-bottom-left",
            "location",
        ]
    );
}

#[test]
fn computed_values_use_resolved_inspection_geometry() {
    let node = InspectionNode::new("Button", Rect::from_xywh(2.0, 3.0, 20.0, 10.0))
        .with_padding(Edges::new(1.0, 2.0, 3.0, 4.0))
        .with_gap(6.0)
        .with_corner_radii(CornerRadii::new(1.0, 2.0, 3.0, 4.0))
        .with_source_location("components/button.rs", 42);
    let values = computed_values(&node);
    let value = |id| {
        values
            .iter()
            .find(|field| field.id == id)
            .map(|field| field.text.as_str())
    };

    assert_eq!(value(ComputedFieldId::Size), Some("20 × 10"));
    assert_eq!(value(ComputedFieldId::Position), Some("2, 3"));
    assert_eq!(value(ComputedFieldId::PaddingTop), Some("1"));
    assert_eq!(value(ComputedFieldId::PaddingLeft), Some("4"));
    assert_eq!(value(ComputedFieldId::Gap), Some("6"));
    assert_eq!(value(ComputedFieldId::RadiusBottomLeft), Some("4"));
    assert_eq!(
        value(ComputedFieldId::Source),
        Some("button.rs:42  ·  layer 0")
    );
}

use crate::ui::InspectionNode;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ComputedFieldId {
    Size,
    Position,
    PaddingTop,
    PaddingRight,
    PaddingBottom,
    PaddingLeft,
    Gap,
    RadiusTopLeft,
    RadiusTopRight,
    RadiusBottomRight,
    RadiusBottomLeft,
    Source,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ComputedFieldSpec {
    pub(crate) id: ComputedFieldId,
    pub(crate) label: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ComputedSectionSpec {
    pub(crate) label: &'static str,
    pub(crate) fields: &'static [ComputedFieldSpec],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ComputedFieldValue {
    pub(crate) id: ComputedFieldId,
    pub(crate) text: String,
}

const LAYOUT_FIELDS: &[ComputedFieldSpec] = &[
    ComputedFieldSpec {
        id: ComputedFieldId::Size,
        label: "size",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::Position,
        label: "position",
    },
];

const BOX_MODEL_FIELDS: &[ComputedFieldSpec] = &[
    ComputedFieldSpec {
        id: ComputedFieldId::PaddingTop,
        label: "padding-top",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::PaddingRight,
        label: "padding-right",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::PaddingBottom,
        label: "padding-bottom",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::PaddingLeft,
        label: "padding-left",
    },
];

const FLOW_FIELDS: &[ComputedFieldSpec] = &[ComputedFieldSpec {
    id: ComputedFieldId::Gap,
    label: "gap",
}];

const APPEARANCE_FIELDS: &[ComputedFieldSpec] = &[
    ComputedFieldSpec {
        id: ComputedFieldId::RadiusTopLeft,
        label: "radius-top-left",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::RadiusTopRight,
        label: "radius-top-right",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::RadiusBottomRight,
        label: "radius-bottom-right",
    },
    ComputedFieldSpec {
        id: ComputedFieldId::RadiusBottomLeft,
        label: "radius-bottom-left",
    },
];

const SOURCE_FIELDS: &[ComputedFieldSpec] = &[ComputedFieldSpec {
    id: ComputedFieldId::Source,
    label: "location",
}];

pub(crate) const COMPUTED_SECTIONS: &[ComputedSectionSpec] = &[
    ComputedSectionSpec {
        label: "Layout",
        fields: LAYOUT_FIELDS,
    },
    ComputedSectionSpec {
        label: "Box model",
        fields: BOX_MODEL_FIELDS,
    },
    ComputedSectionSpec {
        label: "Flow",
        fields: FLOW_FIELDS,
    },
    ComputedSectionSpec {
        label: "Appearance",
        fields: APPEARANCE_FIELDS,
    },
    ComputedSectionSpec {
        label: "Source",
        fields: SOURCE_FIELDS,
    },
];

pub(crate) fn computed_values(node: &InspectionNode) -> Vec<ComputedFieldValue> {
    let bounds = node.bounds();
    let padding = node.padding().unwrap_or_default();
    let radii = node.corner_radii().unwrap_or_default();

    vec![
        ComputedFieldValue {
            id: ComputedFieldId::Size,
            text: format!("{:.0} × {:.0}", bounds.size.width, bounds.size.height),
        },
        ComputedFieldValue {
            id: ComputedFieldId::Position,
            text: format!("{:.0}, {:.0}", bounds.origin.x, bounds.origin.y),
        },
        ComputedFieldValue {
            id: ComputedFieldId::PaddingTop,
            text: format!("{:.0}", padding.top),
        },
        ComputedFieldValue {
            id: ComputedFieldId::PaddingRight,
            text: format!("{:.0}", padding.right),
        },
        ComputedFieldValue {
            id: ComputedFieldId::PaddingBottom,
            text: format!("{:.0}", padding.bottom),
        },
        ComputedFieldValue {
            id: ComputedFieldId::PaddingLeft,
            text: format!("{:.0}", padding.left),
        },
        ComputedFieldValue {
            id: ComputedFieldId::Gap,
            text: format!("{:.0}", node.gap().unwrap_or(0.0)),
        },
        ComputedFieldValue {
            id: ComputedFieldId::RadiusTopLeft,
            text: format!("{:.0}", radii.top_left),
        },
        ComputedFieldValue {
            id: ComputedFieldId::RadiusTopRight,
            text: format!("{:.0}", radii.top_right),
        },
        ComputedFieldValue {
            id: ComputedFieldId::RadiusBottomRight,
            text: format!("{:.0}", radii.bottom_right),
        },
        ComputedFieldValue {
            id: ComputedFieldId::RadiusBottomLeft,
            text: format!("{:.0}", radii.bottom_left),
        },
        ComputedFieldValue {
            id: ComputedFieldId::Source,
            text: source(node),
        },
    ]
}

fn source(node: &InspectionNode) -> String {
    if node.source_file().is_empty() || node.source_line() == 0 {
        return "source unavailable".to_owned();
    }
    let file = node
        .source_file()
        .rsplit('/')
        .next()
        .unwrap_or(node.source_file());
    format!("{file}:{}  ·  layer {}", node.source_line(), node.layer())
}

#[cfg(test)]
#[path = "computed_contract_tests.rs"]
mod tests;

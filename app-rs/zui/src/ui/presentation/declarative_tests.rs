use crate::ui::AlignItems;
use crate::ui::Border;
use crate::ui::Color;
use crate::ui::CornerRadii;
use crate::ui::Edges;
use crate::ui::ElementDirection;
use crate::ui::ElementLength;
use crate::ui::ElementOverflow;
use crate::ui::ElementStyle;
use crate::ui::JustifyContent;
use crate::ui::Rect;

const PANEL_STYLE: ElementStyle = crate::style! {
    column {
        width: fill;
        height: 120;
        padding: [8, 12];
        gap: 6;
        justify: center;
        align: end;
        background: Color::WHITE;
        border: Border::uniform(1.0, Color::rgb(0, 0, 0));
        radius: 10;
        overflow: clip;
    }
};

#[test]
fn style_macro_builds_a_const_typed_style() {
    assert_eq!(PANEL_STYLE.direction(), ElementDirection::Vertical);
    assert_eq!(PANEL_STYLE.width(), ElementLength::Fill);
    assert_eq!(PANEL_STYLE.height(), ElementLength::px(120.0));
    assert_eq!(
        PANEL_STYLE.padding(),
        Some(Edges::new(8.0, 12.0, 8.0, 12.0))
    );
    assert_eq!(PANEL_STYLE.gap(), Some(6.0));
    assert_eq!(PANEL_STYLE.justify_content(), JustifyContent::Center);
    assert_eq!(PANEL_STYLE.align_items(), AlignItems::End);
    assert_eq!(PANEL_STYLE.background(), Some(Color::WHITE));
    assert_eq!(
        PANEL_STYLE.border(),
        Some(Border::uniform(1.0, Color::rgb(0, 0, 0)))
    );
    assert_eq!(PANEL_STYLE.corner_radii(), Some(CornerRadii::uniform(10.0)));
    assert_eq!(PANEL_STYLE.overflow(), ElementOverflow::Clip);
}

#[test]
fn ui_macro_builds_static_and_dynamic_children() {
    let dynamic = [crate::ui! {
        leaf("Dynamic") {
            style {
                height: 12;
            }
            content_size: [20, 12];
        }
    }];
    let root = crate::ui! {
        column("Panel") {
            style: PANEL_STYLE;

            child row("Header") {
                style {
                    height: 20;
                    align: center;
                }
            }

            children: dynamic;
        }
    };

    let computed = root
        .in_bounds(Rect::from_xywh(0.0, 0.0, 100.0, 120.0))
        .compute();

    assert_eq!(computed.children().len(), 2);
    assert_eq!(computed.children()[0].name(), "Header");
    assert_eq!(computed.children()[1].name(), "Dynamic");
    assert_eq!(computed.children()[0].bounds().size.height, 20.0);
    assert_eq!(computed.children()[1].bounds().size.height, 12.0);
}

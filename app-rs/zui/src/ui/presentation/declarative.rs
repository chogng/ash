/// Builds a reusable typed [`crate::ui::ElementStyle`] without a runtime parser.
#[macro_export]
macro_rules! style {
    (leaf { $($properties:tt)* }) => {
        $crate::__zui_style_properties!($crate::ui::ElementStyle::leaf(); $($properties)*)
    };
    (row { $($properties:tt)* }) => {
        $crate::__zui_style_properties!($crate::ui::ElementStyle::row(); $($properties)*)
    };
    (column { $($properties:tt)* }) => {
        $crate::__zui_style_properties!($crate::ui::ElementStyle::column(); $($properties)*)
    };
    ($($invalid:tt)*) => {
        compile_error!("style! expects leaf, row, or column followed by a property block")
    };
}

/// Builds a declarative [`crate::ui::Element`] tree from typed styles and child nodes.
#[macro_export]
macro_rules! ui {
    (leaf($name:expr) { style { $($properties:tt)* } $($body:tt)* }) => {
        $crate::__zui_ui_leaf!(
            $crate::ui::Element::leaf_with_style(
                $name,
                $crate::style! { leaf { $($properties)* } },
            );
            $($body)*
        )
    };
    (leaf($name:expr) { style: $style:expr; $($body:tt)* }) => {
        $crate::__zui_ui_leaf!(
            $crate::ui::Element::leaf_with_style($name, $style);
            $($body)*
        )
    };
    (leaf($name:expr) { $($body:tt)* }) => {
        $crate::__zui_ui_leaf!($crate::ui::Element::leaf($name); $($body)*)
    };
    (row($name:expr) { style { $($properties:tt)* } $($body:tt)* }) => {
        $crate::__zui_ui_children!(
            $crate::ui::Element::row_with_style(
                $name,
                $crate::style! { row { $($properties)* } },
            );
            $($body)*
        )
    };
    (row($name:expr) { style: $style:expr; $($body:tt)* }) => {
        $crate::__zui_ui_children!(
            $crate::ui::Element::row_with_style($name, $style);
            $($body)*
        )
    };
    (row($name:expr) { $($body:tt)* }) => {
        $crate::__zui_ui_children!($crate::ui::Element::row($name); $($body)*)
    };
    (column($name:expr) { style { $($properties:tt)* } $($body:tt)* }) => {
        $crate::__zui_ui_children!(
            $crate::ui::Element::column_with_style(
                $name,
                $crate::style! { column { $($properties)* } },
            );
            $($body)*
        )
    };
    (column($name:expr) { style: $style:expr; $($body:tt)* }) => {
        $crate::__zui_ui_children!(
            $crate::ui::Element::column_with_style($name, $style);
            $($body)*
        )
    };
    (column($name:expr) { $($body:tt)* }) => {
        $crate::__zui_ui_children!($crate::ui::Element::column($name); $($body)*)
    };
    ($($invalid:tt)*) => {
        compile_error!("ui! expects leaf(...), row(...), or column(...)")
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __zui_style_properties {
    ($style:expr;) => { $style };

    ($style:expr; width: fill; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_width($crate::ui::ElementLength::Fill); $($rest)*)
    };
    ($style:expr; width: content; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_width($crate::ui::ElementLength::Content); $($rest)*)
    };
    ($style:expr; width: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_width($crate::ui::ElementLength::px(($value) as f32)); $($rest)*)
    };
    ($style:expr; height: fill; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_height($crate::ui::ElementLength::Fill); $($rest)*)
    };
    ($style:expr; height: content; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_height($crate::ui::ElementLength::Content); $($rest)*)
    };
    ($style:expr; height: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_height($crate::ui::ElementLength::px(($value) as f32)); $($rest)*)
    };

    ($style:expr; justify: start; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_justify_content($crate::ui::JustifyContent::Start); $($rest)*)
    };
    ($style:expr; justify: center; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_justify_content($crate::ui::JustifyContent::Center); $($rest)*)
    };
    ($style:expr; justify: end; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_justify_content($crate::ui::JustifyContent::End); $($rest)*)
    };
    ($style:expr; justify: space_between; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_justify_content($crate::ui::JustifyContent::SpaceBetween); $($rest)*)
    };
    ($style:expr; align: start; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_align_items($crate::ui::AlignItems::Start); $($rest)*)
    };
    ($style:expr; align: center; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_align_items($crate::ui::AlignItems::Center); $($rest)*)
    };
    ($style:expr; align: end; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_align_items($crate::ui::AlignItems::End); $($rest)*)
    };

    ($style:expr; padding: [$top:expr, $right:expr, $bottom:expr, $left:expr]; $($rest:tt)*) => {
        $crate::__zui_style_properties!(
            $style.with_padding($crate::ui::Edges::new(
                ($top) as f32,
                ($right) as f32,
                ($bottom) as f32,
                ($left) as f32,
            ));
            $($rest)*
        )
    };
    ($style:expr; padding: [$vertical:expr, $horizontal:expr]; $($rest:tt)*) => {
        $crate::__zui_style_properties!(
            $style.with_padding($crate::ui::Edges::new(
                ($vertical) as f32,
                ($horizontal) as f32,
                ($vertical) as f32,
                ($horizontal) as f32,
            ));
            $($rest)*
        )
    };
    ($style:expr; padding: [$value:expr]; $($rest:tt)*) => {
        $crate::__zui_style_properties!(
            $style.with_padding($crate::ui::Edges::uniform(($value) as f32));
            $($rest)*
        )
    };
    ($style:expr; padding: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_padding($value); $($rest)*)
    };
    ($style:expr; gap: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_gap(($value) as f32); $($rest)*)
    };
    ($style:expr; radius: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!(
            $style.with_corner_radii($crate::ui::CornerRadii::uniform(($value) as f32));
            $($rest)*
        )
    };
    ($style:expr; radii: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_corner_radii($value); $($rest)*)
    };
    ($style:expr; background: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_background($value); $($rest)*)
    };
    ($style:expr; border: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_border($value); $($rest)*)
    };
    ($style:expr; shadow: $value:expr; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_shadow($value); $($rest)*)
    };
    ($style:expr; overflow: visible; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_overflow($crate::ui::ElementOverflow::Visible); $($rest)*)
    };
    ($style:expr; overflow: clip; $($rest:tt)*) => {
        $crate::__zui_style_properties!($style.with_overflow($crate::ui::ElementOverflow::Clip); $($rest)*)
    };
    ($style:expr; $property:ident: $value:expr; $($rest:tt)*) => {
        compile_error!(concat!("unsupported ZUI style property: ", stringify!($property)))
    };
    ($style:expr; $($invalid:tt)+) => {
        compile_error!("invalid ZUI style syntax; every property must end with a semicolon")
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __zui_ui_children {
    ($element:expr;) => { $element };
    ($element:expr; content_size: [$width:expr, $height:expr]; $($rest:tt)*) => {
        $crate::__zui_ui_children!(
            $element.content_size($crate::ui::Size::new(($width) as f32, ($height) as f32));
            $($rest)*
        )
    };
    ($element:expr; child $kind:ident($name:expr) { $($body:tt)* }; $($rest:tt)*) => {
        $crate::__zui_ui_children!(
            $element.child($crate::ui! { $kind($name) { $($body)* } });
            $($rest)*
        )
    };
    ($element:expr; child $kind:ident($name:expr) { $($body:tt)* } $($rest:tt)*) => {
        $crate::__zui_ui_children!(
            $element.child($crate::ui! { $kind($name) { $($body)* } });
            $($rest)*
        )
    };
    ($element:expr; children: $children:expr; $($rest:tt)*) => {
        $crate::__zui_ui_children!($element.children($children); $($rest)*)
    };
    ($element:expr; $property:ident: $value:expr; $($rest:tt)*) => {
        compile_error!(concat!("unsupported ZUI element property: ", stringify!($property)))
    };
    ($element:expr; $($invalid:tt)+) => {
        compile_error!("invalid ui! child syntax")
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __zui_ui_leaf {
    ($element:expr;) => { $element };
    ($element:expr; content_size: [$width:expr, $height:expr]; $($rest:tt)*) => {
        $crate::__zui_ui_leaf!(
            $element.content_size($crate::ui::Size::new(($width) as f32, ($height) as f32));
            $($rest)*
        )
    };
    ($element:expr; child $($invalid:tt)*) => {
        compile_error!("leaf nodes cannot declare child nodes")
    };
    ($element:expr; children: $($invalid:tt)*) => {
        compile_error!("leaf nodes cannot declare child collections")
    };
    ($element:expr; $property:ident: $value:expr; $($rest:tt)*) => {
        compile_error!(concat!("unsupported ZUI leaf property: ", stringify!($property)))
    };
    ($element:expr; $($invalid:tt)+) => {
        compile_error!("invalid ui! leaf syntax")
    };
}

#[cfg(test)]
#[path = "declarative_tests.rs"]
mod tests;

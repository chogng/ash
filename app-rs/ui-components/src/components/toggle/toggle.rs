use crate::Rect;
use crate::Size;

#[path = "checkbox.rs"]
mod checkbox;
#[path = "switch.rs"]
mod switch;

pub use checkbox::Checkbox;
pub use checkbox::CheckboxColors;
pub use checkbox::CheckboxSelection;
pub use checkbox::CheckboxStateColors;
pub use checkbox::CheckboxStyle;
pub use switch::Switch;
pub use switch::SwitchColors;
pub use switch::SwitchSelection;
pub use switch::SwitchStateColors;
pub use switch::SwitchStyle;

/// Shared pointer and focus state for toggle-family controls.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ToggleState {
    #[default]
    Resting,
    Hovered,
    Focused,
    Pressed,
    Disabled,
}

pub(super) fn centered_bounds(bounds: Rect, size: Size) -> Rect {
    let bounds_width = bounds.size.width.max(0.0);
    let bounds_height = bounds.size.height.max(0.0);
    let width = size.width.max(0.0).min(bounds_width);
    let height = size.height.max(0.0).min(bounds_height);
    Rect::from_xywh(
        bounds.origin.x + (bounds_width - width) * 0.5,
        bounds.origin.y + (bounds_height - height) * 0.5,
        width,
        height,
    )
}

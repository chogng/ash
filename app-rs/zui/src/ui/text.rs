//! Text values, shaping, and single-line editing primitives.

mod font;
mod input;
mod layout;
mod style;

pub use font::FontCatalog;
pub use font::FontCatalogError;
pub(crate) use font::mapping;
pub(crate) use font::new_font_system;
pub use input::CaretBlinkAdvance;
pub use input::CaretBlinkController;
pub use input::CaretVisibility;
pub use input::TextInput;
pub use input::TextInputCommand;
pub use input::TextInputCompositionCursor;
pub use input::TextInputCompositionEvent;
pub use input::TextInputLayout;
pub use input::TextInputLayoutEngine;
pub use input::TextInputLayoutStyle;
pub use input::TextInputSelectionMode;
pub use layout::TextLayout;
pub use layout::TextLayoutEngine;
pub use layout::TextLayoutWidth;
pub use style::FontFamily;
pub use style::FontStyle;
pub use style::FontWeight;
pub use style::TextSpan;
pub use style::TextStyle;

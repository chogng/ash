//! Built-in artwork used by the framework-owned DevTools view.

use crate::ui::Icon;
use crate::ui::IconDefinition;
use crate::ui::IconId;

/// Cursor used by the Inspector's Pick action.
pub(crate) const PICK: Icon = Icon::new(
    IconId::new("zui-devtools-pick"),
    IconDefinition::symbolic(include_bytes!("assets/cursor.svg")),
);

/// Close glyph used by the Inspector toolbar.
pub(crate) const CLOSE: Icon = Icon::new(
    IconId::new("zui-devtools-close"),
    IconDefinition::symbolic(include_bytes!("assets/close.svg")),
);

/// Disclosure glyph used for one ancestor row in the Inspector path.
pub(crate) const ANCESTOR: Icon = Icon::new(
    IconId::new("zui-devtools-ancestor"),
    IconDefinition::symbolic(include_bytes!("assets/chevron-right.svg")),
);

/// Disclosure glyph used for an expanded branch in the Inspector tree.
pub(crate) const EXPANDED: Icon = Icon::new(
    IconId::new("zui-devtools-expanded"),
    IconDefinition::symbolic(include_bytes!("assets/chevron-down.svg")),
);

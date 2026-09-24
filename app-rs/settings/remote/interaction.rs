//! Host-provided parent identity used by Remote overlay components.

use zui::ui::ElementId;

/// Fallback root identity used by standalone component tests.
pub const REMOTE_UI_ROOT: ElementId = ElementId::scoped(1, 1);
